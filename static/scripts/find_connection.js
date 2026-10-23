// static/js/main.js
// SDOS frontend main script - forced smooth scroll to absolute top with aggressive writes
console.log('SDOS main.js starting...');

  function stopCurrentAudio() {
    const audio = window._sdos_audio;

    if (!audio) return;

    if (!audio.paused) {
      audio.pause();
    }

    audio.currentTime = 0;

    if (window._sdos_currentAnim) {
      cancelAnimationFrame(window._sdos_currentAnim);
    }

    window._sdos_currentAnim = null;
    window._sdos_currentBtn = null;
  }

(function () {
  // ---------- Utilities ----------
  function debounce(fn, wait = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (m) {
      return ({ '&': '&', '<': '<', '>': '>', '"': '"', "'": "'" })[m];
    });
  }

  function shakeElement(el) {
    if (!el) return;
    el.classList.add('shake');
    setTimeout(() => el.classList.remove('shake'), 420);
  }


  function generateMusicServiceUrls(trackName, artistName) {
      const query = encodeURIComponent(
        `${trackName} ${artistName}`
      ).replace(/'/g, '%27');

      return {
        spotify: `https://open.spotify.com/search/${query}`,
        youtube: `https://www.youtube.com/results?search_query=${query}`,
        apple: `https://music.apple.com/us/search?term=${query}`,
      };
  }



  // ---------- Loading icon control ----------

  let isLinkIconLoading = false;
  let linkGradientFrame = null;
  let linkGradientAngle = 0;
  let linkGradientLastTime = null;

  const LINK_GRADIENT_DURATION = 500;

  function animateLinkIcon(timestamp) {
    if (!isLinkIconLoading) {
      linkGradientFrame = null;
      linkGradientLastTime = null;
      return;
    }

    if (linkGradientLastTime !== null) {
      const elapsed = timestamp - linkGradientLastTime;

      linkGradientAngle =
        (linkGradientAngle +
          elapsed * 360 / LINK_GRADIENT_DURATION) % 360;
    }

    linkGradientLastTime = timestamp;

    const gradient = document.getElementById('flowGradient');

    if (gradient) {
      gradient.setAttribute(
        'gradientTransform',
        `rotate(${linkGradientAngle} 40 20)`
      );
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
  const loadingEl = document.getElementById('loading');
  const findBtn = document.getElementById('findBtn');
  const form = document.getElementById('connectionForm');

  // How many pixels of breathing room to leave above results when scrolling
  const RESULTS_SCROLL_OFFSET = 72;

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
  
  // ---------- Cover + preview cache ----------
  const coverCache = new Map();

  function normalizeMusicText(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }


async function fetchTrackInfo(trackName, artist1, artist2) {
  if (!trackName) return { cover: null, preview: null };

  const artists = [artist1, artist2].filter(Boolean).sort();

  const key =
    `${normalizeMusicText(trackName)}||` +
    artists.map(normalizeMusicText).join('||');

  if (coverCache.has(key)) {
    return coverCache.get(key);
  }

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
    items.forEach(it => {
      const div = document.createElement('div');
      div.className = 'autocomplete-item';
      const mbidText = it.gid ? ('MBID: ' + escapeHtml(String(it.gid))) : ('ID: ' + escapeHtml(String(it.id)));
      div.innerHTML = `
        <div class="artist-info">
          <div class="artist-name">${escapeHtml(it.name)}</div>
          <div class="artist-details">${it.release_count} releases</div>
          <div class="artist-mbid">${mbidText}</div>
        </div>
      `;
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

    // Ignore results from an older search.
    if (version !== searchVersion) return;

    // Also verify the input still matches this search.
    if (q !== inputEl.value.trim()) return;

    renderDropdown(dropdownEl, rows, inputEl);
  }, 200);

  inputEl.addEventListener('input', () => {
    // Invalidate any search that is already in progress.
    searchVersion++;

    // Clear the selected artist ID when the text changes.
    if (hid) hid.value = '';

    if (inputEl.id === 'artist1' && img1) {
      img1.style.display = 'none';
      img1.src = '';
    }

    if (inputEl.id === 'artist2' && img2) {
      img2.style.display = 'none';
      img2.src = '';
    }

    // Don't display outdated results while waiting.
    dropdownEl.style.display = 'none';
    deb();
  });

  inputEl.addEventListener('focus', () => {
    if (dropdownEl.innerHTML && inputEl.value.trim()) {
      dropdownEl.style.display = 'block';
    }
  });

  inputEl.addEventListener('blur', () => {
    setTimeout(() => {
      dropdownEl.style.display = 'none';
    }, 150);
  });
}

  // Hide dropdowns when clicking outside
  document.addEventListener('click', (ev) => {
    [dropdown1, dropdown2].forEach(dd => {
      if (!dd) return;
      const wrapper = dd.parentElement;
      const input = wrapper && wrapper.querySelector('input[type="text"]');
      if (input && !wrapper.contains(ev.target)) dd.style.display = 'none';
    });
  });

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

    function step(now) {
      const progress = Math.min(1, (now - startTime) / duration);

      // Ease in and out for a natural glide.
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;

      roots.forEach((el) => {
        const start = startPositions.get(el) || 0;
        const position = Math.round(start * (1 - eased));

        if (el === window) {
          window.scrollTo(0, position);
        } else if (el) {
          el.scrollTop = position;
        }
      });

      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        roots.forEach((el) => {
          if (el === window) {
            window.scrollTo(0, 0);
          } else if (el) {
            el.scrollTop = 0;
          }
        });

        resolve();
      }
    }

    requestAnimationFrame(step);
  });
}

  // ---------- Route management ----------
  const foundRoutes = [];
  let cycleIndex = 0;

  function pathToPairsString(path) {
    if (!Array.isArray(path) || path.length === 0) return '';
    return path.map(s => `${s.from_id || ''}->${s.to_id || ''}`).join('|');
  }

  function unionEdgesFromFoundRoutes() {
    const set = new Set();
    foundRoutes.forEach(route => {
      (route.path || []).forEach(step => {
        const a = parseInt(step.from_id, 10), b = parseInt(step.to_id, 10);
        if (!isNaN(a) && !isNaN(b)) {
          const k = (a < b) ? `${a},${b}` : `${b},${a}`;
          set.add(k);
        }
      });
    });
    return Array.from(set).map(s => s.split(',').map(x => parseInt(x, 10)));
  }

  // Custom scroll function to handle offset
  function scrollToElementWithOffset(el, offset, behavior = 'smooth') {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const targetY = window.scrollY + rect.top - offset;
    window.scrollTo({ top: targetY, behavior: behavior });
  }

  // ---------- Aggressive forced smooth scroll to top ----------
  // This writer aggressively sets multiple scroll targets each frame
  function forceSmoothScrollToTop(duration = 500) {
    return new Promise((resolve) => {
      // short tick to let layout update
      setTimeout(() => {
        // Candidate scroll roots to write to every frame
        const candidates = new Set();
        candidates.add(window);
        candidates.add(document.scrollingElement || document.documentElement || document.body);
        candidates.add(document.documentElement);
        candidates.add(document.body);

        // If .page is scrollable, include it
        const pageEl = document.querySelector('.page');
        if (pageEl) candidates.add(pageEl);

        // Also include any ancestor of resultsEl that looks scrollable
        let el = resultsEl || document.body;
        while (el && el !== document.documentElement && el !== document.body) {
          try {
            const style = window.getComputedStyle(el);
            const oy = style ? style.overflowY : '';
            if ((el.scrollHeight > el.clientHeight) && (oy === 'auto' || oy === 'scroll' || oy === 'overlay')) {
              candidates.add(el);
              break;
            }
          } catch (e) { /* ignore */ }
          el = el.parentElement;
        }

        // convert to array for iteration
        const roots = Array.from(candidates);
        // helper to read maximum scrollTop across roots
        const getMaxScroll = () => {
          let max = 0;
          roots.forEach(r => {
            try {
              if (r === window) {
                const s = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
                if (s > max) max = s;
              } else {
                const s = r.scrollTop || 0;
                if (s > max) max = s;
              }
            } catch (e) { /* ignore */ }
          });
          return max;
        };

        const start = getMaxScroll();
        console.debug('smooth-scroll-forced start', { start, rootsCount: roots.length });

        if (start <= 2) {
          console.debug('smooth-scroll-forced: already at top');
          resolve();
          return;
        }

        const startTime = performance.now();
        const dur = Math.max(80, duration | 0);
        const ease = (t) => 1 - Math.pow(1 - t, 3);

        let rafId = null;
        function step(now) {
          const t = Math.min(1, (now - startTime) / dur);
          const eased = ease(t);
          const current = Math.round(start * (1 - eased));
          // write to all roots
          roots.forEach(r => {
            try {
              if (r === window) {
                window.scrollTo(0, current);
              } else {
                r.scrollTop = current;
              }
            } catch (e) { /* ignore */ }
          });

          // debug occasional values
          if (t === 0 || t >= 1 || (Math.random() < 0.04)) {
            console.debug('smooth-scroll-forced frame', { t, current, maxNow: getMaxScroll() });
          }

          if (t < 1) {
            rafId = requestAnimationFrame(step);
          } else {
            // finalize to zero
            roots.forEach(r => {
              try {
                if (r === window) window.scrollTo(0, 0);
                else r.scrollTop = 0;
              } catch (e) { /* ignore */ }
            });
            console.debug('smooth-scroll-forced done');
            resolve();
          }
        }
        rafId = requestAnimationFrame(step);

        // safety timeout
        setTimeout(() => {
          if (rafId) cancelAnimationFrame(rafId);
          roots.forEach(r => {
            try {
              if (r === window) window.scrollTo(0, 0);
              else r.scrollTop = 0;
            } catch (e) { /* ignore */ }
          });
          console.debug('smooth-scroll-forced timeout fallback applied');
          resolve();
        }, Math.max(900, dur + 400));
      }, 40);
    });
  }

  // Animate fade-in for steps. Can be called after render when animate was skipped.
  function animateFadeIn() {
    if (!resultsEl) return;
    const steps = Array.from(resultsEl.querySelectorAll('.fade-step'));
    steps.forEach((el) => el.classList.remove('visible')); // reset
    steps.forEach((el, i) => {
      setTimeout(() => {
        el.classList.add('visible');
      }, i * 400);
    });
  }


  // ---------- 3D album-cover tilt ----------
  function attachCoverTilt() {
    const supportsHover = window.matchMedia(
      '(hover: hover) and (pointer: fine)'
    ).matches;

    if (!supportsHover || !resultsEl) return;

    const maxTilt = 18;

    resultsEl.querySelectorAll('.track-cover-wrapper').forEach(wrapper => {
      wrapper.addEventListener('pointermove', event => {
        const rect = wrapper.getBoundingClientRect();

        // Normalize cursor position from -1 to +1.
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = ((event.clientY - rect.top) / rect.height) * 2 - 1;

        // Reverse the usual tilt so the corner under the cursor
        // appears to dip away from the viewer.
        const rotateX = -y * maxTilt;
        const rotateY = x * maxTilt;

        wrapper.style.setProperty('--tilt-x', `${rotateX}deg`);
        wrapper.style.setProperty('--tilt-y', `${rotateY}deg`);
      });

      wrapper.addEventListener('pointerleave', () => {
        wrapper.style.setProperty('--tilt-x', '0deg');
        wrapper.style.setProperty('--tilt-y', '0deg');
      });
    });
  }


  // ---------- Render server path with covers, fade-in, apple->MusicBrainz link ----------
  async function renderPathWithCovers(serverPath, animate = true) {
    const enriched = await Promise.all(
    serverPath.map(async (step, idx) => {
      const info = step.track
        ? await fetchTrackInfo(
            step.track,
            step.from_name || '',
            step.to_name || ''
          )
        : { cover: null, preview: null };

      return {
        ...step,
        cover: info.cover,
        preview: info.preview,
        stepNumber: idx + 1
      };
    })
  );

    let html = '<div class="path-container">';

    enriched.forEach(s => {
      html += `<div class="connection-step fade-step" data-fromid="${s.from_id || ''}" data-toid="${s.to_id || ''}">`;
      html += `<div class="step-number">${s.stepNumber}</div>`;
      html += `<div class="track-cover-wrapper" style="position:relative; width:200px; height:200px; margin:0 auto 12px auto;">`;
      const coverUrl = s.cover || '/static/images/default_cover.jpeg';
      html += `<img src="${escapeHtml(coverUrl)}" alt="${escapeHtml(s.track || '')}" class="track-cover" style="width:100%; height:100%; border-radius:12px; object-fit:cover;" onerror="this.onerror=null;this.src='/static/images/default_cover.jpeg'">`;
      html += `<div class="play-button-container" aria-hidden="${s.preview ? 'false' : 'true'}" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; pointer-events:auto;">`;
      html += `<div class="progress-circle"></div>`;
      if (s.preview) {
        html += `<button class="play-button" aria-label="Play preview" aria-pressed="false" data-preview="${escapeHtml(s.preview)}" style="width:56px; height:56px; border-radius:50%; display:flex; align-items:center; justify-content:center; background:rgba(255,255,255,0.6); border:none; cursor:pointer;">`;
        html += `<img src="/static/images/play_button.png" alt="Play" class="play-icon" style="width:28px;height:28px;pointer-events:none;">`;
        html += `</button>`;
      } else {
        html += `<div style="width:56px; height:56px; border-radius:50%; background:rgba(255,255,255,0.45); display:flex; align-items:center; justify-content:center;"><img src="/static/images/play_button.png" style="width:20px; height:20px; opacity:0.6;"></div>`;
      }
      html += `</div>`; // play-button
      html += `</div>`; // wrapper
      if (s.track) html += `<div class="track-name">${escapeHtml(s.track)}</div>`;
      html += `<div class="artist-names">${escapeHtml(s.from_name || '')} & ${escapeHtml(s.to_name || '')}</div>`;

      if (s.track) {
        const urls = generateMusicServiceUrls(s.track, `${s.from_name || ''} ${s.to_name || ''}`);
        const mbQuery = encodeURIComponent(`recording:${s.track} AND artist:${s.from_name || ''}`);
        const mbUrl = `https://musicbrainz.org/search?query=${mbQuery}&type=recording`;
        html += `<div class="music-services">
                   <img src="/static/images/music-brainz-icon.svg" alt="MusicBrainz" class="service-icon mb" onclick="window.open('${mbUrl}', '_blank')" />
                   <img src="/static/images/apple-icon.png" alt="Apple Music" class="service-icon apple" onclick="window.open('${urls.apple}', '_blank')" />
                   <img src="/static/images/spotify-icon.png" alt="Spotify" class="service-icon spotify" onclick="window.open('${urls.spotify}', '_blank')" />
                   <img src="/static/images/youtube-icon.png" alt="YouTube" class="service-icon youtube" onclick="window.open('${urls.youtube}', '_blank')" />
                 </div>`;
      }

      html += `</div>`; // connection-step
    });

    html += '</div>'; // path-container

    html += `
      <footer>
        <div class="footer-buttons">
          <button id="refreshBtn" title="Refresh Page" aria-label="Refresh Page"><img src="/static/images/restart_icon.svg" alt="Restart"/></button>
          <button id="tryAgainBtn">Try Another Route</button>
          <button id="shareBtn" title="Share" aria-label="Share"><img src="/static/images/share_icon.svg" alt="Share"/></button>
        </div>
      </footer>
    `;

    if (resultsEl) resultsEl.innerHTML = html;

    attachCoverTilt();

    const refreshBtn = document.getElementById('refreshBtn');
    if (refreshBtn) refreshBtn.addEventListener('click', () => window.location.reload());
    const tryBtn = document.getElementById('tryAgainBtn');

    if (tryBtn) {
      tryBtn.addEventListener('click', async () => {
        // Glide to the top before starting the route search.
        await glideToTop(850);

        // Start the search after scrolling finishes.
        tryAnotherRoute();
      });
    }


    const shareBtn = document.getElementById('shareBtn');
    if (shareBtn) {
      shareBtn.addEventListener('click', async () => {
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
            await navigator.share({
              title: shareTitle,
              text: shareTitle,
              url: url
            });
          } catch (error) {
            if (error.name !== 'AbortError') {
              console.error('Sharing failed:', error);
            }
          }
        } else {
          try {
            await navigator.clipboard.writeText(`${shareTitle}\n${url}`);
            alert('Question and link copied!');
          } catch (error) {
            prompt('Copy this question and link:', `${shareTitle}\n${url}`);
          }
        }
      });
    }


    // attach play/pause handlers & progress
    window._sdos_audio = window._sdos_audio || new Audio();
    const audio = window._sdos_audio;
    audio.preload = 'auto';

    function updateProgress(btn) {
      if (!btn || !audio.duration || isNaN(audio.duration)) return;
      const container = btn.closest('.play-button-container');
      const circle = container && container.querySelector('.progress-circle');
      if (!circle) return;
      const pct = Math.max(0, Math.min(1, audio.currentTime / audio.duration));
      circle.style.opacity = '1';
      circle.classList.add('is-playing');;
      circle.style.background = `conic-gradient(rgba(255,255,255,0.73) ${pct * 100}%, transparent ${pct * 100}%)`;
    }

    function animLoop() {
      if (!window._sdos_currentBtn || audio.paused) {
        cancelAnimationFrame(window._sdos_currentAnim);
        return;
      }
      updateProgress(window._sdos_currentBtn);
      window._sdos_currentAnim = requestAnimationFrame(animLoop);
    }

    audio.addEventListener('ended', () => {
      if (window._sdos_currentBtn) {
        updateIcon(window._sdos_currentBtn, 'play');
        window._sdos_currentBtn.classList.remove('is-playing');
        const container = window._sdos_currentBtn.closest('.play-button-container');
        const circle = container && container.querySelector('.progress-circle');
        if (circle) {
          circle.style.opacity = '0';
          circle.classList.remove('is-playing');
        }
        window._sdos_currentBtn = null;
        cancelAnimationFrame(window._sdos_currentAnim);
      }
    });

    if (resultsEl) {
      resultsEl.querySelectorAll('.play-button').forEach(btn => {
        btn.addEventListener('click', async (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          const preview = btn.dataset.preview;
          if (!preview) return;
          if (window._sdos_currentBtn === btn) {
            if (!audio.paused) {
              audio.pause();
              updateIcon(btn, 'play');
              btn.classList.remove('is-playing');
              const container = btn.closest('.play-button-container');
              const circle = container && container.querySelector('.progress-circle');
              if (circle) { circle.style.opacity = '0'; circle.classList.remove('is-playing'); }
              cancelAnimationFrame(window._sdos_currentAnim);
              return;
            } else {
              await audio.play().catch(e => console.error('resume failed', e));
              updateIcon(btn, 'pause');
              btn.classList.add('is-playing');
              window._sdos_currentAnim = requestAnimationFrame(animLoop);
              return;
            }
          }
          if (window._sdos_currentBtn && window._sdos_currentBtn !== btn) {
            updateIcon(window._sdos_currentBtn, 'play');
            window._sdos_currentBtn.classList.remove('is-playing');
            const prevContainer = window._sdos_currentBtn.closest('.play-button-container');
            const prevCircle = prevContainer && prevContainer.querySelector('.progress-circle');
            if (prevCircle) { prevCircle.style.opacity = '0'; prevCircle.classList.remove('is-playing'); }
          }
          window._sdos_currentBtn = btn;
          audio.src = preview;
          audio.currentTime = 0;
          try {
            await audio.play();
          } catch (err) {
            console.error('play failed', err);
            window._sdos_currentBtn = null;
            return;
          }
          updateIcon(btn, 'pause');
          btn.classList.add('is-playing');
          const container = btn.closest('.play-button-container');
          const circle = container && container.querySelector('.progress-circle');
          if (circle) { circle.style.opacity = '1'; circle.classList.add('is-playing');; }
          window._sdos_currentAnim = requestAnimationFrame(animLoop);
        });
      });
    }

    // run fade-in only if requested
    if (animate) {
      if (resultsEl) {
        const steps = Array.from(resultsEl.querySelectorAll('.fade-step'));
        steps.forEach((el) => el.classList.remove('visible'));
        steps.forEach((el, i) => {
          setTimeout(() => { el.classList.add('visible'); }, i * 400);
        });
      }
    }
  }

  // ---------- Try Another Route with audio stop and top scroll then fade-in ----------
  async function tryAnotherRoute() {
    stopCurrentAudio();
    if (foundRoutes.length === 0) {
      if (resultsEl) resultsEl.innerHTML = '';
      if (form) form.reset();
      return;
    }

  const union = unionEdgesFromFoundRoutes();

  // Show and restart the loading animation.
  if (loadingEl) loadingEl.style.display = 'block';
  startLoadingAnimation();

  if (findBtn) findBtn.disabled = true;

    try {
      const last = foundRoutes[foundRoutes.length - 1];
      const source = parseInt(last.path[0].from_id, 10);
      const target = parseInt(last.path[last.path.length - 1].to_id, 10);

      const body = { source_id: source, target_id: target, exclude_edges: union };
      const resp = await fetch('/api/path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!resp.ok) {
        let err = 'Error attempting alternative route';
        try {
          const j = await resp.json();
          err = j.detail || j.error || err;
        } catch (e) {}
        if (resultsEl) resultsEl.innerHTML = `<div class="results-header">${escapeHtml(err)}</div>`;
        return;
      }

      const data = await resp.json();
      if (!data.found) {
        if (foundRoutes.length === 0) {
          if (resultsEl) resultsEl.innerHTML = `<div class="results-header">No alternative route found</div>`;
        } else {
          cycleIndex = (cycleIndex + 1) % foundRoutes.length;
          const routeToShow = foundRoutes[cycleIndex].path;
          await renderPathWithCovers(routeToShow, false);
          animateFadeIn();
        }
        return;
      }

      const newPairs = pathToPairsString(data.path || []);
      const already = foundRoutes.some(r => pathToPairsString(r.path) === newPairs);
      if (already) {
        if (foundRoutes.length > 0) {
          cycleIndex = (cycleIndex + 1) % foundRoutes.length;
          await renderPathWithCovers(foundRoutes[cycleIndex].path, false);
          animateFadeIn();
          return;
        } else {
          if (resultsEl) resultsEl.innerHTML = `<div class="results-header">No alternative route found</div>`;
          return;
        }
      }

      const normalized = data.path.map(step => ({
        from_id: step.from_id,
        to_id: step.to_id,
        from_name: step.from_name,
        to_name: step.to_name,
        track: step.track,
        to_mbid: step.to_mbid
      }));

      foundRoutes.push({ path: normalized });
      cycleIndex = foundRoutes.length - 1;
      await renderPathWithCovers(normalized, false);
      animateFadeIn();

    } catch (err) {
      console.error('tryAnotherRoute error', err);
      if (resultsEl) resultsEl.innerHTML = '<div class="results-header">Unexpected error finding alternative route</div>';
    } finally {
      stopLoadingAnimation();

      if (loadingEl) loadingEl.style.display = 'none';
      if (findBtn) findBtn.disabled = false;
    }
  }

  // ---------- Form submit with controlled loading ----------
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
        const source = parseInt(hid1.value, 10);
        const target = parseInt(hid2.value, 10);

        const payload = { source_id: source, target_id: target };
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
          } catch (e) {}
          if (resultsEl) resultsEl.innerHTML = `<div class="results-header">${escapeHtml(errText)}</div>`;
          return;
        }

        const data = await resp.json();

        if (!data.found) {
          if (resultsEl) resultsEl.innerHTML = `<div class="results-header">No connection found!</div>`;
          return;
        }

        foundRoutes.length = 0;
        cycleIndex = 0;
        const normalized = data.path.map(step => ({
          from_id: step.from_id,
          to_id: step.to_id,
          from_name: step.from_name,
          to_name: step.to_name,
          track: step.track,
          to_mbid: step.to_mbid
        }));
        foundRoutes.push({ path: normalized });
        await renderPathWithCovers(normalized, true);
        const firstTrackEl = resultsEl.querySelector('.connection-step');
        scrollToElementWithOffset(firstTrackEl, RESULTS_SCROLL_OFFSET);

      } catch (err) {
        console.error('Submit error', err);
        if (resultsEl) resultsEl.innerHTML = '<div class="results-header">Unexpected error - check console</div>';
      } finally {
        stopLoadingAnimation();
        if (findBtn) findBtn.disabled = false;
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

  // ---------- Load and run a shared artist connection ----------
async function loadSharedRoute() {
  const params = new URLSearchParams(window.location.search);
  const artistA = params.get('artist1');
  const artistB = params.get('artist2');

  if (!artistA || !artistB || !a1 || !a2 || !hid1 || !hid2 || !form) {
    return;
  }

  let submitted = false;

  a1.value = artistA;
  a2.value = artistB;

  if (findBtn) findBtn.disabled = true;
  if (loadingEl) loadingEl.style.display = 'block';
  startLoadingAnimation();

  try {
    async function findArtist(name) {
      const matches = await doSearch(name);

      return matches.find(
        artist => artist.name.toLowerCase() === name.toLowerCase()
      );
    }

    const [matchA, matchB] = await Promise.all([
      findArtist(artistA),
      findArtist(artistB)
    ]);

    if (!matchA || !matchB) {
      if (resultsEl) {
        resultsEl.textContent =
          'Could not find one or both artists from this shared link. Please select them manually.';
      }
      return;
    }

    // Fill in the verified artist names and IDs.
    a1.value = matchA.name;
    a2.value = matchB.name;
    hid1.value = matchA.id;
    hid2.value = matchB.id;

    // Let the existing form handler take over loading and pathfinding.
    form.requestSubmit();
    submitted = true;

  } catch (error) {
    console.error('Could not load shared route:', error);

    if (resultsEl) {
      resultsEl.textContent =
        'Could not load this shared connection. Please try searching manually.';
    }

  } finally {
    // Only clean up here if form submission never started.
    if (!submitted) {
      if (loadingEl) loadingEl.style.display = 'none';
      stopLoadingAnimation();
      if (findBtn) findBtn.disabled = false;
    }
  }
}

const sharedParams = new URLSearchParams(window.location.search);

if (sharedParams.has('artist1') && sharedParams.has('artist2')) {
  loadSharedRoute();
}
  
  console.log('SDOS main.js ready.');
})();
