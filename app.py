import json
import re
import unicodedata
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from html import unescape
from html.parser import HTMLParser
from urllib.parse import urlencode, urljoin, urlparse, parse_qs

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
# Track artwork and preview lookup using iTunes
# --------------------------------------------------

def normalize_music_text(value):
    """Normalize music titles and artist names for comparison."""
    value = unicodedata.normalize("NFKD", str(value or ""))
    value = "".join(
        char for char in value
        if not unicodedata.combining(char)
    )
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return " ".join(value.split())



class AppleSongLinkParser(HTMLParser):
    """Collect direct Apple Music song links in page order."""

    def __init__(self):
        super().__init__()
        self.song_links = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return

        href = dict(attrs).get("href")
        if not href:
            return

        href = unescape(href)
        full_url = urljoin("https://music.apple.com", href)
        parsed = urlparse(full_url)

        if parsed.netloc.lower() not in {
            "music.apple.com",
            "www.music.apple.com",
        }:
            return

        if "/album/" not in parsed.path:
            return

        # Apple song links commonly identify the specific song using ?i=ID.
        track_ids = parse_qs(parsed.query).get("i", [])

        if track_ids and track_ids[0].isdigit():
            entry = (track_ids[0], full_url)

            if entry not in self.song_links:
                self.song_links.append(entry)


@app.get("/api/cover")
def api_cover(
    track: str = Query(..., min_length=1),
    artist1: str = "",
    artist2: str = "",
):
    track = track.strip()
    artist1 = artist1.strip()
    artist2 = artist2.strip()

    if not track:
        return {"cover": None, "preview": None}

    # Match the query structure used by the Apple Music hyperlink.
    search_term = " ".join(
        value for value in (track, artist1, artist2) if value
    )

    search_url = (
        "https://music.apple.com/us/search?"
        + urlencode({"term": search_term})
    )

    try:
        request = Request(
            search_url,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; SDOS/1.0)",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )

        with urlopen(request, timeout=15) as response:
            page_html = response.read().decode(
                "utf-8", errors="replace"
            )

    except Exception as exc:
        print(f"Apple Music search page failed: {exc}")
        return {"cover": None, "preview": None}

    parser = AppleSongLinkParser()
    parser.feed(page_html)

    if not parser.song_links:
        print(f"No direct song links found on Apple Music: {search_term}")
        return {"cover": None, "preview": None}

    # Use Apple's own first direct song result.
    track_id, song_url = parser.song_links[0]

    print(f"Apple Music selected: {song_url}")

    # Fetch metadata for that exact song ID, not another title search.
    lookup_url = (
        "https://itunes.apple.com/lookup?"
        + urlencode({"id": track_id, "country": "US"})
    )

    try:
        request = Request(
            lookup_url,
            headers={"User-Agent": "SDOS/1.0"},
        )

        with urlopen(request, timeout=10) as response:
            data = json.loads(
                response.read().decode("utf-8")
            )

    except Exception as exc:
        print(f"iTunes track lookup failed for {track_id}: {exc}")
        return {"cover": None, "preview": None}

    results = data.get("results", [])

    if not results:
        print(f"No iTunes metadata returned for track ID {track_id}")
        return {"cover": None, "preview": None}

    item = results[0]

    cover = item.get("artworkUrl100")

    if cover:
        cover = cover.replace("100x100", "600x600")

    preview = item.get("previewUrl")

    print(
        f"Apple Music selected: {item.get('trackName')} by "
        f"{item.get('artistName')}; "
        f"preview={bool(preview)}"
    )

    return {
        "cover": cover,
        "preview": preview,
        "appleUrl": song_url,
    }



def normalize_artist_name(name: str) -> str:
    normalized = unicodedata.normalize("NFKD", name)
    return "".join(
        char
        for char in normalized
        if not unicodedata.combining(char)
    ).casefold()

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

    # We cannot guarantee graph eligibility if the graph is unavailable.
    if GRAPH is None:
        raise HTTPException(
            status_code=503,
            detail="The collaboration graph database is not available.",
        )

    conn = sqlite3.connect(SEARCH_DB_PATH)

    try:
        results = []
        offset = 0

        # Fetch candidates in batches so ineligible artists do not
        # prevent eligible artists further down the ranking from appearing.
        batch_size = max(100, min(500, limit * 10))

        while len(results) < limit:
            rows = conn.execute(
                """
                SELECT
                    a.id,
                    a.name,
                    a.gid,
                    a.release_count
                FROM artists AS a
                WHERE a.name_normalized LIKE ?
                    AND a.release_count >= 20
                ORDER BY
                    a.release_count DESC,
                    a.name COLLATE NOCASE ASC
                LIMIT ? OFFSET ?
                """,
                (
                    f"{normalize_artist_name(query)}%",
                    batch_size,
                    offset,
                ),
            ).fetchall()

            if not rows:
                break

            offset += len(rows)

            for artist_id, name, gid, release_count in rows:
                artist_id = int(artist_id)

                # Only offer artists present in the actual graph.
                if artist_id not in GRAPH:
                    continue

                results.append({
                    "id": artist_id,
                    "name": name,
                    "gid": gid,
                    "release_count": int(release_count or 0),
                })

                if len(results) >= limit:
                    break

    except sqlite3.Error as e:
        print(f"SQLite artist search error: {e}")
        raise HTTPException(
            status_code=500,
            detail="Artist search failed.",
        )

    finally:
        conn.close()

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
                "Unfortunately, one of the artists is not present in the filtered collaboration graph." 
                "Please try another artist."
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
