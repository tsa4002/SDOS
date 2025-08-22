# app.py
import time
import threading
import urllib.parse
from typing import Optional, Tuple

import httpx
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# local package modules (your existing scripts)
from sdos.db import get_connection
from sdos.graph import (
    get_or_build_graph,
    load_graph_from_cache,
    load_artist_name_cache,
    build_artist_name_cache,
)
from sdos.search import search_artists  # signature: (conn, name, limit)
from sdos.pathfinding import bidirectional_bfs_with_tracks

app = FastAPI(title="SDOS — MusicBrainz Collaboration Pathfinder")

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# CORS for dev — restrict for production
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global caches & locks
GRAPH = None
ARTIST_CACHE = None
GRAPH_LOCK = threading.Lock()

# Background loader
def _background_loader():
    global GRAPH, ARTIST_CACHE
    try:
        ARTIST_CACHE = load_artist_name_cache()
        if ARTIST_CACHE is None:
            conn = get_connection()
            try:
                ARTIST_CACHE = build_artist_name_cache(conn)
            finally:
                conn.close()

        GRAPH = load_graph_from_cache()
        if GRAPH is None:
            GRAPH = get_or_build_graph(force_rebuild=False)
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

# Root -> static index
@app.get("/", include_in_schema=False)
def root_redirect():
    return RedirectResponse(url="/static/index.html")

@app.get("/health")
def health():
    return {"status": "ok"}

# Search API
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

# Rebuild graph API
@app.post("/api/rebuild")
def api_rebuild():
    global GRAPH
    with GRAPH_LOCK:
        start = time.time()
        GRAPH = get_or_build_graph(force_rebuild=True)
        elapsed = time.time() - start
        return {"status": "ok", "graph_size": len(GRAPH), "seconds": elapsed}

# Path API
@app.post("/api/path")
def api_path(req: PathRequest):
    global GRAPH, ARTIST_CACHE

    if req.rebuild:
        with GRAPH_LOCK:
            GRAPH = get_or_build_graph(force_rebuild=True)

    if GRAPH is None:
        with GRAPH_LOCK:
            GRAPH = get_or_build_graph(force_rebuild=False)

    if ARTIST_CACHE is None:
        ARTIST_CACHE = load_artist_name_cache() or {}

    if req.source_id not in GRAPH or req.target_id not in GRAPH:
        missing = []
        if req.source_id not in GRAPH:
            missing.append(req.source_id)
        if req.target_id not in GRAPH:
            missing.append(req.target_id)
        raise HTTPException(status_code=404, detail={
            "msg": "One or more artists not present in the filtered collaboration graph (they may have been excluded by your filters).",
            "missing_artist_ids": missing
        })

    start = time.time()
    path = bidirectional_bfs_with_tracks(GRAPH, req.source_id, req.target_id)
    elapsed = time.time() - start

    if not path:
        return {"found": False, "seconds": elapsed}

    full_path = []
    prev_id = req.source_id
    prev_name = ARTIST_CACHE.get(prev_id, ("<unknown>", None))[0]
    for node_id, track in path:
        node_name, node_gid = ARTIST_CACHE.get(node_id, (None, None))
        if node_name is None:
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

# ----------------------------
# Deezer proxy: cover + preview
# ----------------------------

_COVER_CACHE = {}
_COVER_TTL_SECONDS = 60 * 60
_COVER_CACHE_MAX_ENTRIES = 20000
_DEEZER_TIMEOUT = 8.0

async def _query_deezer_track_info(track: str, artist: Optional[str] = None) -> Optional[Tuple[Optional[str], Optional[str]]]:
    """
    Return (cover_url, preview_url) from Deezer search (first matching track).
    """
    q = track if not artist else f"{track} {artist}"
    q_enc = urllib.parse.quote_plus(q)
    url = f"https://api.deezer.com/search/track?q={q_enc}&limit=1"

    try:
        async with httpx.AsyncClient(timeout=_DEEZER_TIMEOUT) as client:
            resp = await client.get(url)
            if resp.status_code != 200:
                print(f"Deezer returned {resp.status_code} for {q!r}")
                return None
            data = resp.json()
    except Exception as e:
        print("Deezer fetch error:", e)
        return None

    if not data or "data" not in data or not isinstance(data["data"], list) or len(data["data"]) == 0:
        return None

    item = data["data"][0]
    album = item.get("album", {}) or {}
    cover = None
    for key in ("cover_xl", "cover_big", "cover_medium", "cover"):
        if album.get(key):
            cover = album.get(key)
            break

    preview = item.get("preview")  # 30s mp3 URL or None
    return (cover, preview)

@app.get("/api/cover")
async def api_cover(track: str = Query(..., min_length=1), artist: Optional[str] = Query(None)):
    """
    Returns JSON: { "cover": "<url or null>", "preview": "<url or null>" }
    404 when neither cover nor preview found.
    """
    key = (track.strip().lower(), (artist or "").strip().lower())
    cached = _COVER_CACHE.get(key)
    now = time.time()
    if cached and (now - cached["ts"] < _COVER_TTL_SECONDS):
        return JSONResponse({"cover": cached["cover"], "preview": cached["preview"]})

    res = await _query_deezer_track_info(track, artist)
    if not res:
        raise HTTPException(status_code=404, detail="No cover/preview found")
    cover, preview = res

    # eviction
    if len(_COVER_CACHE) >= _COVER_CACHE_MAX_ENTRIES:
        oldest_key = min(_COVER_CACHE.items(), key=lambda kv: kv[1]["ts"])[0]
        _COVER_CACHE.pop(oldest_key, None)

    _COVER_CACHE[key] = {"cover": cover, "preview": preview, "ts": now}
    return JSONResponse({"cover": cover, "preview": preview})
