import os
import time
import pickle
from dotenv import load_dotenv
from spotipy import Spotify
from spotipy.oauth2 import SpotifyClientCredentials
from spotipy.exceptions import SpotifyException
from requests.exceptions import ReadTimeout, ConnectionError
from collections import deque

# Load environment variables
load_dotenv()

# --- Spotify client using Client Credentials Flow ---
auth = SpotifyClientCredentials(
    client_id=os.getenv("SPOTIPY_CLIENT_ID"),
    client_secret=os.getenv("SPOTIPY_CLIENT_SECRET")
)
sp = Spotify(auth_manager=auth)

# --- Retry Helper with Exponential Backoff ---
def spotify_call(func, *args, max_retries=5, **kwargs):
    delay = 1
    for _ in range(max_retries):
        try:
            return func(*args, **kwargs)
        except SpotifyException as e:
            if e.http_status == 429:
                retry_after = int(e.headers.get("Retry-After", delay))
                print(f"Rate limited, retrying after {retry_after}s...")
                time.sleep(retry_after)
            else:
                print(f"Spotify API error {e.http_status}, retrying in {delay}s...")
                time.sleep(delay)
                delay *= 2
        except (ReadTimeout, ConnectionError) as e:
            print(f"Network error ({e}), retrying in {delay}s...")
            time.sleep(delay)
            delay *= 2
    raise Exception("Spotify call failed after retries")

# --- Persistent Cache Setup ---
CACHE_PATH = "cache/collabs.pkl"
if not os.path.isdir("cache"):
    os.mkdir("cache")

try:
    with open(CACHE_PATH, "rb") as f:
        collab_cache = pickle.load(f)
except (FileNotFoundError, EOFError):
    collab_cache = {}

def save_cache():
    with open(CACHE_PATH, "wb") as f:
        pickle.dump(collab_cache, f)

# --- Helpers ---
def select_artist(name):
    results = spotify_call(sp.search, q=f"artist:{name}", type="artist", limit=6)
    artists = results["artists"]["items"]
    if not artists:
        print(f"No artists found for '{name}'. Try again.")
        return None

    # Sort by popularity descending
    artists.sort(key=lambda a: a.get("popularity", 0), reverse=True)

    print("\nSelect the correct artist (ranked by popularity):")
    for idx, artist in enumerate(artists):
        genres = ", ".join(artist["genres"]) or "N/A"
        print(f"{idx + 1}: {artist['name']} | Popularity: {artist['popularity']} | Genres: {genres} | ID: {artist['id']}")

    try:
        selection = int(input("Enter the number of the correct artist: "))
        return artists[selection - 1]
    except (ValueError, IndexError):
        print("Invalid selection.")
        return None



def get_artist_albums(artist_id):
    albums, seen = [], set()
    results = spotify_call(
        sp.artist_albums,
        artist_id,
        album_type="album,single",
        include_groups="album,single",
        limit=50
    )
    albums.extend(results.get("items", []))
    while results.get("next"):
        time.sleep(0.1)
        results = spotify_call(sp.next, results)
        albums.extend(results.get("items", []))

    unique = []
    for a in albums:
        if a["id"] not in seen:
            seen.add(a["id"])
            unique.append(a)
    return unique

def get_album_tracks(album_id):
    tracks = []
    results = spotify_call(sp.album_tracks, album_id)
    tracks.extend(results.get("items", []))
    while results.get("next"):
        time.sleep(0.1)
        results = spotify_call(sp.next, results)
        tracks.extend(results.get("items", []))
    return tracks

def extract_collaborators(albums, main_id):
    collabs, seen = [], set()
    for album in albums:
        for track in get_album_tracks(album["id"]):
            ids = tuple(sorted(a["id"] for a in track["artists"]))
            key = (track["name"], ids)
            if key in seen or main_id not in ids:
                continue
            seen.add(key)
            for art in track["artists"]:
                cid = art["id"]
                if cid != main_id:
                    collabs.append((cid, track["name"]))
    return collabs

def get_collaborators_for(artist_id):
    # return list of (neighbor_id, track) pairs
    if artist_id in collab_cache:
        return collab_cache[artist_id]

    albums = get_artist_albums(artist_id)
    collabs = extract_collaborators(albums, artist_id)
    collab_cache[artist_id] = collabs
    save_cache()
    return collabs

# --- Bidirectional BFS ---
def expand_layer(queue, parent_map, other_map):
    for _ in range(len(queue)):
        current = queue.popleft()
        for neighbor, track in get_collaborators_for(current):
            if neighbor in parent_map:
                continue
            parent_map[neighbor] = (current, track)
            if neighbor in other_map:
                return neighbor
            queue.append(neighbor)
    return None

def reconstruct_path(meet, front, back):
    path_front, node = [], meet
    while front[node] is not None:
        p, t = front[node]
        path_front.append((p, node, t))
        node = p
    path_front.reverse()

    path_back, node = [], meet
    while back[node] is not None:
        p, t = back[node]
        path_back.append((node, p, t))
        node = p

    return path_front + path_back

def find_collab_path(start_id, target_id, max_depth=10):
    front, back = {start_id: None}, {target_id: None}
    q_front, q_back = deque([start_id]), deque([target_id])
    depth = 0
    while q_front and q_back and depth < max_depth:
        if len(q_front) <= len(q_back):
            meet = expand_layer(q_front, front, back)
        else:
            meet = expand_layer(q_back, back, front)
        if meet:
            return reconstruct_path(meet, front, back)
        depth += 1
    return None

def auto_select_artist(name):
    results = spotify_call(sp.search, q=f"artist:{name}", type="artist", limit=5)
    artists = results["artists"]["items"]
    if not artists:
        return None
    artists.sort(key=lambda a: a.get("popularity", 0), reverse=True)
    return artists[0] 

# --- Main Execution ---
if __name__ == "__main__":
    name1 = input("Enter the first artist name: ").strip()
    artist1 = select_artist(name1)
    name2 = input("Enter the second artist name: ").strip()
    artist2 = select_artist(name2)
    if not artist1 or not artist2:
        print("Artist lookup failed"); exit()

    print(f"\nSearching collaboration path from {artist1['name']} to {artist2['name']}...\n")
    raw_path = find_collab_path(artist1["id"], artist2["id"])
    if not raw_path:
        print("No connection found within the explored network.")
        exit()

    ids = set()
    for frm, to, _ in raw_path:
        ids.add(frm)
        ids.add(to)
    artists_info = spotify_call(sp.artists, list(ids))["artists"]
    name_map = {a["id"]: a["name"] for a in artists_info}

    print("Found path:\n")
    for frm, to, track in raw_path:
        print(f"{name_map[frm]} ↔ {name_map[to]} on '{track}'")

# Main function used by Flask route

def find_path(start_name, end_name):
    print(f"Looking up artists: '{start_name}' and '{end_name}'")
    artist1 = auto_select_artist(start_name)
    artist2 = auto_select_artist(end_name)
    if not artist1:
        print(f"Artist '{start_name}' not found")
        return None
    if not artist2:
        print(f"Artist '{end_name}' not found")
        return None

    print(f"Found artists: {artist1['name']} ({artist1['id']}), {artist2['name']} ({artist2['id']})")
    raw_path = find_collab_path(artist1["id"], artist2["id"])
    if not raw_path:
        print("No path found between artists")
        return None

    print(f"Raw path: {raw_path}")
    ids = {frm for frm, to, _ in raw_path} | {to for frm, to, _ in raw_path}
    artists_info = spotify_call(sp.artists, list(ids))["artists"]
    name_map = {a["id"]: a["name"] for a in artists_info}
    return [(name_map[frm], name_map[to], track) for frm, to, track in raw_path]