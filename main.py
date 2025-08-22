#!/usr/bin/env python3
"""
main.py

Run the SDOS CLI (now modular) which:
 - lets the user pick two artists (ranked results shown)
 - builds or loads a cached collaboration graph
 - finds a shortest path between artists using bidirectional BFS
 - prints the path with MBIDs and the recording used per hop

Usage:
    python main.py            # normal run (uses cache if present)
    python main.py --rebuild  # force rebuild of the collaboration graph
"""

import os
import sys
from datetime import datetime

from sdos.db import get_connection
from sdos.graph import (
    get_or_build_graph,
    load_artist_name_cache,
    build_artist_name_cache,
)
from sdos.search import select_artist
from sdos.pathfinding import bidirectional_bfs_with_tracks


def print_intro():
    print("MusicBrainz Six Degrees of Separation (SDOS)")
    print("--------------------------------------------------")


def format_seconds(td):
    return f"{td.total_seconds():.3f}s"


def main():
    # CLI arg: --rebuild to force graph rebuild
    force_rebuild = False
    if len(sys.argv) > 1 and sys.argv[1] == "--rebuild":
        force_rebuild = True

    conn = None
    try:
        conn = get_connection()
        print("✅ Connected to database")

        # Load or create artist name cache (id -> (name, gid))
        artist_cache = load_artist_name_cache()
        if artist_cache is None:
            print("Artist name cache not found; building...")
            artist_cache = build_artist_name_cache(conn)

        # Build or load the collaboration graph (may be large; cached to disk)
        start_build = datetime.now()
        graph = get_or_build_graph(conn, force_rebuild=force_rebuild)
        build_time = datetime.now() - start_build
        print(f"Graph ready (artists in graph: {len(graph)}) — build/load took {format_seconds(build_time)}")

        # Select first artist
        a1_input = input("Enter first artist name: ").strip()
        a1_result = select_artist(conn, a1_input)
        if not a1_result:
            print(f"❌ First artist '{a1_input}' not found.")
            return
        a1_id, a1_name, search_time_1 = a1_result

        # Select second artist
        a2_input = input("Enter second artist name: ").strip()
        a2_result = select_artist(conn, a2_input)
        if not a2_result:
            print(f"❌ Second artist '{a2_input}' not found.")
            return
        a2_id, a2_name, search_time_2 = a2_result

        print("\nSearch Performance:")
        print(f"  First artist lookup : {format_seconds(search_time_1)}")
        print(f"  Second artist lookup: {format_seconds(search_time_2)}")
        print(f"  Total artist lookup : {format_seconds(search_time_1 + search_time_2)}")

        print(f"\nSearching for connection between '{a1_name}' and '{a2_name}'...")

        # Make sure both artists exist in the built graph
        if a1_id not in graph or a2_id not in graph:
            print("❌ One or both artists have no collaborations in the graph (or were filtered).")
            if a1_id not in graph:
                print(f"   - {a1_name} (id={a1_id}) not in graph")
            if a2_id not in graph:
                print(f"   - {a2_name} (id={a2_id}) not in graph")
            return

        # Run pathfinding (bidirectional BFS)
        path_start = datetime.now()
        path = bidirectional_bfs_with_tracks(graph, a1_id, a2_id)
        path_time = datetime.now() - path_start

        if not path:
            print(f"❌ No connection path found between '{a1_name}' and '{a2_name}'.")
            print(f"Path search completed in {format_seconds(path_time)}")
            return

        # Print the path
        print(f"\n✅ Connection path found ({len(path)} degrees of separation) in {format_seconds(path_time)}:\n")
        current_name = a1_name
        step = 0
        for artist_id, track in path:
            step += 1
            # Prefer cached name+gid
            if artist_id in artist_cache:
                next_name, gid = artist_cache[artist_id]
            else:
                # Fallback: query DB
                with conn.cursor() as cur:
                    cur.execute("SELECT name, gid FROM artist WHERE id = %s", (artist_id,))
                    row = cur.fetchone()
                    if row:
                        next_name, gid = row
                    else:
                        next_name, gid = f"<artist {artist_id}>", None

            print(f"{step}. {current_name}  <-->  {next_name} (MBID: {gid})")
            print(f"    via: '{track}'\n")
            current_name = next_name

        # final artist confirmation
        print(f"Final artist: {current_name}")

    except Exception as e:
        print("❌ Error running SDOS:")
        print(e)
        import traceback
        traceback.print_exc()
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    print_intro()
    main()
