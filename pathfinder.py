import psycopg2
import pickle
import os
from collections import deque, defaultdict
from datetime import datetime

DB_CONFIG = {
    'dbname': 'mb_sdos_db',
    'user': 'tsabera',
    'password': '',
    'host': 'localhost',
    'port': 5432,
}

# Cache file paths
GRAPH_CACHE_FILE = 'data/processed/collaboration_graph.pkl'
ARTIST_CACHE_FILE = 'data/processed/artist_lookup.pkl'

def search_artists(conn, name, limit=10):
    """
    Optimized artist search with unified query and better performance.
    Returns list of tuples: (artist_id, artist_name, artist_gid, release_count)
    """
    with conn.cursor() as cur:
        # Single optimized query that handles all search types with ranking
        cur.execute("""
            WITH ranked_matches AS (
                -- Exact name matches (highest priority)
                SELECT DISTINCT a.id, a.name, a.gid, 
                       1 as match_priority,
                       CASE WHEN LOWER(a.name) = LOWER(%s) THEN 1 ELSE 0 END as exact_match
                FROM artist a
                WHERE LOWER(a.name) = LOWER(%s)
                
                UNION ALL
                
                -- Alias matches (medium priority)
                SELECT DISTINCT a.id, a.name, a.gid, 
                       2 as match_priority,
                       CASE WHEN LOWER(aa.name) = LOWER(%s) THEN 1 ELSE 0 END as exact_match
                FROM artist_alias aa
                JOIN artist a ON aa.artist = a.id
                WHERE LOWER(aa.name) = LOWER(%s)
                
                UNION ALL
                
                -- Fuzzy matches (lowest priority) - only if no exact matches found
                SELECT DISTINCT a.id, a.name, a.gid, 
                       3 as match_priority,
                       0 as exact_match
                FROM artist a
                WHERE LOWER(a.name) LIKE LOWER(%s)
                  AND LOWER(a.name) != LOWER(%s)  -- Exclude exact matches
                  AND NOT EXISTS (
                    -- Only include fuzzy if no exact matches found
                    SELECT 1 FROM artist a2 WHERE LOWER(a2.name) = LOWER(%s)
                    UNION ALL
                    SELECT 1 FROM artist_alias aa2 
                    JOIN artist a3 ON aa2.artist = a3.id 
                    WHERE LOWER(aa2.name) = LOWER(%s)
                  )
                LIMIT 50  -- Limit fuzzy matches to keep performance reasonable
            ),
            -- Get release counts only for the matched artists
            artist_stats AS (
                SELECT rm.id, rm.name, rm.gid, rm.match_priority, rm.exact_match,
                       COALESCE(COUNT(DISTINCT r.id), 0) AS release_count
                FROM ranked_matches rm
                LEFT JOIN artist_credit_name acn ON acn.artist = rm.id
                LEFT JOIN recording r ON acn.artist_credit = r.artist_credit
                GROUP BY rm.id, rm.name, rm.gid, rm.match_priority, rm.exact_match
            )
            SELECT id, name, gid, release_count
            FROM artist_stats
            ORDER BY match_priority, exact_match DESC, release_count DESC
            LIMIT %s
        """, (name, name, name, name, f'%{name}%', name, name, name, limit))
        
        return cur.fetchall()

def select_artist(conn, name):
    """
    Prompts user to select artist from a ranked list.
    Returns (artist_id, artist_name, search_time) or None.
    """
    search_start = datetime.now()
    matches = search_artists(conn, name)
    search_time = datetime.now() - search_start
    
    if not matches:
        return None

    if len(matches) == 1:
        artist_id, artist_name, gid, _ = matches[0]
        print(f"Selected artist: {artist_name} (MBID: {gid})")
        print(f"Artist search took {search_time.total_seconds():.3f} seconds")
        return (artist_id, artist_name, search_time)

    print(f"\nMultiple artists found for '{name}' (ranked by relevance and releases):")
    for i, (artist_id, artist_name, gid, release_count) in enumerate(matches, 1):
        print(f"{i}. {artist_name} (MBID: {gid}) - {release_count} releases")
    print(f"Artist search took {search_time.total_seconds():.3f} seconds")

    while True:
        choice = input(f"Enter the number of the correct artist (1-{len(matches)}): ").strip()
        if choice.isdigit():
            idx = int(choice)
            if 1 <= idx <= len(matches):
                artist_id, artist_name, gid, _ = matches[idx - 1]
                return (artist_id, artist_name, search_time)
        print("Invalid choice. Try again.")

def build_collaboration_graph(conn):
    """
    Build graph using only multi-artist recordings on releases with labels.
    Excludes recordings where the release artist is Various Artists or [unknown],
    excludes recordings with [no label], excludes any release_group that has any
    unwanted primary or secondary type (e.g., DJ-Mix), excludes recordings
    whose artist_credit contains a 'vs' join phrase, and excludes releases
    with unwanted statuses (e.g., bootlegs).
    """
    print("Building collaboration graph...")
    graph = defaultdict(list)
    edge_seen = set()

    unwanted_types = ['Compilation', 'DJ-mix', 'Audiobook', 'Audio drama', 'Field recording', 'Interview', 'Live']
    # normalize to lower-case for comparison
    unwanted_types_lower = [t.lower() for t in unwanted_types]
    
    # Define unwanted release statuses
    unwanted_statuses = ['Bootleg', 'Pseudo-Release']
    unwanted_statuses_lower = [s.lower() for s in unwanted_statuses]
    
    vs_pattern = '%vs%'
    bad_release_artists = ['various artists', '[unknown]']

    with conn.cursor() as cur:
        # Use server-side cursor for large result sets
        cur.itersize = 10000  # Fetch 10k rows at a time
        
        sql = """
            SELECT r.id AS recording_id,
                   r.name AS recording_name,
                   array_agg(acn.artist ORDER BY acn.position) AS artists
            FROM recording r
            JOIN artist_credit ac ON r.artist_credit = ac.id
            JOIN artist_credit_name acn ON ac.id = acn.artist_credit
            JOIN track t ON r.id = t.recording
            JOIN medium m ON t.medium = m.id
            JOIN release rel ON m.release = rel.id
            JOIN release_label rl ON rel.id = rl.release
            JOIN label l ON rl.label = l.id
            JOIN release_group rg ON rel.release_group = rg.id
            LEFT JOIN release_status rs ON rel.status = rs.id
            WHERE l.name IS NOT NULL
              AND LOWER(TRIM(l.name)) != '[no label]'
              -- exclude if release artist credit is Various Artists or [unknown]
              AND NOT EXISTS (
                SELECT 1
                FROM artist_credit_name rc
                WHERE rc.artist_credit = rel.artist_credit
                  AND LOWER(TRIM(rc.name)) = ANY(%s)
              )
              -- exclude if any secondary type on this release_group matches unwanted list
              AND NOT EXISTS (
                SELECT 1
                FROM release_group_secondary_type_join j
                JOIN release_group_secondary_type s ON j.secondary_type = s.id
                WHERE j.release_group = rg.id
                  AND LOWER(s.name) = ANY(%s)
              )
              -- exclude if primary type matches unwanted list
              AND NOT EXISTS (
                SELECT 1
                FROM release_group_primary_type p
                WHERE rg.type = p.id
                  AND LOWER(p.name) = ANY(%s)
              )
              -- exclude if the artist_credit for this recording contains a 'vs' join phrase
              AND NOT EXISTS (
                SELECT 1
                FROM artist_credit_name acn_check
                WHERE acn_check.artist_credit = r.artist_credit
                  AND acn_check.join_phrase ILIKE %s
              )
              -- exclude releases with unwanted statuses (bootlegs, pseudo-releases, etc.)
              AND (rs.name IS NULL OR LOWER(rs.name) != ALL(%s))
            GROUP BY r.id, r.name
            HAVING COUNT(DISTINCT acn.artist) > 1
        """
        
        cur.execute(sql, (bad_release_artists, unwanted_types_lower, unwanted_types_lower, vs_pattern, unwanted_statuses_lower))

        collaboration_count = 0
        processed_count = 0
        
        for rec_id, rec_name, artist_ids in cur:
            processed_count += 1
            if processed_count % 10000 == 0:
                print(f"Processed {processed_count} recordings, found {collaboration_count} collaborations so far...")
                
            # artist_ids is an array in credit order
            n = len(artist_ids)
            for i in range(n):
                for j in range(i + 1, n):
                    a1, a2 = artist_ids[i], artist_ids[j]
                    if a1 == a2:
                        continue
                    key = tuple(sorted((a1, a2)))
                    if key not in edge_seen:
                        graph[a1].append((a2, rec_name))
                        graph[a2].append((a1, rec_name))
                        edge_seen.add(key)
                        collaboration_count += 1

    print(f"Graph built with {len(graph)} artists and {collaboration_count} unique collaborations")
    return graph

def save_graph_to_cache(graph):
    """Save graph to pickle file for fast loading."""
    os.makedirs('data/processed', exist_ok=True)
    print("Saving graph to cache...")
    with open(GRAPH_CACHE_FILE, 'wb') as f:
        pickle.dump(graph, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"Graph saved to {GRAPH_CACHE_FILE}")

def load_graph_from_cache():
    """Load graph from pickle file."""
    if not os.path.exists(GRAPH_CACHE_FILE):
        return None
    
    print("Loading graph from cache...")
    with open(GRAPH_CACHE_FILE, 'rb') as f:
        graph = pickle.load(f)
    print(f"Loaded graph with {len(graph)} artists from cache")
    return graph

def build_artist_name_cache(conn):
    """Pre-build cache of all artist names for faster lookups."""
    print("Building artist name cache...")
    cache = {}
    
    with conn.cursor() as cur:
        cur.execute("SELECT id, name, gid FROM artist")
        for artist_id, name, gid in cur:
            cache[artist_id] = (name, gid)
    
    print(f"Cached {len(cache)} artist names")
    
    # Save to file
    with open(ARTIST_CACHE_FILE, 'wb') as f:
        pickle.dump(cache, f, protocol=pickle.HIGHEST_PROTOCOL)
    
    return cache

def load_artist_name_cache():
    """Load artist name cache from file."""
    if not os.path.exists(ARTIST_CACHE_FILE):
        return None
    
    with open(ARTIST_CACHE_FILE, 'rb') as f:
        return pickle.load(f)

def get_or_build_graph(conn, force_rebuild=False):
    """Get graph from cache or build it if needed."""
    if not force_rebuild:
        graph = load_graph_from_cache()
        if graph is not None:
            return graph
    
    # Build graph from scratch
    graph = build_collaboration_graph(conn)
    save_graph_to_cache(graph)
    return graph

def bidirectional_bfs_with_tracks(graph, start_id, end_id, artist_cache):
    """Optimized BFS with pre-cached artist names."""
    if start_id == end_id:
        return [(end_id, None)]

    visited_from_start = {start_id: (None, None)}
    visited_from_end = {end_id: (None, None)}

    queue_start = deque([start_id])
    queue_end = deque([end_id])

    while queue_start and queue_end:
        if len(queue_start) <= len(queue_end):
            meet = expand_frontier(graph, queue_start, visited_from_start, visited_from_end)
        else:
            meet = expand_frontier(graph, queue_end, visited_from_end, visited_from_start)

        if meet is not None:
            return reconstruct_path(meet, visited_from_start, visited_from_end)

    return None

def expand_frontier(graph, queue, visited_this_side, visited_other_side):
    """Optimized frontier expansion."""
    queue_size = len(queue)
    for _ in range(queue_size):
        current = queue.popleft()
        neighbors = graph.get(current, [])  # Use get() to avoid KeyError
        
        for neighbor, track in neighbors:
            if neighbor not in visited_this_side:
                visited_this_side[neighbor] = (current, track)
                if neighbor in visited_other_side:
                    return neighbor
                queue.append(neighbor)
    return None

def reconstruct_path(meeting_node, visited_from_start, visited_from_end):
    """Reconstruct path between start and end."""
    path_start = []
    node = meeting_node
    while node is not None:
        parent, track = visited_from_start[node]
        if parent is not None:
            path_start.append((node, track))
        node = parent
    path_start.reverse()

    path_end = []
    node = meeting_node
    while node is not None:
        parent, track = visited_from_end[node]
        if parent is not None:
            path_end.append((parent, track))
        node = parent

    return path_start + path_end

def main():
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        print("Connected to database")

        # Check if user wants to force rebuild
        if len(os.sys.argv) > 1 and os.sys.argv[1] == '--rebuild':
            print("Force rebuilding graph...")
            force_rebuild = True
        else:
            force_rebuild = False

        # Load or build artist name cache
        artist_cache = load_artist_name_cache()
        if artist_cache is None:
            artist_cache = build_artist_name_cache(conn)

        # Get collaboration graph (from cache or build)
        start_time = datetime.now()
        graph = get_or_build_graph(conn, force_rebuild)
        build_time = datetime.now() - start_time
        print(f"Graph ready in {build_time.total_seconds():.2f} seconds")

        # Select first artist
        a1_result = select_artist(conn, input("Enter first artist name: ").strip())
        if not a1_result:
            print("First artist not found")
            return
        a1_id, a1_name, search_time_1 = a1_result

        # Select second artist
        a2_result = select_artist(conn, input("Enter second artist name: ").strip())
        if not a2_result:
            print("Second artist not found")
            return
        a2_id, a2_name, search_time_2 = a2_result

        print(f"\nSearch Performance:")
        print(f"   First artist search:  {search_time_1.total_seconds():.3f} seconds")
        print(f"   Second artist search: {search_time_2.total_seconds():.3f} seconds")
        print(f"   Total search time:    {(search_time_1 + search_time_2).total_seconds():.3f} seconds")

        print(f"\nSearching for connection between '{a1_name}' and '{a2_name}'...")

        if a1_id not in graph or a2_id not in graph:
            print("One or both artists have no collaborations in the graph")
            return

        # Fast pathfinding with cached data
        search_start = datetime.now()
        path = bidirectional_bfs_with_tracks(graph, a1_id, a2_id, artist_cache)
        search_time = datetime.now() - search_start
        
        if not path:
            print(f"No connection path found between '{a1_name}' and '{a2_name}'.")
            print(f"Path search completed in {search_time.total_seconds():.3f} seconds")
            return

        print(f"\nConnection path found ({len(path)} degrees of separation) in {search_time.total_seconds():.3f} seconds:\n")
        current_name = a1_name
        for i, (artist_id, track) in enumerate(path, 1):
            # Use cached artist names instead of database queries
            if artist_id in artist_cache:
                next_name, gid = artist_cache[artist_id]
            else:
                # Fallback to database if not in cache
                with conn.cursor() as cur:
                    cur.execute("SELECT name, gid FROM artist WHERE id = %s", (artist_id,))
                    next_name, gid = cur.fetchone()
            
            print(f"{i}. {current_name}  <-->  {next_name} (MBID: {gid})")
            print(f"   via: '{track}'\n")
            current_name = next_name

        conn.close()

    except psycopg2.Error as e:
        print(f"Database error: {e}")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()