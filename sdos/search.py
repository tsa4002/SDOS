from datetime import datetime

def search_artists(conn, name, limit=10):
    """
    Optimized artist search with unified query and better performance.
    Returns list of tuples: (artist_id, artist_name, artist_gid, release_count)
    """
    with conn.cursor() as cur:
        cur.execute("""
            WITH ranked_matches AS (
                SELECT DISTINCT a.id, a.name, a.gid, 
                       1 as match_priority,
                       CASE WHEN LOWER(a.name) = LOWER(%s) THEN 1 ELSE 0 END as exact_match
                FROM artist a
                WHERE LOWER(a.name) = LOWER(%s)
                
                UNION ALL
                
                SELECT DISTINCT a.id, a.name, a.gid, 
                       2 as match_priority,
                       CASE WHEN LOWER(aa.name) = LOWER(%s) THEN 1 ELSE 0 END as exact_match
                FROM artist_alias aa
                JOIN artist a ON aa.artist = a.id
                WHERE LOWER(aa.name) = LOWER(%s)
                
                UNION ALL
                
                SELECT DISTINCT a.id, a.name, a.gid, 
                       3 as match_priority,
                       0 as exact_match
                FROM artist a
                WHERE LOWER(a.name) LIKE LOWER(%s)
                  AND LOWER(a.name) != LOWER(%s)
                  AND NOT EXISTS (
                    SELECT 1 FROM artist a2 WHERE LOWER(a2.name) = LOWER(%s)
                    UNION ALL
                    SELECT 1 FROM artist_alias aa2 
                    JOIN artist a3 ON aa2.artist = a3.id 
                    WHERE LOWER(aa2.name) = LOWER(%s)
                  )
                LIMIT 50
            ),
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

    print(f"\nMultiple artists found for '{name}':")
    for i, (artist_id, artist_name, gid, release_count) in enumerate(matches, 1):
        print(f"{i}. {artist_name} (MBID: {gid}) - {release_count} releases")

    while True:
        choice = input(f"Enter the number of the correct artist (1-{len(matches)}): ").strip()
        if choice.isdigit():
            idx = int(choice)
            if 1 <= idx <= len(matches):
                artist_id, artist_name, gid, _ = matches[idx - 1]
                return (artist_id, artist_name, search_time)
        print("Invalid choice. Try again.")
