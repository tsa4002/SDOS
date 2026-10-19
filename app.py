
import os
import time
import sqlite3
from typing import Optional, List

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from sdos.sqlite_graph import SQLiteGraph
from sdos.pathfinding import bidirectional_bfs_with_tracks


app = FastAPI(title="SDOS - MusicBrainz Collaboration Pathfinder")

# Database paths
SEARCH_DB_PATH = os.path.join(
    "data", "processed", "artist_search.sqlite"
)
GRAPH_DB_PATH = os.path.join(
    "data", "processed", "collaboration_graph.sqlite"
)

# Static frontend
app.mount("/static", StaticFiles(directory="static"), name="static")

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Disk-backed graph. This does not load the entire graph into RAM.
GRAPH = None


# --------------------------------------------------
# Startup
# --------------------------------------------------

@app.on_event("startup")
def startup_event():
    global GRAPH

    if os.path.exists(GRAPH_DB_PATH):
        GRAPH = SQLiteGraph(GRAPH_DB_PATH)
        print(f"SQLite collaboration graph ready: {GRAPH_DB_PATH}")
    else:
        print(f"WARNING: Graph database not found: {GRAPH_DB_PATH}")

    if os.path.exists(SEARCH_DB_PATH):
        print(f"Artist search database ready: {SEARCH_DB_PATH}")
    else:
        print(f"WARNING: Search database not found: {SEARCH_DB_PATH}")


# --------------------------------------------------
# Request models
# --------------------------------------------------

class PathRequest(BaseModel):
    source_id: int
    target_id: int
    rebuild: Optional[bool] = False
    exclude_edges: Optional[List[List[int]]] = None


# --------------------------------------------------
# Pages and health
# --------------------------------------------------

@app.get("/", include_in_schema=False)
def root_redirect():
    return RedirectResponse(url="/static/index.html")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "graph_loaded": GRAPH is not None,
        "graph_db_exists": os.path.exists(GRAPH_DB_PATH),
        "search_db_exists": os.path.exists(SEARCH_DB_PATH),
    }


# --------------------------------------------------
# Artist search using SQLite
# --------------------------------------------------

@app.get("/api/search")
def api_search(
    q: str = Query(..., min_length=1),
    limit: int = 10,
):
    query = q.strip()
    limit = max(1, min(limit, 50))

    if not query:
        return JSONResponse(content=[])

    if not os.path.exists(SEARCH_DB_PATH):
        raise HTTPException(
            status_code=503,
            detail="Artist search database is not available.",
        )

    conn = sqlite3.connect(SEARCH_DB_PATH)

    try:
        rows = conn.execute(
            """
            SELECT
                a.id,
                a.name,
                a.gid,
                a.release_count
            FROM artist_fts AS f
            JOIN artists AS a ON a.id = f.rowid
            WHERE f.name LIKE ?
            ORDER BY
                CASE
                    WHEN LOWER(a.name) = LOWER(?) THEN 0
                    WHEN LOWER(a.name) LIKE LOWER(?) THEN 1
                    ELSE 2
                END,
                a.name
            LIMIT ?
            """,
            (
                f"%{query}%",
                query,
                f"{query}%",
                limit,
            ),
        ).fetchall()

    except sqlite3.Error as e:
        print(f"SQLite artist search error: {e}")
        raise HTTPException(
            status_code=500,
            detail="Artist search failed.",
        )

    finally:
        conn.close()

    results = [
        {
            "id": int(artist_id),
            "name": name,
            "gid": gid,
            "release_count": int(release_count or 0),
        }
        for artist_id, name, gid, release_count in rows
    ]

    return JSONResponse(content=results)


# --------------------------------------------------
# Artist name and MusicBrainz ID lookup
# --------------------------------------------------

def lookup_artists(artist_ids):
    """Retrieve names and MusicBrainz IDs without a large RAM cache."""

    unique_ids = list(dict.fromkeys(int(x) for x in artist_ids))

    if not unique_ids:
        return {}

    if not os.path.exists(SEARCH_DB_PATH):
        raise HTTPException(
            status_code=503,
            detail="Artist lookup database is not available.",
        )

    conn = sqlite3.connect(SEARCH_DB_PATH)

    try:
        result = {}

        # Chunk IDs to stay comfortably below SQLite's parameter limit.
        for start in range(0, len(unique_ids), 500):
            chunk = unique_ids[start:start + 500]
            placeholders = ",".join("?" for _ in chunk)

            rows = conn.execute(
                f"""
                SELECT id, name, gid
                FROM artists
                WHERE id IN ({placeholders})
                """,
                chunk,
            ).fetchall()

            for artist_id, name, gid in rows:
                result[int(artist_id)] = (name, gid)

        return result

    except sqlite3.Error as e:
        print(f"SQLite artist lookup error: {e}")
        raise HTTPException(
            status_code=500,
            detail="Could not look up artist names.",
        )

    finally:
        conn.close()


# --------------------------------------------------
# Find collaboration path
# --------------------------------------------------

@app.post("/api/path")
def api_path(req: PathRequest):
    if req.rebuild:
        raise HTTPException(
            status_code=400,
            detail=(
                "Graph rebuilding is not available on the deployed app. "
                "Regenerate the graph database offline and redeploy it."
            ),
        )

    if GRAPH is None:
        raise HTTPException(
            status_code=503,
            detail="The collaboration graph database is not available.",
        )

    # Confirm both artists belong to the graph.
    missing = []

    if req.source_id not in GRAPH:
        missing.append(req.source_id)

    if req.target_id not in GRAPH:
        missing.append(req.target_id)

    if missing:
        raise HTTPException(
            status_code=404,
            detail=(
                "One or more artists are not present in the "
                "filtered collaboration graph."
            ),
        )

    # Convert excluded edges to tuples.
    excluded = None

    if req.exclude_edges:
        try:
            excluded = [
                (int(edge[0]), int(edge[1]))
                for edge in req.exclude_edges
                if len(edge) >= 2
            ]
        except (TypeError, ValueError, IndexError):
            raise HTTPException(
                status_code=400,
                detail="Invalid excluded-edge format.",
            )

    # Find shortest path.
    start_time = time.time()

    path = bidirectional_bfs_with_tracks(
        GRAPH,
        req.source_id,
        req.target_id,
        excluded_edges=excluded,
    )

    elapsed = time.time() - start_time

    if not path:
        return {
            "found": False,
            "seconds": elapsed,
            "path": [],
        }

    # Resolve names and MusicBrainz IDs from SQLite.
    artist_ids = [req.source_id]
    artist_ids.extend(node_id for node_id, _ in path)
    artist_info = lookup_artists(artist_ids)

    full_path = []
    previous_id = req.source_id

    previous_name = artist_info.get(
        previous_id,
        (f"<id:{previous_id}>", None),
    )[0]

    for node_id, track in path:
        node_name, node_gid = artist_info.get(
            node_id,
            (f"<id:{node_id}>", None),
        )

        full_path.append(
            {
                "from_id": int(previous_id),
                "from_name": previous_name,
                "to_id": int(node_id),
                "to_name": node_name,
                "to_mbid": str(node_gid) if node_gid else None,
                "track": track,
            }
        )

        previous_id = node_id
        previous_name = node_name

    return {
        "found": True,
        "seconds": elapsed,
        "degrees": len(path),
        "path": full_path,
    }
