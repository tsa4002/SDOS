document.addEventListener('DOMContentLoaded', () => {
  const form       = document.getElementById('connectionForm');
  const resultsDiv = document.getElementById('results');
  const loaderObj  = document.getElementById('linkIcon');

  // === MOCK SETUP ===
  const useMock = false;  // toggle to false to hit real API
  const mockPath = [
    {
      from: 'Kendrick Lamar',
      to: 'Schoolboy Q',
      track: 'Collabo Track 1 (feat. Jay Rock)',
      image: null,
      spotify: '#',
      youtube: '#',
      apple: '#',
      preview: null
    },
    {
      from: 'Schoolboy Q',
      to: 'Anderson .Paak',
      track: 'Track 2 ft. Kendrick Lamar',
      image: null,
      spotify: '#',
      youtube: '#',
      apple: '#',
      preview: null
    },
    {
      from: 'Anderson .Paak',
      to: 'Beyoncé',
      track: 'Track 3 (Remix)',
      image: null,
      spotify: '#',
      youtube: '#',
      apple: '#',
      preview: null
    }
  ];

  // Clean up raw track name
  function cleanTrackTitle(title) {
    return String(title || '')
      // 1) Remove all parentheses and whatever is inside them
      .replace(/\([^)]*\)/g, '')
      // 2) Remove "feat", "ft" or "featuring" (case-insensitive) and anything that follows
      .replace(/\b(?:feat\.?|ft\.?|featuring)\b.*$/i, '')
      // 3) Trim leftover whitespace
      .trim();
  }

  function renderResults(path) {
  let html = '<h2>Connection Path</h2><div class="path-container">';

  path.forEach(({ from, to, track, image, spotify, youtube, apple, preview }, index) => {
    const cleanedTrack = cleanTrackTitle(track);
    const imgSrc       = image || '/static/default_cover.png';

    const previewHtml = preview
      ? `<audio controls preload="none" class="track-preview">
           <source src="${preview}" type="audio/mpeg">
           Your browser does not support the audio element.
         </audio>`
      : `<div class="no-preview">No preview available</div>`;

    html += `
      <div class="card-wrapper">
        <div class="step-number">${index + 1}</div>

        <div class="song-card">
          <img src="${imgSrc}" alt="${cleanedTrack}" class="cover-art" />
        </div>

        ${previewHtml}

        <div class="links">
          <a href="${spotify || '#'}" target="_blank" rel="noopener noreferrer">
            <img src="/static/icons/spotify-icon.png" alt="Spotify">
          </a>
          <a href="${youtube || '#'}" target="_blank" rel="noopener noreferrer">
            <img src="/static/icons/youtube-icon.png" alt="YouTube">
          </a>
          <a href="${apple || '#'}" target="_blank" rel="noopener noreferrer">
            <img src="/static/icons/apple-icon.png" alt="Apple Music">
          </a>
        </div>

        <div class="info">
          <strong>${cleanedTrack}</strong><br/>${from} &amp; ${to}
        </div>
      </div>
    `;
  });

  // Add footer with three buttons: refresh (left), try again (center), share (right)
  html += `
    </div>
    <footer>
      <div class="footer-buttons">
        <button id="refreshBtn" title="Refresh Page" aria-label="Refresh Page">
          <img src="/static/icons/restart_icon.svg" alt="Restart Icon" />
        </button>
        <button id="tryAgainBtn">Try Another Route</button>
        <button id="shareBtn" title="Share" aria-label="Share">
          <img src="/static/icons/share_icon.svg" alt="Share Icon" />
        </button>
      </div>
    </footer>
  `;

  resultsDiv.innerHTML = html;

  // Button event listeners
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      window.location.reload();
    });
  }

  const tryBtn = document.getElementById('tryAgainBtn');
  if (tryBtn) {
    tryBtn.addEventListener('click', () => {
      resultsDiv.innerHTML = '';
      if (form) {
        form.reset();
        if (form.artist1) form.artist1.focus();
      }
      if (selectedImages.artist1) {
        selectedImages.artist1.style.display = 'none';
        selectedImages.artist1.src = '';
      }
      if (selectedImages.artist2) {
        selectedImages.artist2.style.display = 'none';
        selectedImages.artist2.src = '';
      }
    });
  }

  const shareBtn = document.getElementById('shareBtn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      // Replace with your actual share path or URL
      const sharePath = window.location.href; // or some custom URL
      if (navigator.share) {
        navigator.share({
          title: 'Check out this connection!',
          url: sharePath
        }).catch(console.error);
      } else {
        // fallback: copy URL to clipboard and alert user
        navigator.clipboard.writeText(sharePath).then(() => {
          alert('Link copied to clipboard!');
        });
      }
    });
  }

  // Scroll to results after rendering
  resultsDiv.scrollIntoView({
    behavior: 'smooth',
    block: 'start'
  });
}

  
  // === LOADER SETUP ===
  if (loaderObj) {
    loaderObj.addEventListener('load', () => {
      try {
        const svgDoc = loaderObj.contentDocument;
        if (svgDoc) svgDoc.documentElement.pauseAnimations();
      } catch (err) {
        // ignore if not an SVG or cross-origin
      }
    });
  }

  function startLoader() {
    try {
      const svgDoc = loaderObj && loaderObj.contentDocument;
      if (svgDoc) svgDoc.documentElement.unpauseAnimations();
    } catch (err) {}
  }
  function stopLoader() {
    try {
      const svgDoc = loaderObj && loaderObj.contentDocument;
      if (svgDoc) svgDoc.documentElement.pauseAnimations();
    } catch (err) {}
  }

  const selectedImages = {
    artist1: document.getElementById('selected-artist1-img'),
    artist2: document.getElementById('selected-artist2-img'),
  };

  function shakeElement(el) {
    if (!el) return;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 400);
  }
  

  // === AUTOCOMPLETE ===
function setupAutocomplete(inputId) {
  const input    = document.getElementById(inputId);
  if (!input) return;
  const wrapper  = input.parentElement;
  const dropdown = document.createElement('div');
  dropdown.className = 'autocomplete-dropdown';
  dropdown.style.display = 'none';
  wrapper.appendChild(dropdown);

  let debounceTimeout = null;
  let selectedIndex = -1;

  input.addEventListener('input', () => {
    stopLoader();
    const imgEl = selectedImages[inputId];
    if (imgEl) {
      imgEl.style.display = 'none';
      imgEl.src = '';
    }

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
        const res = await fetch('/search_artist?q=' + encodeURIComponent(q));
        if (!res.ok) throw new Error('Network response was not ok');
        const data = await res.json();
        const artists = data.artists || [];

        if (!artists.length) {
          dropdown.innerHTML = '<div class="autocomplete-item no-results">No results</div>';
        } else {
          dropdown.innerHTML = artists.map(a => {
            const img = a.image || '/static/default_avatar.png';
            const safeName = String(a.name || '').replace(/"/g, '&quot;');
            return `
              <div class="autocomplete-item" data-name="${safeName}" data-img="${img}">
                <img src="${img}" class="artist-thumb" alt="${safeName}" />
                <span>${safeName}</span>
              </div>
            `;
          }).join('');
        }

        dropdown.style.display = 'block';
        selectedIndex = -1;

        // Use mousedown to register before blur hides the dropdown
        dropdown.querySelectorAll('.autocomplete-item').forEach(item => {
          if (item.classList.contains('no-results')) return;
          item.addEventListener('mousedown', e => {
            e.preventDefault(); // Prevent focus loss before selection
            const name = item.dataset.name;
            const img  = item.dataset.img;
            input.value = name;
            dropdown.style.display = 'none';
            const imgEl2 = selectedImages[inputId];
            if (imgEl2) {
              imgEl2.src = img;
              imgEl2.style.display = 'block';
            }
          });
        });
      } catch (err) {
        dropdown.innerHTML = '<div class="autocomplete-item no-results">Error loading results</div>';
        dropdown.style.display = 'block';
        selectedIndex = -1;
      }
    }, 300);
  });

  input.addEventListener('keydown', e => {
    const items = Array.from(dropdown.querySelectorAll('.autocomplete-item:not(.no-results)'));
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % items.length;
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + items.length) % items.length;
    } else if (e.key === 'Enter' && selectedIndex >= 0) {
      e.preventDefault();
      items[selectedIndex].dispatchEvent(new Event('mousedown'));
      return;
    } else {
      return;
    }
    items.forEach((it, i) => it.classList.toggle('highlighted', i === selectedIndex));
    const el = items[selectedIndex];
    if (el) el.scrollIntoView({ block: 'nearest' });
  });

  // Delay hiding to allow click/mousedown to process first
  input.addEventListener('blur', () => {
    setTimeout(() => {
      dropdown.style.display = 'none';
    }, 150);
  });
}


  setupAutocomplete('artist1');
  setupAutocomplete('artist2');

  // === SUBMIT HANDLER ===
  if (form) {
    form.addEventListener('submit', async event => {
      event.preventDefault();
      resultsDiv.innerHTML = '';

      const img1Vis = selectedImages.artist1 && selectedImages.artist1.style.display === 'block';
      const img2Vis = selectedImages.artist2 && selectedImages.artist2.style.display === 'block';
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
            artist1: form.artist1 ? form.artist1.value.trim() : '',
            artist2: form.artist2 ? form.artist2.value.trim() : ''
          })
        });

        if (!resp.ok) {
          stopLoader();
          let errText = 'Error finding connection.';
          try {
            const err = await resp.json();
            errText = err.error || errText;
          } catch (e) {}
          resultsDiv.textContent = errText;
          return;
        }

        const data = await resp.json();
        const path = data.path || [];
        if (!path.length) {
          stopLoader();
          resultsDiv.textContent = 'No connection found';
          return;
        }

        renderResults(path);
      } catch (e) {
        resultsDiv.textContent = `Unexpected error: ${e && e.message ? e.message : e}`;
      } finally {
        stopLoader();
      }
    });
  }
});
