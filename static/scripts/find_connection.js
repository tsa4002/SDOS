// static/js/main.js
// SDOS frontend main script — shows MBID in autocomplete and ensures default cover replaces purple gradient

console.log('SDOS main.js starting...');

(function () {
  // ---------- Utilities ----------
  function debounce(fn, wait = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }

  function shakeElement(el) {
    if (!el) return;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 420);
  }

  function generateMusicServiceUrls(trackName, artistName) {
    const query = encodeURIComponent(`${trackName} ${artistName}`);
    return {
      spotify: `https://open.spotify.com/search/${query}`,
      youtube: `https://www.youtube.com/results?search_query=${query}`,
      apple: `https://music.apple.com/search?term=${query}`
    };
  }

  // ---------- DOM elements ----------
  const a1 = document.getElementById('artist1');
  const a2 = document.getElementById('artist2');
  const hid1 = document.getElementById('artist1_id');
  const hid2 = document.getElementById('artist2_id');
  const img1 = document.getElementById('selected-artist1-img');
  const img2 = document.getElementById('selected-artist2-img');
  const resultsEl = document.getElementById('results');
  const loadingEl = document.getElementById('loading'); // optional textual loading indicator
  const findBtn = document.getElementById('findBtn');
  const form = document.getElementById('connectionForm');

  // spinner object + wrapper (in your form HTML)
  const linkIconObj = document.getElementById('linkIcon');          // <object id="linkIcon" data="...svg">
  const linkIconWrapper = document.getElementById('linkIconWrapper'); // wrapper div around the object

  // dropdown placeholders
  let dropdown1 = document.getElementById('dropdown1');
  let dropdown2 = document.getElementById('dropdown2');

  if (!dropdown1 && a1 && a1.parentElement) {
    dropdown1 = document.createElement('div');
    dropdown1.id = 'dropdown1';
    dropdown1.className = 'autocomplete-dropdown';
    dropdown1.style.display = 'none';
    a1.parentElement.appendChild(dropdown1);
  }
  if (!dropdown2 && a2 && a2.parentElement) {
    dropdown2 = document.createElement('div');
    dropdown2.id = 'dropdown2';
    dropdown2.className = 'autocomplete-dropdown';
    dropdown2.style.display = 'none';
    a2.parentElement.appendChild(dropdown2);
  }

  // ---------- SVG spinner control ----------
  if (linkIconObj) {
    linkIconObj.addEventListener('load', () => {
      try {
        const svgDoc = linkIconObj.contentDocument;
        if (svgDoc && svgDoc.documentElement && svgDoc.documentElement.pauseAnimations) {
          svgDoc.documentElement.pauseAnimations();
        }
      } catch (e) {
        console.debug('Spinner object load/pause error:', e);
      }
    });
  }

  function startLoader() {
    try {
      const svgDoc = linkIconObj && linkIconObj.contentDocument;
      if (svgDoc && svgDoc.documentElement && svgDoc.documentElement.unpauseAnimations) {
        svgDoc.documentElement.unpauseAnimations();
      }
    } catch (e) {
      console.debug('startLoader: could not unpause SVG:', e);
    }
    if (linkIconWrapper) linkIconWrapper.classList.add('loading');
    if (loadingEl) loadingEl.style.display = 'block';
  }

  function stopLoader() {
    try {
      const svgDoc = linkIconObj && linkIconObj.contentDocument;
      if (svgDoc && svgDoc.documentElement && svgDoc.documentElement.pauseAnimations) {
        svgDoc.documentElement.pauseAnimations();
      }
    } catch (e) {
      console.debug('stopLoader: could not pause SVG:', e);
    }
    if (linkIconWrapper) linkIconWrapper.classList.remove('loading');
    if (loadingEl) loadingEl.style.display = 'none';
  }

  // ---------- Audio player & playback state ----------
  const audioPlayer = new Audio();
  audioPlayer.preload = 'auto';
  let currentPlayingButton = null;
  let animationFrameId = null;

  function updatePlayButtonIcon(button, state) {
    if (!button) return;
    const icon = button.querySelector('img');
    if (!icon) return;
    if (state === 'play') {
      icon.src = '/static/images/play_button.png';
      icon.alt = 'Play Icon';
      button.setAttribute('aria-pressed', 'false');
    } else {
      icon.src = '/static/images/pause_button.png';
      icon.alt = 'Pause Icon';
      button.setAttribute('aria-pressed', 'true');
    }
  }

  function updateProgressCircle(button, progress) {
    if (!button) return;
    const container = button.closest('.play-button-container');
    if (!container) return;
    const circle = container.querySelector('.progress-circle');
    if (!circle) return;
    circle.style.setProperty('--progress', `${Math.max(0, Math.min(1, progress)) * 100}%`);
  }

  function animateProgress() {
    if (!currentPlayingButton || audioPlayer.paused || !audioPlayer.duration || isNaN(audioPlayer.duration)) {
      cancelAnimationFrame(animationFrameId);
      return;
    }
    const p = audioPlayer.currentTime / audioPlayer.duration;
    updateProgressCircle(currentPlayingButton, p);
    animationFrameId = requestAnimationFrame(animateProgress);
  }

  function stopCurrentPlayback() {
    if (currentPlayingButton) {
      updatePlayButtonIcon(currentPlayingButton, 'play');
      currentPlayingButton.classList.remove('is-playing');
      const prevContainer = currentPlayingButton.closest('.play-button-container');
      if (prevContainer) {
        const prevCircle = prevContainer.querySelector('.progress-circle');
        if (prevCircle) prevCircle.classList.remove('is-playing');
        updateProgressCircle(currentPlayingButton, 0);
      }
      currentPlayingButton = null;
    }
    audioPlayer.pause();
    audioPlayer.src = '';
    cancelAnimationFrame(animationFrameId);
  }

  audioPlayer.addEventListener('ended', () => {
    if (currentPlayingButton) {
      updatePlayButtonIcon(currentPlayingButton, 'play');
      currentPlayingButton.classList.remove('is-playing');
      const container = currentPlayingButton.closest('.play-button-container');
      if (container) {
        const circle = container.querySelector('.progress-circle');
        if (circle) circle.classList.remove('is-playing');
        updateProgressCircle(currentPlayingButton, 0);
      }
      currentPlayingButton = null;
      cancelAnimationFrame(animationFrameId);
    }
  });

  // ---------- Deezer fetch (cover + preview) with server fallback ----------
  const coverCache = new Map();
  const DEFAULT_COVER = '/static/images/default_cover.jpeg';

  async function fetchDeezerInfo(trackName, artistName) {
    if (!trackName) return { cover: null, preview: null };
    const key = `${trackName}||${artistName || ''}`;
    if (coverCache.has(key)) return coverCache.get(key);

    // Try direct Deezer (may be CORS-blocked)
    try {
      const q = encodeURIComponent(`${trackName} ${artistName || ''}`);
      const url = `https://api.deezer.com/search/track?q=${q}&limit=1`;
      const resp = await fetch(url);
      if (resp.ok) {
        const data = await resp.json();
        if (data && Array.isArray(data.data) && data.data.length > 0) {
          const it = data.data[0];
          const album = it.album || {};
          const cover = album.cover_xl || album.cover_big || album.cover_medium || album.cover || null;
          const preview = it.preview || null;
          const obj = { cover, preview };
          coverCache.set(key, obj);
          return obj;
        }
      }
    } catch (err) {
      console.debug('Deezer direct failed (likely CORS):', err);
    }

    // Fallback to server-side /api/cover
    try {
      const proxyUrl = '/api/cover?track=' + encodeURIComponent(trackName) + (artistName ? '&artist=' + encodeURIComponent(artistName) : '');
      const r = await fetch(proxyUrl);
      if (r.ok) {
        const j = await r.json();
        const obj = { cover: j.cover || null, preview: j.preview || null };
        coverCache.set(key, obj);
        return obj;
      }
    } catch (err) {
      console.debug('Server cover proxy failed:', err);
    }

    const none = { cover: null, preview: null };
    coverCache.set(key, none);
    return none;
  }

  // ---------- Search / Autocomplete ----------
  async function doSearch(q) {
    if (!q || !q.trim()) return [];
    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=10');
      if (!res.ok) return [];
      return await res.json();
    } catch (err) {
      console.error('Search error', err);
      return [];
    }
  }

  function renderDropdown(dropdownEl, items, inputEl) {
    dropdownEl.innerHTML = '';
    if (!items || items.length === 0) {
      dropdownEl.style.display = 'none';
      return;
    }
    items.forEach(it => {
      // it: { id, name, gid, release_count }
      const div = document.createElement('div');
      div.className = 'autocomplete-item';

      // Artist info block (use MBID = it.gid when present)
      const nameEl = document.createElement('div');
      nameEl.className = 'artist-name';
      nameEl.textContent = it.name || '';

      const detailsEl = document.createElement('div');
      detailsEl.className = 'artist-details';
      detailsEl.textContent = (it.release_count || 0) + ' releases';

      const mbidEl = document.createElement('div');
      mbidEl.className = 'artist-mbid';
      mbidEl.textContent = it.gid ? ('MBID: ' + String(it.gid)) : ('ID: ' + String(it.id));

      const infoWrap = document.createElement('div');
      infoWrap.className = 'artist-info';
      infoWrap.appendChild(nameEl);
      infoWrap.appendChild(detailsEl);
      infoWrap.appendChild(mbidEl);

      div.appendChild(infoWrap);

      // Click handler: set visible name and hidden internal id
      div.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        inputEl.value = it.name || '';
        const hid = document.getElementById(inputEl.id + '_id');
        if (hid) hid.value = String(it.id);
        // show thumbnail if provided by search (optional)
        const thumb = (inputEl.id === 'artist1') ? img1 : img2;
        if (thumb && it.image) {
          thumb.src = it.image;
          thumb.style.display = 'block';
        }
        dropdownEl.style.display = 'none';
      });

      dropdownEl.appendChild(div);
    });
    dropdownEl.style.display = 'block';
  }

  function setupAutocompleteFor(inputEl, dropdownEl) {
    if (!inputEl || !dropdownEl) return;
    const hid = document.getElementById(inputEl.id + '_id');

    const deb = debounce(async () => {
      const q = (inputEl.value || '').trim();
      if (!q) {
        dropdownEl.style.display = 'none';
        if (hid) hid.value = '';
        return;
      }
      const rows = await doSearch(q);
      renderDropdown(dropdownEl, rows, inputEl);
    }, 250);

    inputEl.addEventListener('input', () => {
      if (hid) hid.value = '';
      if (inputEl.id === 'artist1' && img1) { img1.style.display = 'none'; img1.src = ''; }
      if (inputEl.id === 'artist2' && img2) { img2.style.display = 'none'; img2.src = ''; }
      deb();
    });

    inputEl.addEventListener('focus', () => {
      if (dropdownEl.innerHTML) dropdownEl.style.display = 'block';
    });

    inputEl.addEventListener('blur', () => {
      setTimeout(() => { dropdownEl.style.display = 'none'; }, 150);
    });
  }

  // hide dropdowns on outside clicks
  document.addEventListener('click', (ev) => {
    [dropdown1, dropdown2].forEach(dd => {
      if (!dd) return;
      const wrapper = dd.parentElement;
      const input = wrapper && wrapper.querySelector('input[type="text"]');
      if (input && !wrapper.contains(ev.target)) dd.style.display = 'none';
    });
  });

  // ---------- Rendering results with centered overlay + safe image handling ----------
  async function renderResults(pathNodes) {
    stopCurrentPlayback();

    const enriched = await Promise.all(pathNodes.map(async (step, idx) => {
      const info = step.track ? await fetchDeezerInfo(step.track, step.from_name || '') : { cover: null, preview: null };
      return Object.assign({}, step, { cover: info.cover, preview: info.preview, stepNumber: idx + 1 });
    }));

    // Build markup (we'll post-process images to attach handlers)
    let html = `<div class="results-header">Found path — ${enriched.length} degrees</div>`;
    html += '<div class="path-container">';

    enriched.forEach(s => {
      html += `<div class="connection-step">`;
      html += `<div class="step-number">${s.stepNumber}</div>`;
      html += `<div class="track-cover-wrapper">`;

      // always render an <img> (cover if present else DEFAULT_COVER later)
      const coverSrcEsc = escapeHtml(s.cover || DEFAULT_COVER);
      // include data-preview attribute on wrapper/button; we'll attach listeners later
      html += `<img class="track-cover" data-cover-src="${coverSrcEsc}" alt="${escapeHtml(s.track || '')}" />`;

      if (s.preview) {
        html += `
          <div class="play-button-container" aria-hidden="false">
            <div class="progress-circle"></div>
            <button class="play-button" aria-label="Play preview" aria-pressed="false" data-preview="${escapeHtml(s.preview)}">
              <img src="/static/images/play_button.png" alt="Play" class="play-icon" />
            </button>
          </div>
        `;
      } else {
        html += `<div class="play-button-container" aria-hidden="true"></div>`;
      }

      html += `</div>`; // track-cover-wrapper

      if (s.track) html += `<div class="track-name">"${escapeHtml(s.track)}"</div>`;
      html += `<div class="artist-names">${escapeHtml(s.from_name || '')} &amp; ${escapeHtml(s.to_name || '')}</div>`;

      if (s.track) {
        const urls = generateMusicServiceUrls(s.track, `${s.from_name || ''} ${s.to_name || ''}`);
        html += `<div class="music-services">
                   <img src="/static/images/spotify-icon.png" alt="Spotify" class="service-icon spotify" onclick="window.open('${urls.spotify}', '_blank')" />
                   <img src="/static/images/youtube-icon.png" alt="YouTube" class="service-icon youtube" onclick="window.open('${urls.youtube}', '_blank')" />
                   <img src="/static/images/apple-icon.png" alt="Apple" class="service-icon apple" onclick="window.open('${urls.apple}', '_blank')" />
                 </div>`;
      }

      html += `</div>`; // connection-step
    });

    html += `</div>`; // path-container

    // footer
    html += `
      <footer>
        <div class="footer-buttons">
          <button id="refreshBtn" title="Refresh Page" aria-label="Refresh Page">
            <img src="/static/images/restart_icon.svg" alt="Restart" />
          </button>
          <button id="tryAgainBtn">Try Another Route</button>
          <button id="shareBtn" title="Share" aria-label="Share">
            <img src="/static/images/share_icon.svg" alt="Share" />
          </button>
        </div>
      </footer>
    `;

    resultsEl.innerHTML = html;

    // Post-process images to set src and attach load/error handlers
    resultsEl.querySelectorAll('img.track-cover').forEach(imgEl => {
      const coverSrc = imgEl.getAttribute('data-cover-src') || DEFAULT_COVER;

      // define error handler once
      const onError = function () {
        // if it's already the default, just mark as has-image
        try {
          if (!imgEl.dataset._errored) {
            imgEl.dataset._errored = '1';
            if (coverSrc !== DEFAULT_COVER) {
              imgEl.src = DEFAULT_COVER;
            } else {
              imgEl.classList.add('has-image');
            }
          } else {
            // already errored and default failed — just hide gradient by adding class
            imgEl.classList.add('has-image');
          }
        } catch (e) {
          console.debug('img error handler failed', e);
        }
      };

      // load handler
      const onLoad = function () {
        imgEl.classList.add('has-image');
      };

      // attach, then set src
      imgEl.addEventListener('error', onError);
      imgEl.addEventListener('load', onLoad);

      // set src last to trigger load/error
      imgEl.src = coverSrc;
    });

    // footer wiring
    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => window.location.reload());

    const tryBtn = document.getElementById('tryAgainBtn');
    if (tryBtn) tryBtn.addEventListener('click', () => {
      resultsEl.innerHTML = '';
      if (form) form.reset();
      if (hid1) hid1.value = '';
      if (hid2) hid2.value = '';
      if (img1) { img1.style.display = 'none'; img1.src = ''; }
      if (img2) { img2.style.display = 'none'; img2.src = ''; }
    });

    const shareBtn = document.getElementById('shareBtn');
    if (shareBtn) shareBtn.addEventListener('click', () => {
      const artistA = a1 ? a1.value.trim() : '';
      const artistB = a2 ? a2.value.trim() : '';
      const shareTitle = `What connects ${artistA} with ${artistB}?`;
      const shareUrl = window.location.href;
      if (navigator.share) {
        navigator.share({ title: shareTitle, url: shareUrl }).catch(console.error);
      } else {
        navigator.clipboard.writeText(shareUrl).then(() => alert('Link copied to clipboard!')).catch(() => {
          alert(`${shareTitle}\n${shareUrl}`);
        });
      }
    });

    // Attach play button handlers
    resultsEl.querySelectorAll('.play-button').forEach(button => {
      button.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const previewUrl = button.dataset.preview;
        if (!previewUrl) return;

        // toggle / resume / pause logic
        if (currentPlayingButton === button) {
          if (!audioPlayer.paused) {
            audioPlayer.pause();
            updatePlayButtonIcon(button, 'play');
            button.classList.remove('is-playing');
            const container = button.closest('.play-button-container');
            container && container.querySelector('.progress-circle') && container.querySelector('.progress-circle').classList.remove('is-playing');
            updateProgressCircle(button, 0);
            cancelAnimationFrame(animationFrameId);
            return;
          } else {
            audioPlayer.play().catch(err => console.error('Playback resume failed', err));
            updatePlayButtonIcon(button, 'pause');
            button.classList.add('is-playing');
            const container = button.closest('.play-button-container');
            container && container.querySelector('.progress-circle') && container.querySelector('.progress-circle').classList.add('is-playing');
            animationFrameId = requestAnimationFrame(animateProgress);
            return;
          }
        }

        // stop previous if any
        if (currentPlayingButton && currentPlayingButton !== button) {
          updatePlayButtonIcon(currentPlayingButton, 'play');
          currentPlayingButton.classList.remove('is-playing');
          const prevContainer = currentPlayingButton.closest('.play-button-container');
          if (prevContainer) {
            const prevCircle = prevContainer.querySelector('.progress-circle');
            if (prevCircle) prevCircle.classList.remove('is-playing');
            updateProgressCircle(currentPlayingButton, 0);
          }
        }

        // start playing this preview
        currentPlayingButton = button;
        try {
          audioPlayer.src = previewUrl;
          audioPlayer.currentTime = 0;
          await audioPlayer.play();
        } catch (err) {
          console.error('Playback start failed:', err);
          currentPlayingButton = null;
          return;
        }

        updatePlayButtonIcon(button, 'pause');
        button.classList.add('is-playing');

        const container = button.closest('.play-button-container');
        if (container) {
          const circle = container.querySelector('.progress-circle');
          circle && circle.classList.add('is-playing');
        }
        cancelAnimationFrame(animationFrameId);
        animationFrameId = requestAnimationFrame(animateProgress);
      });
    });

    // ensure loading spinner is stopped once results are displayed
    stopLoader();

    // scroll to results
    resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- Form submit ----------
  if (form) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      resultsEl.innerHTML = '';
      if (!hid1 || !hid2) return;
      if (!hid1.value) { shakeElement(a1); a1.focus(); return; }
      if (!hid2.value) { shakeElement(a2); a2.focus(); return; }

      startLoader();
      findBtn.disabled = true;

      try {
        const payload = { source_id: parseInt(hid1.value, 10), target_id: parseInt(hid2.value, 10) };
        const resp = await fetch('/api/path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!resp.ok) {
          let errText = 'Error finding connection.';
          try { const j = await resp.json(); errText = j.detail || j.error || errText; } catch (_) {}
          resultsEl.innerHTML = `<div class="results-header">${escapeHtml(errText)}</div>`;
          return;
        }

        const data = await resp.json();
        if (!data.found) {
          resultsEl.innerHTML = `<div class="results-header">No connection found (took ${data.seconds || 'N/A'}s)</div>`;
          return;
        }

        const norm = (data.path || []).map(step => ({
          from_name: step.from_name || step.from || '',
          to_name: step.to_name || step.to || '',
          track: step.track || ''
        }));

        await renderResults(norm);

      } catch (err) {
        console.error('Submit error', err);
        resultsEl.innerHTML = '<div class="results-header">Unexpected error — check console</div>';
      } finally {
        stopLoader();
        findBtn.disabled = false;
      }
    });
  }

  // ---------- Init ----------
  if (a1 && a2 && dropdown1 && dropdown2) {
    setupAutocompleteFor(a1, dropdown1);
    setupAutocompleteFor(a2, dropdown2);
  } else {
    console.warn('Autocomplete inputs or dropdowns missing; autocomplete not initialized.');
  }

  console.log('SDOS main.js ready.');
})();
