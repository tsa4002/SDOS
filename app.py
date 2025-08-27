# app.py
import time
import threading
from typing import Optional, List, Tuple, Iterable

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

import requests  # pip install requests

# local package modules (your existing scripts)
from sdos.db import get_connection
from sdos.graph import (
    get_or_build_graph,
    load_graph_from_cache,
    load_artist_name_cache,
    build_artist_name_cache,
)
# updated pathfinding import supports excluded edges
from sdos.pathfinding import bidirectional_bfs_with_tracks
from sdos.search import search_artists

app = FastAPI(title="SDOS — MusicBrainz Collaboration Pathfinder")

# Mount static files (your HTML/CSS/JS/images)
app.mount("/static", StaticFiles(directory="static"), name="static")

# allow CORS for development/frontend testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global in-process caches (protected by lock)
GRAPH = None
ARTIST_CACHE = None  # dict: artist_id -> (name, gid)
GRAPH_LOCK = threading.Lock()

# Background loader to populate caches at startup (non-blocking)
def _background_loader():
    global GRAPH, ARTIST_CACHE
    try:
        # artist cache
        ARTIST_CACHE = load_artist_name_cache()
        if ARTIST_CACHE is None:
            conn = get_connection()
            try:
                ARTIST_CACHE = build_artist_name_cache(conn)
            finally:
                conn.close()

        # graph cache (load from pickle or build)
        GRAPH = load_graph_from_cache()
        if GRAPH is None:
            # building can be expensive — do it here (background) and save cache
            GRAPH = get_or_build_graph(conn=get_connection(), force_rebuild=False)
    except Exception as e:
        print("Background loader error:", e)

@app.on_event("startup")
def startup_event():
    t = threading.Thread(target=_background_loader, daemon=True)
    t.start()

# Models
class PathRequest(BaseModel):
    source_id: int
    target_id: int
    rebuild: Optional[bool] = False
    # Optional exclusion list of edges to avoid: list of [a, b]
    exclude_edges: Optional[List[List[int]]] = None

# Serve your pre-existing HTML (redirect to static index)
@app.get("/", include_in_schema=False)
def root_redirect():
    return RedirectResponse(url="/static/index.html")

@app.get("/health")
def health():
    return {"status": "ok"}

# API: search endpoint (wraps your existing search_artists)
@app.get("/api/search")
def api_search(q: str = Query(..., min_length=1), limit: int = 10):
    conn = get_connection()
    try:
        rows = search_artists(conn, q, limit=limit)
    finally:
        conn.close()
    result = []
    for r in rows:
        aid, name, gid, release_count = r
        result.append({
            "id": int(aid),
            "name": name,
            "gid": str(gid) if gid is not None else None,
            "release_count": int(release_count),
        })
    return JSONResponse(result)


# API: find path with optional exclude_edges
@app.post("/api/path")
def api_path(req: PathRequest):
    global GRAPH, ARTIST_CACHE

    # optionally rebuild first
    if req.rebuild:
        with GRAPH_LOCK:
            conn = get_connection()
            try:
                GRAPH = get_or_build_graph(conn=conn, force_rebuild=True)
            finally:
                conn.close()

    # ensure graph is loaded
    if GRAPH is None:
        with GRAPH_LOCK:
            conn = get_connection()
            try:
                GRAPH = get_or_build_graph(conn=conn, force_rebuild=False)
            finally:
                conn.close()

    # ensure artist cache
    if ARTIST_CACHE is None:
        ARTIST_CACHE = load_artist_name_cache() or {}

    # Quick membership check
    if req.source_id not in GRAPH or req.target_id not in GRAPH:
        missing = []
        if req.source_id not in GRAPH:
            missing.append(req.source_id)
        if req.target_id not in GRAPH:
            missing.append(req.target_id)
        detail_msg = "One or more artists not present in the filtered collaboration graph."
        raise HTTPException(status_code=404, detail=detail_msg)

    # Build excluded edges set expected by pathfinding: list of (a,b)
    excluded = None
    if req.exclude_edges:
        try:
            excluded = [(int(e[0]), int(e[1])) for e in req.exclude_edges if len(e) >= 2]
        except Exception:
            excluded = None

    start = time.time()
    path = bidirectional_bfs_with_tracks(GRAPH, req.source_id, req.target_id, excluded_edges=excluded)
    elapsed = time.time() - start

    if not path:
        return {"found": False, "seconds": elapsed, "path": []}

    # Build readable information using artist cache
    full_path = []
    prev_id = req.source_id
    prev_name = ARTIST_CACHE.get(prev_id, ("<unknown>", None))[0]
    for node_id, track in path:
        node_name, node_gid = ARTIST_CACHE.get(node_id, (None, None))
        if node_name is None:
            # fallback to DB
            conn = get_connection()
            try:
                cur = conn.cursor()
                cur.execute("SELECT name, gid FROM artist WHERE id = %s", (node_id,))
                row = cur.fetchone()
                if row:
                    node_name, node_gid = row[0], row[1]
                else:
                    node_name, node_gid = f"<id:{node_id}>", None
                cur.close()
            finally:
                conn.close()

        full_path.append({
            "from_id": prev_id,
            "from_name": prev_name,
            "to_id": int(node_id),
            "to_name": node_name,
            "to_mbid": str(node_gid) if node_gid else None,
            "track": track
        })
        prev_id = node_id
        prev_name = node_name

    return {"found": True, "seconds": elapsed, "degrees": len(path), "path": full_path}
