from flask import Flask, render_template, request, jsonify
import link_artists  # assumes this has a find_path(artist1, artist2) function and sp client
from rapidfuzz import fuzz

app = Flask(__name__)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/connect', methods=['POST'])
def connect_artists():
    data = request.get_json()
    print("Received POST data:", data)  # Debug line
    artist1 = data.get('artist1', '').strip()
    artist2 = data.get('artist2', '').strip()

    if not artist1 or not artist2:
        return jsonify({'error': 'Both artist names must be provided'}), 400

    try:
        path = link_artists.find_path(artist1, artist2)
    except Exception as e:
        return jsonify({'error': f'Error finding path: {str(e)}'}), 500

    if not path:
        return jsonify({'error': 'No connection found'}), 404

    return jsonify({'path': path})


@app.route('/search_artist')
def search_artist():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify({'artists': []})

    # Config
    try:
        limit = int(request.args.get('limit', 50))
    except ValueError:
        limit = 50

    try:
        pop_weight = float(request.args.get('pop_weight', 0.7))  # popularity weight, 0..1
    except ValueError:
        pop_weight = 0.7
    if pop_weight < 0: pop_weight = 0.0
    if pop_weight > 1: pop_weight = 1.0
    sim_weight = 1.0 - pop_weight

    q_lower = query.lower()

    try:
        results = link_artists.sp.search(q=f"artist:{query}", type="artist", limit=limit)
        artists = results.get('artists', {}).get('items', [])

        scored = []
        for artist in artists:
            name = artist.get('name', '') or ''
            name_lower = name.lower()
            popularity = artist.get('popularity', 0)  # 0..100

            # Fuzzy measures (0..100)
            r_exact = fuzz.ratio(q_lower, name_lower)
            r_partial = fuzz.partial_ratio(q_lower, name_lower)
            r_token_sort = fuzz.token_sort_ratio(q_lower, name_lower)
            r_token_set = fuzz.token_set_ratio(q_lower, name_lower)

            # Main similarity: take the best fuzzy score
            sim_main = max(r_exact, r_partial, r_token_sort, r_token_set)

            # Deterministic boosts for short queries / prefix / substring
            boost = 0.0
            # big boost if name starts with query (helps prefix matches)
            if name_lower.startswith(q_lower):
                boost += 0.20
            # smaller boost if query is a substring anywhere
            elif q_lower in name_lower:
                boost += 0.10
            # small bonus if exact name equals query
            if name_lower == q_lower:
                boost += 0.25

            # Normalize popularity and similarity to 0..1
            norm_pop = max(0.0, min(100.0, popularity)) / 100.0
            norm_sim = max(0.0, min(100.0, sim_main)) / 100.0

            combined = (pop_weight * norm_pop) + (sim_weight * norm_sim) + boost
            # clamp combined to a reasonable range
            if combined > 1.0:
                combined = combined  # allow >1 so boosts matter; sorting is what's important

            scored.append((combined, sim_main, artist))

        # sort by combined desc
        scored.sort(key=lambda tup: tup[0], reverse=True)

        suggestions = []
        for combined, sim_main, artist in scored:
            suggestions.append({
                'name': artist.get('name'),
                'id': artist.get('id'),
                'image': artist.get('images')[0]['url'] if artist.get('images') else None,
                'popularity': artist.get('popularity', 0),
                'genres': artist.get('genres', []),
            })

        return jsonify({'artists': suggestions})

    except Exception as e:
        return jsonify({'error': str(e)}), 500
    
if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)