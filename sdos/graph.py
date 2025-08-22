import os
import pickle
from collections import defaultdict

GRAPH_CACHE_FILE = 'data/processed/collaboration_graph.pkl'
ARTIST_CACHE_FILE = 'data/processed/artist_lookup.pkl'

def build_collaboration_graph(conn):
    """Build graph of collaborations with filtering logic."""
    print("Building collaboration graph...")
    graph = defaultdict(list)
    edge_seen = set()

    unwanted_types = ['Compilation', 'DJ-mix', 'Audiobook', 'Audio drama',
                      'Field recording', 'Interview', 'Live']
    unwanted_types_lower = [t.lower() for t in unwanted_types]
    
    unwanted_statuses = ['Bootleg', 'Pseudo-Release']
    unwanted_statuses_lower = [s.lower() for s in unwanted_statuses]
    
    vs_pattern = '%vs%'
    bad_release_artists = ['various artists', '[unknown]']

    with conn.cursor() as cur:
        cur.itersize = 10000  
        
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
              AND NOT EXISTS (
                SELECT 1
                FROM artist_credit_name rc
                WHERE rc.artist_credit = rel.artist_credit
                  AND LOWER(TRIM(rc.name)) = ANY(%s)
              )
              AND NOT EXISTS (
                SELECT 1
                FROM release_group_secondary_type_join j
                JOIN release_group_secondary_type s ON j.secondary_type = s.id
                WHERE j.release_group = rg.id
                  AND LOWER(s.name) = ANY(%s)
              )
              AND NOT EXISTS (
                SELECT 1
                FROM release_group_primary_type p
                WHERE rg.type = p.id
                  AND LOWER(p.name) = ANY(%s)
              )
              AND NOT EXISTS (
                SELECT 1
                FROM artist_credit_name acn_check
                WHERE acn_check.artist_credit = r.artist_credit
                  AND acn_check.join_phrase ILIKE %s
              )
              AND (rs.name IS NULL OR LOWER(rs.name) != ALL(%s))
            GROUP BY r.id, r.name
            HAVING COUNT(DISTINCT acn.artist) > 1
        """
        
        cur.execute(sql, (bad_release_artists, unwanted_types_lower,
                          unwanted_types_lower, vs_pattern, unwanted_statuses_lower))

        for rec_id, rec_name, artist_ids in cur:
            for i in range(len(artist_ids)):
                for j in range(i + 1, len(artist_ids)):
                    a1, a2 = artist_ids[i], artist_ids[j]
                    if a1 == a2:
                        continue
                    key = tuple(sorted((a1, a2)))
                    if key not in edge_seen:
                        graph[a1].append((a2, rec_name))
                        graph[a2].append((a1, rec_name))
                        edge_seen.add(key)

    print(f"Graph built with {len(graph)} artists")
    return graph

def save_graph_to_cache(graph):
    os.makedirs('data/processed', exist_ok=True)
    with open(GRAPH_CACHE_FILE, 'wb') as f:
        pickle.dump(graph, f, protocol=pickle.HIGHEST_PROTOCOL)

def load_graph_from_cache():
    if not os.path.exists(GRAPH_CACHE_FILE):
        return None
    with open(GRAPH_CACHE_FILE, 'rb') as f:
        return pickle.load(f)

def build_artist_name_cache(conn):
    cache = {}
    with conn.cursor() as cur:
        cur.execute("SELECT id, name, gid FROM artist")
        for artist_id, name, gid in cur:
            cache[artist_id] = (name, gid)
    with open(ARTIST_CACHE_FILE, 'wb') as f:
        pickle.dump(cache, f, protocol=pickle.HIGHEST_PROTOCOL)
    return cache

def load_artist_name_cache():
    if not os.path.exists(ARTIST_CACHE_FILE):
        return None
    with open(ARTIST_CACHE_FILE, 'rb') as f:
        return pickle.load(f)

def get_or_build_graph(conn, force_rebuild=False):
    if not force_rebuild:
        graph = load_graph_from_cache()
        if graph is not None:
            return graph
    graph = build_collaboration_graph(conn)
    save_graph_to_cache(graph)
    return graph
