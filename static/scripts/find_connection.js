// static/scripts/find_connection.js
// SDOS frontend: artist autocomplete, route finding/rendering, audio previews, sharing.

(function () {
  // ---------- Constants ----------
  const DEFAULT_COVER = '/static/images/default_cover.jpeg';
  const PLAY_ICON = '/static/images/play_button.png';
  const PAUSE_ICON = '/static/images/pause_button.png';

  const RESULTS_SCROLL_OFFSET = 72;   // px of breathing room above results when scrolling
  const LINK_GRADIENT_DURATION = 500; // ms per full rotation of the loading gradient
  const FADE_STEP_DELAY = 400;        // ms stagger between route steps

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };

  // ---------- Utilities ----------
  function debounce(fn, wait = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (m) => HTML_ESCAPES[m]);
  }

  function shakeElement(el) {
    if (!el) return;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 420);
  }

  function normalizeMusicText(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function buildServiceUrls(track, fromName, toName) {
    const query = encodeURIComponent([track, fromName, toName].filter(Boolean).join(' '));
    const mbQuery = encodeURIComponent(`recording:${track} AND artist:${fromName}`);

    return {
      musicbrainz: `https://musicbrainz.org/search?query=${mbQuery}&type=recording`,
      spotify: `https://open.spotify.com/search/${query}`,
      youtube: `https://www.youtube.com/results?search_query=${query}`,
      apple: `https://music.apple.com/us/search?term=${query}`
    };
  }

  // ---------- Loading icon (animated gradient on the link icon) ----------
  const flowGradient = document.getElementById('flowGradient');
  let isLinkIconLoading = false;
  let linkGradientFrame = null;
  let linkGradientAngle = 0;
  let linkGradientLastTime = null;

  function animateLinkIcon(timestamp) {
    if (!isLinkIconLoading) {
      linkGradientFrame = null;
      linkGradientLastTime = null;
      return;
    }

    if (linkGradientLastTime !== null) {
      const elapsed = timestamp - linkGradientLastTime;
      linkGradientAngle = (linkGradientAngle + elapsed * 360 / LINK_GRADIENT_DURATION) % 360;
    }

    linkGradientLastTime = timestamp;

    if (flowGradient) {
      flowGradient.setAttribute('gradientTransform', `rotate(${linkGradientAngle} 40 20)`);
    }

    linkGradientFrame = requestAnimationFrame(animateLinkIcon);
  }

  function startLoadingAnimation() {
    if (isLinkIconLoading) return;

    isLinkIconLoading = true;
    linkGradientLastTime = null;
    linkGradientFrame = requestAnimationFrame(animateLinkIcon);
  }

  function stopLoadingAnimation() {
    isLinkIconLoading = false;
    linkGradientLastTime = null;

    if (linkGradientFrame !== null) {
      cancelAnimationFrame(linkGradientFrame);
      linkGradientFrame = null;
    }
  }

  // ---------- DOM elements ----------
  const a1 = document.getElementById('artist1');
  const a2 = document.getElementById('artist2');
  const hid1 = document.getElementById('artist1_id');
  const hid2 = document.getElementById('artist2_id');
  const img1 = document.getElementById('selected-artist1-img');
  const img2 = document.getElementById('selected-artist2-img');
  const resultsEl = document.getElementById('results');
  const findBtn = document.getElementById('findBtn');
  const form = document.getElementById('connectionForm');

  // Create the autocomplete dropdowns if the HTML doesn't include them
  function ensureDropdown(id, inputEl) {
    let dropdown = document.getElementById(id);
    if (!dropdown && inputEl && inputEl.parentElement) {
      dropdown = document.createElement('div');
      dropdown.id = id;
      dropdown.className = 'autocomplete-dropdown';
      dropdown.style.display = 'none';
      inputEl.parentElement.appendChild(dropdown);
    }
    return dropdown;
  }

  const dropdown1 = ensureDropdown('dropdown1', a1);
  const dropdown2 = ensureDropdown('dropdown2', a2);

  // ---------- Cover + preview lookup (cached) ----------
  const coverCache = new Map();

  async function fetchTrackInfo(trackName, artist1, artist2) {
    if (!trackName) return { cover: null, preview: null };

    const artists = [artist1, artist2].filter(Boolean).sort();
    const key =
      `${normalizeMusicText(trackName)}||` +
      artists.map(normalizeMusicText).join('||');

    if (coverCache.has(key)) return coverCache.get(key);

    const none = { cover: null, preview: null };

    try {
      const params = new URLSearchParams({
        track: trackName,
        artist1: artist1 || '',
        artist2: artist2 || ''
      });

      const response = await fetch(`/api/cover?${params.toString()}`);

      if (!response.ok) {
        console.debug('Cover lookup returned:', response.status);
        coverCache.set(key, none);
        return none;
      }

      const data = await response.json();
      const result = {
        cover: data.cover || null,
        preview: data.preview || null
      };

      coverCache.set(key, result);
      return result;
    } catch (error) {
      console.debug('Cover lookup failed:', error);
      coverCache.set(key, none);
      return none;
    }
  }

  // ---------- Search / Autocomplete ----------
  async function doSearch(q) {
    if (!q || !q.trim()) return [];
    try {
      const res = await fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=10');
      if (!res.ok) {
        console.error('/api/search failed', res.status);
        return [];
      }
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

    items.forEach((it) => {
      const div = document.createElement('div');
      div.className = 'autocomplete-item';
      const mbidText = it.gid
        ? 'MBID: ' + escapeHtml(String(it.gid))
        : 'ID: ' + escapeHtml(String(it.id));

      div.innerHTML = `
        <div class="artist-info">
          <div class="artist-name">${escapeHtml(it.name)}</div>
          <div class="artist-details">${it.release_count} releases</div>
          <div class="artist-mbid">${mbidText}</div>
        </div>
      `;

      // mousedown (not click) so it fires before the input's blur hides the dropdown
      div.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        inputEl.value = it.name;

        const hid = document.getElementById(inputEl.id + '_id');
        if (hid) hid.value = it.id;

        const thumb = inputEl.id === 'artist1' ? img1 : img2;
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
    let searchVersion = 0;

    const deb = debounce(async () => {
      const q = (inputEl.value || '').trim();
      const version = searchVersion;

      if (!q) {
        dropdownEl.innerHTML = '';
        dropdownEl.style.display = 'none';
        if (hid) hid.value = '';
        return;
      }

      const rows = await doSearch(q);

      // Ignore results from an older search, or if the input has since changed.
      if (version !== searchVersion) return;
      if (q !== inputEl.value.trim()) return;

      renderDropdown(dropdownEl, rows, inputEl);
    }, 200);

    inputEl.addEventListener('input', () => {
      // Invalidate any search already in progress.
      searchVersion++;

      // Typing invalidates the previously selected artist.
      if (hid) hid.value = '';

      const thumb = inputEl.id === 'artist1' ? img1 : inputEl.id === 'artist2' ? img2 : null;
      if (thumb) {
        thumb.style.display = 'none';
        thumb.src = '';
      }

      // Don't show outdated results while waiting for the new search.
      dropdownEl.style.display = 'none';
      deb();
    });

    inputEl.addEventListener('focus', () => {
      if (dropdownEl.innerHTML && inputEl.value.trim()) {
        dropdownEl.style.display = 'block';
      }
    });

    inputEl.addEventListener('blur', () => {
      setTimeout(() => { dropdownEl.style.display = 'none'; }, 150);
    });
  }

  // Hide dropdowns when clicking outside (iOS Safari doesn't always blur inputs on tap)
  document.addEventListener('click', (ev) => {
    [dropdown1, dropdown2].forEach((dd) => {
      if (!dd) return;
      const wrapper = dd.parentElement;
      const input = wrapper && wrapper.querySelector('input[type="text"]');
      if (input && !wrapper.contains(ev.target)) dd.style.display = 'none';
    });
  });

  // ---------- Scrolling ----------
  function scrollToElementWithOffset(el, offset, behavior = 'smooth') {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    window.scrollTo({ top: window.scrollY + rect.top - offset, behavior });
  }

  // Smoothly scrolls every scrollable root (window, html, body, scrollable containers) to the top.
  function glideToTop(duration = 450) {
    return new Promise((resolve) => {
      const scrollTargets = new Set([
        window,
        document.documentElement,
        document.body,
        document.scrollingElement
      ]);

      document.querySelectorAll('*').forEach((el) => {
        const style = window.getComputedStyle(el);
        if (
          el.scrollHeight > el.clientHeight + 1 &&
          ['auto', 'scroll', 'hidden', 'overlay'].includes(style.overflowY)
        ) {
          scrollTargets.add(el);
        }
      });

      const roots = Array.from(scrollTargets);
      const startPositions = new Map();

      roots.forEach((el) => {
        if (el === window) {
          startPositions.set(el, window.scrollY);
        } else if (el) {
          startPositions.set(el, el.scrollTop);
        }
      });

      const maxStart = Math.max(0, ...startPositions.values());

      if (maxStart <= 2) {
        resolve();
        return;
      }

      const startTime = performance.now();

      function setScroll(el, position) {
        if (el === window) {
          window.scrollTo(0, position);
        } else if (el) {
          el.scrollTop = position;
        }
      }

      function step(now) {
        const progress = Math.min(1, (now - startTime) / duration);

        // Ease in and out for a natural glide.
        const eased = progress < 0.5
          ? 4 * progress * progress * progress
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        roots.forEach((el) => {
          const start = startPositions.get(el) || 0;
          setScroll(el, Math.round(start * (1 - eased)));
        });

        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          roots.forEach((el) => setScroll(el, 0));
          resolve();
        }
      }

      requestAnimationFrame(step);
    });
  }

  // ---------- Route management ----------
  const foundRoutes = [];
  let cycleIndex = 0;

  function normalizePath(path) {
    return path.map((step) => ({
      from_id: step.from_id,
      to_id: step.to_id,
      from_name: step.from_name,
      to_name: step.to_name,
      track: step.track,
      to_mbid: step.to_mbid
    }));
  }

  function pathToPairsString(path) {
    if (!Array.isArray(path) || path.length === 0) return '';
    return path.map((s) => `${s.from_id || ''}->${s.to_id || ''}`).join('|');
  }

  // Every edge used by any route found so far (sent to the server as exclusions).
  function unionEdgesFromFoundRoutes() {
    const set = new Set();
    foundRoutes.forEach((route) => {
      (route.path || []).forEach((step) => {
        const a = parseInt(step.from_id, 10);
        const b = parseInt(step.to_id, 10);
        if (!isNaN(a) && !isNaN(b)) {
          set.add(a < b ? `${a},${b}` : `${b},${a}`);
        }
      });
    });
    return Array.from(set).map((s) => s.split(',').map((x) => parseInt(x, 10)));
  }

  // ---------- Audio previews ----------
  const audio = new Audio();
  audio.preload = 'auto';
  let currentBtn = null;
  let currentAnim = null;

  function getRing(btn) {
    const container = btn && btn.closest('.play-button-container');
    return container ? container.querySelector('.progress-circle') : null;
  }

  // Keeps the button, its icon, aria state, and progress ring in sync.
  function setButtonState(btn, playing) {
    if (!btn) return;

    btn.classList.toggle('is-playing', playing);
    btn.setAttribute('aria-pressed', String(playing));
    btn.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');

    const icon = btn.querySelector('.play-icon');
    if (icon) {
      icon.alt = playing ? 'Pause' : 'Play';
      if (PAUSE_ICON) icon.src = playing ? PAUSE_ICON : PLAY_ICON;
    }

    const ring = getRing(btn);
    if (ring) {
      ring.style.opacity = playing ? '1' : '0';
      ring.classList.toggle('is-playing', playing);
    }
  }

  function updateProgress() {
    if (!currentBtn || !audio.duration || isNaN(audio.duration)) return;
    const ring = getRing(currentBtn);
    if (!ring) return;

    const pct = Math.max(0, Math.min(1, audio.currentTime / audio.duration)) * 100;
    ring.style.background =
      `conic-gradient(rgba(255,255,255,0.73) ${pct}%, transparent ${pct}%)`;
  }

  function animLoop() {
    if (!currentBtn || audio.paused) {
      cancelAnimationFrame(currentAnim);
      return;
    }
    updateProgress();
    currentAnim = requestAnimationFrame(animLoop);
  }

  function stopCurrentAudio() {
    if (!audio.paused) audio.pause();
    audio.currentTime = 0;

    cancelAnimationFrame(currentAnim);
    setButtonState(currentBtn, false);

    currentAnim = null;
    currentBtn = null;
  }

  audio.addEventListener('ended', () => {
    if (!currentBtn) return;
    setButtonState(currentBtn, false);
    cancelAnimationFrame(currentAnim);
    currentBtn = null;
  });

  async function togglePreview(btn) {
    const preview = btn.dataset.preview;
    if (!preview) return;

    // Same button: pause or resume.
    if (currentBtn === btn) {
      if (!audio.paused) {
        audio.pause();
        setButtonState(btn, false);
        cancelAnimationFrame(currentAnim);
      } else {
        await audio.play().catch((e) => console.error('resume failed', e));
        setButtonState(btn, true);
        currentAnim = requestAnimationFrame(animLoop);
      }
      return;
    }

    // Different button: reset the previous one, then start this one.
    if (currentBtn) setButtonState(currentBtn, false);

    currentBtn = btn;
    audio.src = preview;
    audio.currentTime = 0;

    try {
      await audio.play();
    } catch (err) {
      console.error('play failed', err);
      currentBtn = null;
      return;
    }

    setButtonState(btn, true);
    currentAnim = requestAnimationFrame(animLoop);
  }

  // ---------- Rendering ----------
  // Fade steps in one after another. Also used after renders that skipped the animation.
  function animateFadeIn() {
    if (!resultsEl) return;
    const steps = Array.from(resultsEl.querySelectorAll('.fade-step'));
    steps.forEach((el) => el.classList.remove('visible'));
    steps.forEach((el, i) => {
      setTimeout(() => el.classList.add('visible'), i * FADE_STEP_DELAY);
    });
  }

  // 3D album-cover tilt (hover-capable devices only)
  function attachCoverTilt() {
    const supportsHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (!supportsHover || !resultsEl) return;

    const maxTilt = 18;

    resultsEl.querySelectorAll('.track-cover-wrapper').forEach((wrapper) => {
      wrapper.addEventListener('pointermove', (event) => {
        const rect = wrapper.getBoundingClientRect();

        // Normalize cursor position from -1 to +1.
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = ((event.clientY - rect.top) / rect.height) * 2 - 1;

        // Reversed so the corner under the cursor dips away from the viewer.
        wrapper.style.setProperty('--tilt-x', `${-y * maxTilt}deg`);
        wrapper.style.setProperty('--tilt-y', `${x * maxTilt}deg`);
      });

      wrapper.addEventListener('pointerleave', () => {
        wrapper.style.setProperty('--tilt-x', '0deg');
        wrapper.style.setProperty('--tilt-y', '0deg');
      });
    });
  }

  function buildStepHtml(s) {
    const track = escapeHtml(s.track || '');
    const fromName = escapeHtml(s.from_name || '');
    const toName = escapeHtml(s.to_name || '');
    const coverUrl = escapeHtml(s.cover || DEFAULT_COVER);

    const playControl = s.preview
      ? `<button class="play-button" aria-label="Play preview" aria-pressed="false" data-preview="${escapeHtml(s.preview)}" style="width:56px; height:56px; border-radius:50%; display:flex; align-items:center; justify-content:center; background:rgba(255,255,255,0.6); border:none; cursor:pointer;">
           <img src="${PLAY_ICON}" alt="Play" class="play-icon" style="width:28px;height:28px;pointer-events:none;">
         </button>`
      : `<div style="width:56px; height:56px; border-radius:50%; background:rgba(255,255,255,0.45); display:flex; align-items:center; justify-content:center;">
           <img src="${PLAY_ICON}" alt="" style="width:20px; height:20px; opacity:0.6;">
         </div>`;

    let services = '';
    if (s.track) {
      const urls = buildServiceUrls(s.track, s.from_name || '', s.to_name || '');
      services = `
        <div class="music-services">
          <img src="/static/images/music-brainz-icon.svg" alt="MusicBrainz" class="service-icon mb" data-url="${escapeHtml(urls.musicbrainz)}" />
          <img src="/static/images/apple-icon.png" alt="Apple Music" class="service-icon apple" data-url="${escapeHtml(urls.apple)}" />
          <img src="/static/images/spotify-icon.png" alt="Spotify" class="service-icon spotify" data-url="${escapeHtml(urls.spotify)}" />
          <img src="/static/images/youtube-icon.png" alt="YouTube" class="service-icon youtube" data-url="${escapeHtml(urls.youtube)}" />
        </div>`;
    }

    return `
      <div class="connection-step fade-step" data-fromid="${escapeHtml(s.from_id || '')}" data-toid="${escapeHtml(s.to_id || '')}">
        <div class="step-number">${s.stepNumber}</div>
        <div class="track-cover-wrapper" style="position:relative; width:200px; height:200px; margin:0 auto 12px auto;">
          <img src="${coverUrl}" alt="${track}" class="track-cover" style="width:100%; height:100%; border-radius:12px; object-fit:cover;" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'">
          <div class="play-button-container" aria-hidden="${s.preview ? 'false' : 'true'}" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:auto;">
            <div class="progress-circle"></div>
            ${playControl}
          </div>
        </div>
        ${s.track ? `<div class="track-name">${track}</div>` : ''}
        <div class="artist-names">${fromName} &amp; ${toName}</div>
        ${services}
      </div>`;
  }

  function buildFooterHtml() {
    return `
      <footer>
        <div class="footer-buttons">
          <button id="refreshBtn" title="Refresh Page" aria-label="Refresh Page"><img src="/static/images/restart_icon.svg" alt="Restart"/></button>
          <button id="tryAgainBtn">Try Another Route</button>
          <button id="shareBtn" title="Share" aria-label="Share"><img src="/static/images/share_icon.svg" alt="Share"/></button>
        </div>
      </footer>`;
  }

  async function renderPathWithCovers(serverPath, animate = true) {
    const enriched = await Promise.all(
      serverPath.map(async (step, idx) => {
        const info = step.track
          ? await fetchTrackInfo(step.track, step.from_name || '', step.to_name || '')
          : { cover: null, preview: null };

        return { ...step, cover: info.cover, preview: info.preview, stepNumber: idx + 1 };
      })
    );

    if (resultsEl) {
      resultsEl.innerHTML =
        `<div class="path-container">${enriched.map(buildStepHtml).join('')}</div>` +
        buildFooterHtml();
    }

    attachCoverTilt();
    if (animate) animateFadeIn();
  }

  // ---------- Results actions (handled by one delegated click listener) ----------
  async function shareRoute() {
    const artistA = a1 ? a1.value.trim() : '';
    const artistB = a2 ? a2.value.trim() : '';

    if (!artistA || !artistB) {
      alert('Please select two artists before sharing.');
      return;
    }

    const shareTitle = `What connects ${artistA} with ${artistB}?`;

    const shareUrl = new URL(window.location.origin + window.location.pathname);
    shareUrl.searchParams.set('artist1', artistA);
    shareUrl.searchParams.set('artist2', artistB);
    const url = shareUrl.toString();

    if (navigator.share) {
      try {
        await navigator.share({ title: shareTitle, text: shareTitle, url });
      } catch (error) {
        if (error.name !== 'AbortError') console.error('Sharing failed:', error);
      }
    } else {
      try {
        await navigator.clipboard.writeText(`${shareTitle}\n${url}`);
        alert('Question and link copied!');
      } catch (error) {
        prompt('Copy this question and link:', `${shareTitle}\n${url}`);
      }
    }
  }

  async function showNextFoundRoute() {
    cycleIndex = (cycleIndex + 1) % foundRoutes.length;
    await renderPathWithCovers(foundRoutes[cycleIndex].path, false);
    animateFadeIn();
  }

  async function tryAnotherRoute() {
    stopCurrentAudio();

    if (foundRoutes.length === 0) {
      if (resultsEl) resultsEl.innerHTML = '';
      if (form) form.reset();
      return;
    }

    const exclude_edges = unionEdgesFromFoundRoutes();

    startLoadingAnimation();
    if (findBtn) findBtn.disabled = true;

    try {
      const last = foundRoutes[foundRoutes.length - 1];
      const source = parseInt(last.path[0].from_id, 10);
      const target = parseInt(last.path[last.path.length - 1].to_id, 10);

      const resp = await fetch('/api/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: source, target_id: target, exclude_edges })
      });

      if (!resp.ok) {
        let err = 'Error attempting alternative route';
        try {
          const j = await resp.json();
          err = j.detail || j.error || err;
        } catch (e) { /* keep default message */ }
        if (resultsEl) resultsEl.innerHTML = `<div class="results-header">${escapeHtml(err)}</div>`;
        return;
      }

      const data = await resp.json();

      // No new route exists: cycle back through the ones already found.
      if (!data.found) {
        await showNextFoundRoute();
        return;
      }

      // The server returned a route we've already shown: cycle instead.
      const newPairs = pathToPairsString(data.path || []);
      if (foundRoutes.some((r) => pathToPairsString(r.path) === newPairs)) {
        await showNextFoundRoute();
        return;
      }

      const normalized = normalizePath(data.path);
      foundRoutes.push({ path: normalized });
      cycleIndex = foundRoutes.length - 1;
      await renderPathWithCovers(normalized, false);
      animateFadeIn();

    } catch (err) {
      console.error('tryAnotherRoute error', err);
      if (resultsEl) resultsEl.innerHTML = '<div class="results-header">Unexpected error finding alternative route</div>';
    } finally {
      stopLoadingAnimation();
      if (findBtn) findBtn.disabled = false;
    }
  }

  async function handleTryAnother() {
    // Glide to the top first, then search once scrolling finishes.
    await glideToTop(850);
    tryAnotherRoute();
  }

  function handleResultsClick(ev) {
    const target = ev.target;

    const playBtn = target.closest('.play-button');
    if (playBtn) {
      ev.preventDefault();
      togglePreview(playBtn);
      return;
    }

    const serviceIcon = target.closest('.service-icon');
    if (serviceIcon && serviceIcon.dataset.url) {
      window.open(serviceIcon.dataset.url, '_blank', 'noopener');
      return;
    }

    if (target.closest('#refreshBtn')) {
      window.location.href = '/';
    } else if (target.closest('#tryAgainBtn')) {
      handleTryAnother();
    } else if (target.closest('#shareBtn')) {
      shareRoute();
    }
  }

  // ---------- Form submit ----------
  if (form) {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (resultsEl) resultsEl.innerHTML = '';

      if (!hid1 || !hid2) return;
      if (!hid1.value) { shakeElement(a1); a1.focus(); return; }
      if (!hid2.value) { shakeElement(a2); a2.focus(); return; }

      stopCurrentAudio();
      startLoadingAnimation();
      if (findBtn) findBtn.disabled = true;

      try {
        const payload = {
          source_id: parseInt(hid1.value, 10),
          target_id: parseInt(hid2.value, 10)
        };

        const resp = await fetch('/api/path', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (!resp.ok) {
          let errText = 'Error finding connection.';
          try {
            const j = await resp.json();
            errText = j.detail || j.error || errText;
          } catch (e) { /* keep default message */ }
          if (resultsEl) resultsEl.innerHTML = `<div class="results-header">${escapeHtml(errText)}</div>`;
          return;
        }

        const data = await resp.json();

        if (!data.found) {
          if (resultsEl) resultsEl.innerHTML = '<div class="results-header">No connection found!</div>';
          return;
        }

        foundRoutes.length = 0;
        cycleIndex = 0;

        const normalized = normalizePath(data.path);
        foundRoutes.push({ path: normalized });

        await renderPathWithCovers(normalized, true);
        scrollToElementWithOffset(resultsEl.querySelector('.connection-step'), RESULTS_SCROLL_OFFSET);

      } catch (err) {
        console.error('Submit error', err);
        if (resultsEl) resultsEl.innerHTML = '<div class="results-header">Unexpected error - check console</div>';
      } finally {
        stopLoadingAnimation();
        if (findBtn) findBtn.disabled = false;
      }
    });
  }

  // ---------- Shared links (?artist1=...&artist2=...) ----------
  async function findExactArtist(name) {
    const matches = await doSearch(name);
    return matches.find((artist) => artist.name.toLowerCase() === name.toLowerCase());
  }

  async function loadSharedRoute() {
    const params = new URLSearchParams(window.location.search);
    const artistA = params.get('artist1');
    const artistB = params.get('artist2');

    if (!artistA || !artistB || !a1 || !a2 || !hid1 || !hid2 || !form) return;

    let submitted = false;

    a1.value = artistA;
    a2.value = artistB;

    if (findBtn) findBtn.disabled = true;
    startLoadingAnimation();

    try {
      const [matchA, matchB] = await Promise.all([
        findExactArtist(artistA),
        findExactArtist(artistB)
      ]);

      if (!matchA || !matchB) {
        if (resultsEl) {
          resultsEl.textContent =
            'Could not find one or both artists from this shared link. Please select them manually.';
        }
        return;
      }

      // Fill in the verified names and IDs, then let the form handler do the rest.
      a1.value = matchA.name;
      a2.value = matchB.name;
      hid1.value = matchA.id;
      hid2.value = matchB.id;

      form.requestSubmit();
      submitted = true;

    } catch (error) {
      console.error('Could not load shared route:', error);
      if (resultsEl) {
        resultsEl.textContent =
          'Could not load this shared connection. Please try searching manually.';
      }
    } finally {
      // Only clean up here if form submission never started (it cleans up after itself).
      if (!submitted) {
        stopLoadingAnimation();
        if (findBtn) findBtn.disabled = false;
      }
    }
  }

  // ---------- Init ----------
  if (a1 && a2 && dropdown1 && dropdown2) {
    setupAutocompleteFor(a1, dropdown1);
    setupAutocompleteFor(a2, dropdown2);
  } else {
    console.warn('Autocomplete inputs or dropdowns missing; autocomplete not initialized.');
  }

  if (resultsEl) resultsEl.addEventListener('click', handleResultsClick);

  loadSharedRoute();
})();