from flask import Flask, render_template, request, jsonify
import link_artists  # assumes this has a find_path(artist1, artist2) function and sp client

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

    try:
        results = link_artists.sp.search(q=f"artist:{query}", type="artist", limit=6)
        artists = results.get('artists', {}).get('items', [])

        # Sort by popularity, descending
        sorted_artists = sorted(artists, key=lambda x: x.get('popularity', 0), reverse=True)

        suggestions = [{
            'name': artist['name'],
            'id': artist['id'],
            'image': artist['images'][0]['url'] if artist.get('images') else None,
            'popularity': artist.get('popularity', 0),
            'genres': artist.get('genres', [])
        } for artist in sorted_artists]

        return jsonify({'artists': suggestions})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000, debug=True)