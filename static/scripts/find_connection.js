document.addEventListener('DOMContentLoaded', () => {
  const form       = document.getElementById('connectionForm');
  const resultsDiv = document.getElementById('results');
  const loaderObj  = document.getElementById('linkIcon');

  // === MOCK SETUP ===
  const useMock = false;  // toggle to false to hit real API
  const mockPath = [
    ['Kendrick Lamar', 'Schoolboy Q',   'Collabo Track 1 (feat. Jay Rock)'],
    ['Schoolboy Q',    'Anderson .Paak','Track 2 ft. Kendrick Lamar'],
    ['Anderson .Paak', 'Beyoncé',       'Track 3 (Remix)']
  ];

  // Before rendering, clean up the raw track name:
  function cleanTrackTitle(title) {
    return title
      // 1) Remove all parentheses and whatever’s inside them
      .replace(/\([^)]*\)/g, '')
      // 2) Remove “feat”, “ft” or “featuring” (case-insensitive) and anything that follows
      .replace(/\b(?:feat\.?|ft\.?|featuring)\b.*$/i, '')
      // 3) Trim leftover whitespace
      .trim();
  }

  // Renders a given path array to the resultsDiv, applying cleanTrackTitle
function renderResults(path) {
  let html = `<h2>Link'N'Listen</h2><div class="path-container">`;

  path.forEach(({ from, to, track, image, spotify, youtube, apple, preview }) => {
    const cleanedTrack = cleanTrackTitle(track);
    const imgSrc       = image || '/static/default_cover.png';

    html += `
      <div class="card-wrapper">
        <div class="song-card">
          <img src="${imgSrc}" alt="${cleanedTrack}" class="cover-art" />
        </div>

        <!-- new: audio preview -->
        ${preview
          ? `<audio controls preload="none" class="track-preview">
               <source src="${preview}" type="audio/mpeg">
               Your browser does not support the audio element.
             </audio>`
          : `<div class="no-preview">No preview available</div>`
        }

        <div class="links">
          <a href="${spotify || '#'}" target="_blank" rel="noopener noreferrer">
            <img src="/static/icons/spotify-icon.png" alt="Spotify">
          </a>
          <a href="${youtube}" target="_blank" rel="noopener noreferrer">
            <img src="/static/icons/youtube-icon.png" alt="YouTube">
          </a>
          <a href="${apple}" target="_blank" rel="noopener noreferrer">
            <img src="/static/icons/apple-icon.png" alt="Apple Music">
          </a>
        </div>

        <div class="info">
          <strong>${cleanedTrack}</strong><br/>${from} &amp; ${to}
        </div>
      </div>`;
  });

  html += `</div><footer><button id="tryAgainBtn">Try Another Route</button></footer>`;
  resultsDiv.innerHTML = html;

  document.getElementById('tryAgainBtn').addEventListener('click', () => {
    resultsDiv.innerHTML = '';
    form.reset();
    form.artist1.focus();
    selectedImages.artist1.style.display = 'none';
    selectedImages.artist1.src = '';
    selectedImages.artist2.style.display = 'none';
    selectedImages.artist2.src = '';
  });
}



  // === LOADER SETUP ===
  loaderObj.addEventListener('load', () => {
    const svgDoc = loaderObj.contentDocument;
    if (svgDoc) svgDoc.documentElement.pauseAnimations();
  });
  function startLoader() {
    const svgDoc = loaderObj.contentDocument;
    if (svgDoc) svgDoc.documentElement.unpauseAnimations();
  }
  function stopLoader() {
    const svgDoc = loaderObj.contentDocument;
    if (svgDoc) svgDoc.documentElement.pauseAnimations();
  }

  const selectedImages = {
    artist1: document.getElementById('selected-artist1-img'),
    artist2: document.getElementById('selected-artist2-img'),
  };

  function shakeElement(el) {
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 400);
  }

  // === AUTOCOMPLETE ===
  function setupAutocomplete(inputId) {
    const input    = document.getElementById(inputId);
    const wrapper  = input.parentElement;
    const dropdown = document.createElement('div');
    dropdown.className = 'autocomplete-dropdown';
    wrapper.appendChild(dropdown);

    let debounceTimeout, selectedIndex = -1;

    input.addEventListener('input', () => {
      stopLoader();
      const imgEl = selectedImages[inputId];
      imgEl.style.display = 'none';
      imgEl.src = '';

      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(async () => {
        const q = input.value.trim();
        if (!q) {
          dropdown.innerHTML = '';
          dropdown.style.display = 'none';
          selectedIndex = -1;
          return;
        }
        try {
          const res = await fetch(`/search_artist?q=${encodeURIComponent(q)}`);
          if (!res.ok) throw new Error();
          const { artists } = await res.json();

          if (!artists.length) {
            dropdown.innerHTML = `<div class="autocomplete-item no-results">No results</div>`;
          } else {
            dropdown.innerHTML = artists.map(a => {
              const img = a.image || '/static/default_avatar.png';
              return `
                <div class="autocomplete-item" 
                     data-name="${a.name}" 
                     data-img="${img}">
                  <img src="${img}" class="artist-thumb" alt="${a.name}" />
                  <span>${a.name}</span>
                </div>`;
            }).join('');
          }

          dropdown.style.display = 'block';
          selectedIndex = -1;

          dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
            if (item.classList.contains('no-results')) return;
            item.addEventListener('click', () => {
              const name = item.dataset.name;
              const img  = item.dataset.img;
              input.value = name;
              dropdown.style.display = 'none';
              input.focus();
              const imgEl2 = selectedImages[inputId];
              imgEl2.src = img;
              imgEl2.style.display = 'block';
            });
          });
        } catch {
          dropdown.innerHTML = `<div class="autocomplete-item no-results">Error loading results</div>`;
          dropdown.style.display = 'block';
          selectedIndex = -1;
        }
      }, 300);
    });

    input.addEventListener('keydown', e => {
      const items = dropdown.querySelectorAll('.autocomplete-item:not(.no-results)');
      if (!items.length) return;
      if (e.key === 'ArrowDown')      { e.preventDefault(); selectedIndex = (selectedIndex + 1) % items.length; }
      else if (e.key === 'ArrowUp')   { e.preventDefault(); selectedIndex = (selectedIndex - 1 + items.length) % items.length; }
      else if (e.key === 'Enter' && selectedIndex >= 0) {
        e.preventDefault();
        items[selectedIndex].click();
        return;
      } else return;
      items.forEach((it,i) => it.classList.toggle('highlighted', i===selectedIndex));
      items[selectedIndex].scrollIntoView({ block: 'nearest' });
    });

    input.addEventListener('blur', () => {
      setTimeout(() => dropdown.style.display = 'none', 200);
    });
  }

  setupAutocomplete('artist1');
  setupAutocomplete('artist2');

  // === SUBMIT HANDLER ===
  form.addEventListener('submit', async event => {
    event.preventDefault();
    resultsDiv.innerHTML = '';
    const img1Vis = selectedImages.artist1.style.display === 'block';
    const img2Vis = selectedImages.artist2.style.display === 'block';
    let invalid = false;
    if (!img1Vis) { shakeElement(form.artist1); invalid = true; }
    if (!img2Vis) { shakeElement(form.artist2); invalid = true; }
    if (invalid) { stopLoader(); return; }

    if (useMock) {
      renderResults(mockPath);
      return;
    }

    startLoader();
    try {
      const resp = await fetch('/connect', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          artist1: form.artist1.value.trim(),
          artist2: form.artist2.value.trim()
        })
      });

      if (!resp.ok) {
        stopLoader();
        const err = await resp.json();
        resultsDiv.textContent = err.error || 'Error finding connection.';
        return;
      }

      const { path } = await resp.json();
      if (!path || !path.length) {
        stopLoader();
        resultsDiv.textContent = 'No connection found';
        return;
      }

      renderResults(path);
    } catch (e) {
      resultsDiv.textContent = `Unexpected error: ${e.message}`;
    } finally {
      stopLoader();
    }
  });
});
