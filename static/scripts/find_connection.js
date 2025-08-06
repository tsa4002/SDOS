document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('connectionForm');
  const resultsDiv = document.getElementById('results');

  const linkIcon = document.getElementById('linkIcon');
  const spinner = document.getElementById('spinner');

  // --- AUTOCOMPLETE SETUP ---
  function setupAutocomplete(inputId) {
    const input = document.getElementById(inputId);
    const wrapper = input.parentElement;

    let dropdown = document.createElement('div');
    dropdown.className = 'autocomplete-dropdown';
    wrapper.appendChild(dropdown);

    let debounceTimeout;

    input.addEventListener('input', () => {
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(async () => {
        const query = input.value.trim();
        if (!query) {
          dropdown.innerHTML = '';
          dropdown.style.display = 'none';
          return;
        }
        try {
          const res = await fetch(`/search_artist?q=${encodeURIComponent(query)}`);
          if (!res.ok) throw new Error('Autocomplete fetch failed');
          const data = await res.json();
          const suggestions = data.artists || [];

          if (suggestions.length === 0) {
            dropdown.innerHTML = '<div class="autocomplete-item no-results">No results</div>';
          } else {
            dropdown.innerHTML = suggestions.map(a =>
              `<div class="autocomplete-item" data-name="${a.name}">${a.name}</div>`
            ).join('');
          }
          dropdown.style.display = 'block';

          dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
            item.addEventListener('click', () => {
              input.value = item.dataset.name;
              dropdown.style.display = 'none';
              input.focus();
            });
          });
        } catch (err) {
          dropdown.innerHTML = '<div class="autocomplete-item no-results">Error loading results</div>';
          dropdown.style.display = 'block';
        }
      }, 300);
    });

    input.addEventListener('blur', () => {
      setTimeout(() => {
        dropdown.style.display = 'none';
      }, 200);
    });
  }

  setupAutocomplete('artist1');
  setupAutocomplete('artist2');

  // --- Helper to clean track titles ---
  function cleanTrackTitle(title) {
    title = title.replace(/\s*\([^)]*\)/g, '');
    title = title.replace(/\s*(feat\.?|ft\.?|featured)\s*.*$/i, '');
    return title.trim();
  }

  // --- Spinner Control ---
  function showSpinner() {
    if (linkIcon && spinner) {
      linkIcon.classList.add('hidden');
      spinner.classList.remove('hidden');
    }
  }

  function hideSpinner() {
    if (linkIcon && spinner) {
      spinner.classList.add('hidden');
      linkIcon.classList.remove('hidden');
    }
  }

  // --- FORM SUBMISSION ---
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    resultsDiv.innerHTML = '';
    showSpinner();

    const artist1 = form.artist1.value.trim();
    const artist2 = form.artist2.value.trim();

    if (!artist1 || !artist2) {
      hideSpinner();
      resultsDiv.textContent = 'Please enter both artist names.';
      return;
    }

    try {
      const response = await fetch('/connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ artist1, artist2 })
      });

      if (!response.ok) {
        hideSpinner();
        const errorData = await response.json();
        resultsDiv.textContent = errorData.error || 'Error finding connection.';
        return;
      }

      const data = await response.json();
      const path = data.path;

      if (!path || path.length === 0) {
        hideSpinner();
        resultsDiv.textContent = 'No connection found between these artists.';
        return;
      }

      let html = `<h2>Link'N'Listen</h2>`;
      html += `<div class="path-container">`;

      path.forEach(([fromArtist, toArtist, track]) => {
        const cleanTitle = cleanTrackTitle(track);
        html += `
          <div class="card-wrapper">
            <div class="song-card">
              <img src="/static/default_cover.png" alt="Cover Art for ${cleanTitle}" class="cover-art" />
            </div>
            <div class="links">
              <a href="#" target="_blank"><img src="/static/icons/spotify-icon.png" alt="Spotify"></a>
              <a href="#" target="_blank"><img src="/static/icons/youtube-icon.png" alt="YouTube"></a>
              <a href="#" target="_blank"><img src="/static/icons/apple-icon.png" alt="Apple Music"></a>
            </div>
            <div class="info">
              <strong>${cleanTitle}</strong><br/>
              by ${fromArtist} &amp; ${toArtist}
            </div>
          </div>
        `;
      });

      html += `</div>`;
      html += `<footer><button id="tryAgainBtn">Try Another Route</button></footer>`;

      resultsDiv.innerHTML = html;

      document.getElementById('tryAgainBtn').addEventListener('click', () => {
        resultsDiv.innerHTML = '';
        form.reset();
        form.artist1.focus();
      });

    } catch (error) {
      resultsDiv.textContent = `Unexpected error: ${error.message}`;
    } finally {
      hideSpinner();
    }
  });
});
