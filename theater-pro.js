/* ============================================================
   DECAN MOVIE — Theater Pro
   Additive professional player layer. Wraps (never replaces)
   launchTheaterPlayer / launchTrailerModal / closeTheater and
   reuses the platform's mediaKey / playback / history helpers.
   ============================================================ */
(function () {
  'use strict';
  if (window.__DECAN_THEATER_PRO__) return;
  window.__DECAN_THEATER_PRO__ = true;

  /* ---------------- utils ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const store = {
    get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch (_) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
    raw(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  };
  const toast = (m) => { if (typeof window.showToast === 'function') window.showToast(m); };
  const mediaKeyOf = (item) => {
    if (typeof window.mediaKey === 'function') return window.mediaKey(item);
    if (!item || item.id == null) return '';
    return (item.type || item.media_type || 'movie') + ':' + item.id + ':' + (item.season || 0) + ':' + (item.episode || 0);
  };
  function fmtClock(totalSeconds) {
    const n = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
    const mm = h ? String(m).padStart(2, '0') : String(m);
    const ss = String(s).padStart(2, '0');
    return (h ? h + ':' : '') + mm + ':' + ss;
  }
  function fmtLeft(totalSeconds) {
    const n = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
    if (h) return '-' + h + 'h ' + String(m).padStart(2, '0') + 'm';
    if (m) return '-' + m + 'm ' + String(ss0(s)).padStart(2, '0') + 's';
    return '-' + s + 's';
    function ss0(x) { return x; }
  }

  /* ---------------- embed sources (real server switching) ---------------- */
  const SOURCES = [
    {
      id: 'auto', label: 'Auto · VidSrc HD',
      movie: (id) => 'https://vidsrc.me/embed/movie?tmdb=' + id,
      tv: (id, s, e) => 'https://vidsrc.me/embed/tv?tmdb=' + id + '&season=' + s + '&episode=' + e
    },
    {
      id: 'vidsrc-to', label: 'VidSrc TO · Alt 1',
      movie: (id) => 'https://vidsrc.to/embed/movie/' + id,
      tv: (id, s, e) => 'https://vidsrc.to/embed/tv/' + id + '/' + s + '/' + e
    },
    {
      id: 'vidsrc-xyz', label: 'VidSrc XYZ · Alt 2',
      movie: (id) => 'https://vidsrc.xyz/embed/movie?tmdb=' + id,
      tv: (id, s, e) => 'https://vidsrc.xyz/embed/tv?tmdb=' + id + '&season=' + s + '&episode=' + e
    },
    {
      id: '2embed', label: '2Embed · Alt 3',
      movie: (id) => 'https://www.2embed.cc/embed/' + id,
      tv: (id, s, e) => 'https://www.2embed.cc/embedtv/' + id + '&s=' + s + '&e=' + e
    }
  ];
  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  /* ---------------- state ---------------- */
  const T = {
    open: false,
    mode: 'embed',            // 'embed' | 'trailer'
    item: null,               // {id,type,title,season,episode}
    key: '',
    sourceId: store.get('decan_pref_source', 'auto'),
    streamUrl: '',
    ytKey: '',
    duration: 0,
    durationKnown: false,
    base: 0,                  // restored bookmark (seconds)
    elapsed: 0,               // active seconds this session
    playing: false,           // stream loaded + clock running
    pausedVeil: false,
    volume: clamp(Number(store.get('decan_pref_volume', 80)), 0, 100),
    muted: store.get('decan_pref_muted', false) === true,
    rate: Number(store.get('decan_pref_rate', 1)) || 1,
    resumeShown: false,
    yt: null, ytReady: false, ytApiLoading: null,
    quality: 'auto',
    captionsOn: false,
    subs: { mode: store.get('decan_pref_sub', 'provider'), cues: [], fileName: '', size: 16, offset: 0 },
    clockTimer: null, saveTimer: null, loadTimeout: null,
    idleTimer: null, lightsOut: false,
    scrubbing: false,
    mini: false
  };
  const RUNTIME_CACHE_KEY = 'decan_runtime_cache_v1';

  function position() { return T.base + T.elapsed; }
  function progressPct() { return T.duration > 0 ? clamp(Math.round((position() / T.duration) * 100), 0, 100) : 0; }

  /* ---------------- runtime estimates (TMDB, cached) ---------------- */
  function runtimeCache() { return store.get(RUNTIME_CACHE_KEY, {}); }
  async function ensureDuration() {
    if (!T.item) return;
    if (T.mode === 'trailer') return; // YouTube reports real duration
    const ck = T.item.type + ':' + T.item.id;
    const cache = runtimeCache();
    if (cache[ck]) { setDuration(cache[ck], true); return; }
    setDuration(T.item.type === 'tv' ? 2700 : 5400, false);
    try {
      const r = await fetch('/api/tmdb/' + T.item.type + '/' + T.item.id + '?language=en-US',
        { headers: { accept: 'application/json' } });
      if (!r.ok) return;
      const d = await r.json();
      let secs = 0;
      if (T.item.type === 'movie' && d.runtime) secs = d.runtime * 60;
      if (T.item.type === 'tv' && d.episode_run_time && d.episode_run_time[0]) secs = d.episode_run_time[0] * 60;
      if (secs > 0) {
        cache[ck] = secs;
        store.set(RUNTIME_CACHE_KEY, cache);
        setDuration(secs, true);
      }
    } catch (_) { /* keep estimate */ }
  }
  function setDuration(secs, known) {
    T.duration = Math.max(60, Math.round(Number(secs) || 0));
    T.durationKnown = !!known;
    renderTimes();
  }

  /* ---------------- persistence (reuses platform helpers) ---------------- */
  function persistPosition(reason) {
    if (!T.item || !T.open) return;
    try {
      if (typeof window.savePlaybackState === 'function') {
        window.savePlaybackState(T.item, position(), T.duration || 0);
      }
    } catch (_) {}
    try {
      document.dispatchEvent(new CustomEvent('decan:continue-updated', { detail: { reason: reason || 'tick' } }));
    } catch (_) {}
  }
  function restoreBookmark() {
    T.base = 0; T.elapsed = 0;
    try {
      if (typeof window.getPlaybackState === 'function' && T.item) {
        const st = window.getPlaybackState(T.item);
        if (st && Number(st.currentTime) > 0 && !st.completed) T.base = Math.floor(Number(st.currentTime));
      }
    } catch (_) {}
  }

  /* ---------------- DOM: build deck ---------------- */
  let els = {};
  function buildChrome() {
    const container = $('#theater-container');
    if (!container || $('#tpro-deck')) return;
    const header = $('.theater-header', container);

    // header tools
    const tools = document.createElement('div');
    tools.className = 'tpro-tools';
    tools.innerHTML =
      '<button class="tpro-hbtn" id="tpro-comments-hbtn" type="button" aria-label="Open comments for this title">' +
        '<i class="fas fa-comments"></i> <span class="tpro-hlabel">Comments</span>' +
        '<span class="tpro-count-badge" data-cpro-count hidden>0</span>' +
      '</button>' +
      '<button class="tpro-hbtn" id="tpro-mini-hbtn" type="button" aria-label="Toggle mini player">' +
        '<i class="fas fa-clone"></i> <span class="tpro-hlabel">Mini</span>' +
      '</button>' +
      '<button class="tpro-hbtn" id="tpro-fs-hbtn" type="button" aria-label="Toggle fullscreen">' +
        '<i class="fas fa-expand"></i> <span class="tpro-hlabel">Fullscreen</span>' +
      '</button>';
    const closeBtn = $('.close-modal', header);
    if (closeBtn) header.insertBefore(tools, closeBtn);
    else header.appendChild(tools);

    // stage overlays live inside the ratio box
    const stage = $('#theater-iframe-wrapper');

    // control deck below the stage
    const deck = document.createElement('section');
    deck.className = 'tpro-deck';
    deck.id = 'tpro-deck';
    deck.setAttribute('aria-label', 'Video player controls');
    deck.innerHTML =
      '<div class="tpro-timeline-row">' +
        '<span class="tpro-time" id="tpro-elapsed">0:00</span>' +
        '<input class="tpro-seek" id="tpro-seek" type="range" min="0" max="100" value="0" step="1" ' +
          'aria-label="Seek playback position">' +
        '<span class="tpro-time dim" id="tpro-remaining">-0s</span>' +
        '<span class="tpro-time dim hide-sm" id="tpro-duration">--:--</span>' +
      '</div>' +
      '<div class="tpro-transport" role="toolbar" aria-label="Player transport controls">' +
        '<button class="tpro-btn" id="tpro-prev" type="button" aria-label="Previous title"><i class="fas fa-step-backward"></i></button>' +
        '<button class="tpro-btn" id="tpro-rw" type="button" aria-label="Back 10 seconds"><i class="fas fa-rotate-left"></i></button>' +
        '<button class="tpro-btn primary" id="tpro-play" type="button" aria-label="Play or pause"><i class="fas fa-pause"></i></button>' +
        '<button class="tpro-btn" id="tpro-fw" type="button" aria-label="Forward 10 seconds"><i class="fas fa-rotate-right"></i></button>' +
        '<button class="tpro-btn" id="tpro-next" type="button" aria-label="Next title"><i class="fas fa-step-forward"></i></button>' +
        '<span class="tpro-sep"></span>' +
        '<div class="tpro-vol">' +
          '<button class="tpro-btn" id="tpro-mute" type="button" aria-label="Mute or unmute"><i class="fas fa-volume-up"></i></button>' +
          '<input type="range" id="tpro-volume" min="0" max="100" value="80" aria-label="Volume level">' +
        '</div>' +
        '<span class="tpro-spacer"></span>' +
        '<button class="tpro-btn" id="tpro-subs-btn" type="button" aria-label="Subtitles and captions"><i class="fas fa-closed-captioning"></i><span class="tpro-label">Subs</span></button>' +
        '<button class="tpro-btn" id="tpro-speed-btn" type="button" aria-label="Playback speed"><i class="fas fa-gauge-high"></i><span class="tpro-label" id="tpro-speed-label">1x</span></button>' +
        '<button class="tpro-btn" id="tpro-quality-btn" type="button" aria-label="Source and quality"><i class="fas fa-sliders"></i><span class="tpro-label">Source</span></button>' +
        '<button class="tpro-btn" id="tpro-pip-btn" type="button" aria-label="Mini player picture mode"><i class="fas fa-clone"></i><span class="tpro-label">Mini</span></button>' +
        '<button class="tpro-btn" id="tpro-more-btn" type="button" aria-label="More player options" aria-haspopup="menu"><i class="fas fa-ellipsis-vertical"></i><span class="tpro-label">More</span></button>' +
      '</div>' +
      '<div class="tpro-meta-row" id="tpro-meta">' +
        '<span class="tpro-pill cyan" id="tpro-pill-status"><i class="fas fa-circle-play"></i> <span>Loading…</span></span>' +
        '<span class="tpro-pill" id="tpro-pill-resume" hidden><i class="fas fa-bookmark"></i> <span></span></span>' +
        '<span class="tpro-pill green" id="tpro-pill-saved" hidden><i class="fas fa-check"></i> <span>Progress saved</span></span>' +
        '<span class="tpro-pill gold" id="tpro-pill-source"><i class="fas fa-server"></i> <span>Auto · VidSrc HD</span></span>' +
        '<span class="tpro-pill" id="tpro-pill-queue"><i class="fas fa-list"></i> <span>Up next</span></span>' +
      '</div>';
    container.appendChild(deck);

    // menu root
    const backdrop = document.createElement('div');
    backdrop.className = 'tpro-menu-backdrop';
    backdrop.id = 'tpro-menu-backdrop';
    backdrop.hidden = true;
    document.body.appendChild(backdrop);
    const menu = document.createElement('div');
    menu.className = 'tpro-menu';
    menu.id = 'tpro-menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    document.body.appendChild(menu);

    els = {
      container, header, stage, deck,
      elapsed: $('#tpro-elapsed'), remaining: $('#tpro-remaining'), duration: $('#tpro-duration'),
      seek: $('#tpro-seek'), play: $('#tpro-play'), rw: $('#tpro-rw'), fw: $('#tpro-fw'),
      prev: $('#tpro-prev'), next: $('#tpro-next'), mute: $('#tpro-mute'), vol: $('#tpro-volume'),
      more: $('#tpro-more-btn'), pip: $('#tpro-pip-btn'), speedBtn: $('#tpro-speed-btn'),
      speedLabel: $('#tpro-speed-label'), qualityBtn: $('#tpro-quality-btn'), subsBtn: $('#tpro-subs-btn'),
      pillStatus: $('#tpro-pill-status'), pillResume: $('#tpro-pill-resume'),
      pillSaved: $('#tpro-pill-saved'), pillSource: $('#tpro-pill-source'), pillQueue: $('#tpro-pill-queue'),
      commentsH: $('#tpro-comments-hbtn'), miniH: $('#tpro-mini-hbtn'), fsH: $('#tpro-fs-hbtn'),
      menu, backdrop
    };

    wireControls();
  }

  function stageOverlays() {
    const stage = $('#theater-iframe-wrapper');
    if (!stage) return {};
    let loader = $('#tpro-loader');
    if (!loader) {
      loader = document.createElement('div');
      loader.className = 'tpro-loader';
      loader.id = 'tpro-loader';
      loader.innerHTML =
        '<div class="tpro-spinner" aria-hidden="true"></div>' +
        '<div class="tpro-load-title">Loading stream…</div>' +
        '<div class="tpro-load-sub" id="tpro-load-sub">Connecting to the video provider. This usually takes a few seconds.</div>' +
        '<div class="tpro-load-actions" id="tpro-load-actions" hidden>' +
          '<button class="tpro-hbtn" id="tpro-load-retry" type="button"><i class="fas fa-rotate-right"></i> Retry</button>' +
          '<button class="tpro-hbtn" id="tpro-load-alt" type="button"><i class="fas fa-server"></i> Try another source</button>' +
        '</div>';
      stage.appendChild(loader);
    }
    let veil = $('#tpro-paused-veil');
    if (!veil) {
      veil = document.createElement('div');
      veil.className = 'tpro-paused-veil';
      veil.id = 'tpro-paused-veil';
      veil.hidden = true;
      veil.innerHTML =
        '<button class="tpro-bigplay" id="tpro-bigplay" type="button" aria-label="Resume playback"><i class="fas fa-play"></i></button>' +
        '<div style="color:#fff;font-weight:800;">Paused — stream stopped to save data</div>' +
        '<div style="font-size:.78rem;color:#9aa4b5;" id="tpro-veil-sub">Your position is saved. Press Play to reload the stream.</div>';
      stage.appendChild(veil);
      $('#tpro-bigplay').addEventListener('click', () => togglePlay());
    }
    let caps = $('#tpro-caption-layer');
    if (!caps) {
      caps = document.createElement('div');
      caps.className = 'tpro-caption-layer';
      caps.id = 'tpro-caption-layer';
      caps.hidden = true;
      caps.innerHTML = '<div class="tpro-caption-cue" id="tpro-caption-cue"></div>';
      stage.appendChild(caps);
    }
    const retry = $('#tpro-load-retry');
    if (retry && !retry.dataset.wired) {
      retry.dataset.wired = '1';
      retry.addEventListener('click', () => reloadStream());
      $('#tpro-load-alt').addEventListener('click', () => cycleSource(1));
    }
    return { loader, veil, caps };
  }

  function showLoader(on, sub) {
    const { loader } = stageOverlays();
    if (!loader) return;
    loader.hidden = !on;
    if (sub) { const s = $('#tpro-load-sub'); if (s) s.textContent = sub; }
    const actions = $('#tpro-load-actions');
    if (actions && on) actions.hidden = true;
    clearTimeout(T.loadTimeout);
    if (on) {
      T.loadTimeout = setTimeout(() => {
        const a = $('#tpro-load-actions');
        const sb = $('#tpro-load-sub');
        if (a && !loader.hidden) {
          a.hidden = false;
          if (sb) sb.textContent = 'Still connecting — the provider may be slow. You can retry or switch to another source.';
        }
      }, 12000);
    }
  }

  /* ---------------- menus ---------------- */
  function closeMenu() {
    if (!els.menu) return;
    els.menu.hidden = true;
    els.backdrop.hidden = true;
  }
  function openMenu(anchorBtn, html) {
    if (!els.menu) return;
    els.menu.innerHTML = html;
    els.menu.hidden = false;
    els.backdrop.hidden = false;
    const r = anchorBtn.getBoundingClientRect();
    const mw = Math.min(300, window.innerWidth - 24);
    els.menu.style.minWidth = mw + 'px';
    let left = clamp(r.right - mw, 12, window.innerWidth - mw - 12);
    let top = r.top - els.menu.offsetHeight - 10;
    if (top < 70) top = r.bottom + 10;
    els.menu.style.left = left + 'px';
    els.menu.style.top = Math.max(70, top) + 'px';
  }
  function menuItem(icon, title, sub, active, action) {
    return '<button class="tpro-item' + (active ? ' active' : '') + '" type="button" data-act="' + action + '">' +
      '<i class="fas ' + icon + '"></i><span>' + esc(title) +
      (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>' +
      (active ? '<span class="tick"><i class="fas fa-check"></i></span>' : '') + '</button>';
  }

  function openMoreMenu() {
    const src = SOURCES.find((s) => s.id === T.sourceId) || SOURCES[0];
    const html =
      '<h5>Playback</h5>' +
      menuItem('fa-rotate-right', 'Restart video', 'Reload the stream from the start', false, 'restart') +
      menuItem('fa-backward-fast', 'Play from beginning', 'Clear saved position and reload', false, 'fromstart') +
      '<div class="tpro-divider"></div><h5>Stream</h5>' +
      menuItem('fa-server', 'Source: ' + src.label, 'Switch provider when a stream is slow', false, 'source') +
      menuItem('fa-gauge-high', 'Speed: ' + T.rate + 'x', T.mode === 'trailer' ? 'Applies to this trailer instantly' : 'Applies to trailers and music instantly', false, 'speed') +
      menuItem('fa-closed-captioning', 'Subtitles', T.subs.mode === 'custom' && T.subs.cues.length ? T.subs.fileName : 'Provider captions or your own file', false, 'subs') +
      '<div class="tpro-divider"></div><h5>View</h5>' +
      menuItem('fa-clone', T.mini ? 'Exit mini player' : 'Mini player', 'Float the player over the page', T.mini, 'mini') +
      menuItem('fa-expand', 'Fullscreen', 'Fill the entire screen', !!document.fullscreenElement, 'fs') +
      menuItem('fa-moon', T.lightsOut ? 'Lights on' : 'Lights out', 'Cinema mode hides controls when idle', T.lightsOut, 'lights') +
      '<div class="tpro-divider"></div><h5>Title</h5>' +
      menuItem('fa-comments', 'Comments', 'Join the discussion for this title', false, 'comments') +
      menuItem('fa-link', 'Copy title link', 'Share this exact title', false, 'copylink') +
      menuItem('fa-arrow-up-right-from-square', 'Open stream in new tab', 'Provider page, separate tab', false, 'opentab') +
      menuItem('fa-circle-question', 'Playback help', 'Shortcuts and tips', false, 'help') +
      menuItem('fa-triangle-exclamation', 'Report playback issue', 'The team can review provider health', false, 'report');
    openMenu(els.more, html);
  }
  function openSourceMenu() {
    let html = '<h5>Stream source / quality</h5>';
    SOURCES.forEach((s) => {
      html += menuItem('fa-server', s.label, s.id === 'auto' ? 'Default high-quality provider' : 'Alternate provider mirror',
        T.sourceId === s.id, 'src:' + s.id);
    });
    if (T.mode === 'trailer') {
      html += '<div class="tpro-divider"></div><div class="tpro-note">Trailer quality is set automatically by YouTube HD. ' +
        'Use “HD / Auto” inside the trailer for manual control.</div>';
    } else {
      html += '<div class="tpro-divider"></div><div class="tpro-note">Each source is a real provider mirror. If one is slow or ' +
        'fails to load, switching sources reloads the same title instantly.</div>';
    }
    openMenu(els.qualityBtn, html);
  }
  function openSpeedMenu() {
    let html = '<h5>Playback speed</h5>';
    SPEEDS.forEach((v) => {
      html += menuItem('fa-gauge-high', v + 'x speed', v === 1 ? 'Normal speed' : '', T.rate === v, 'rate:' + v);
    });
    html += '<div class="tpro-divider"></div><div class="tpro-note">' +
      (T.mode === 'trailer'
        ? 'Applies instantly to this trailer and is remembered for music.'
        : 'Embedded providers control their own speed. This sets Decan trailers and music instantly.') +
      '</div>';
    openMenu(els.speedBtn, html);
  }
  function openSubsMenu() {
    const hasCustom = T.subs.mode === 'custom' && T.subs.cues.length > 0;
    let html = '<h5>Subtitles / captions</h5>' +
      menuItem('fa-tv', 'Provider captions', 'Use the captions inside the video', T.subs.mode === 'provider', 'sub:provider') +
      menuItem('fa-file-lines', 'My subtitle file', hasCustom ? T.subs.fileName + ' · ' + T.subs.cues.length + ' cues' : 'Load .srt or .vtt synced to playback', T.subs.mode === 'custom', 'sub:custom') +
      menuItem('fa-ban', 'Captions off', 'Hide the Decan caption overlay', T.subs.mode === 'off', 'sub:off') +
      '<div class="tpro-subfile"><label for="tpro-subfile-input"><i class="fas fa-upload"></i> Choose .srt / .vtt file<input id="tpro-subfile-input" type="file" accept=".srt,.vtt,text/plain"></label></div>' +
      (T.mode === 'trailer'
        ? menuItem('fa-closed-captioning', (T.captionsOn ? 'Hide' : 'Show') + ' YouTube captions', 'Toggle the trailer caption track', T.captionsOn, 'sub:yt') +
          '<div class="tpro-divider"></div>'
        : '<div class="tpro-divider"></div>') +
      '<div class="tpro-note">Custom subtitles display as an overlay synced to your watch clock. ' +
      'Offset: ' + T.subs.offset + 's · Size: ' + T.subs.size + 'px</div>' +
      menuItem('fa-minus', 'Offset −1s', 'Show cues earlier', false, 'sub:off-') +
      menuItem('fa-plus', 'Offset +1s', 'Show cues later', false, 'sub:off+') +
      menuItem('fa-text-height', 'Toggle caption size', 'Cycle 14 → 16 → 20 → 24px', false, 'sub:size');
    openMenu(T.subsBtn || els.more, html);
    const fi = $('#tpro-subfile-input');
    if (fi) fi.addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) loadSubtitleFile(f);
    });
  }
  function openHelpMenu() {
    openMenu(els.more,
      '<h5>Keyboard shortcuts</h5><div class="tpro-note">' +
      '<b>Space / K</b> — play & pause<br><b>← / →</b> or <b>J / L</b> — back / forward 10s<br>' +
      '<b>↑ / ↓</b> — volume<br><b>M</b> — mute<br><b>F</b> — fullscreen<br>' +
      '<b>T</b> — mini player<br><b>C</b> — comments<br><b>R</b> — restart<br><b>Esc</b> — close panel / player</div>' +
      '<div class="tpro-divider"></div><div class="tpro-note">Your position saves automatically every few seconds and when you pause, seek, or close the player.</div>');
  }

  function handleMenuAction(act) {
    if (!act) return;
    if (act === 'restart') { closeMenu(); restartStream(false); }
    else if (act === 'fromstart') { closeMenu(); restartStream(true); }
    else if (act === 'source') openSourceMenu();
    else if (act === 'speed') openSpeedMenu();
    else if (act === 'subs') openSubsMenu();
    else if (act === 'mini') { closeMenu(); toggleMini(); }
    else if (act === 'fs') { closeMenu(); toggleFullscreen(); }
    else if (act === 'lights') { closeMenu(); toggleLights(); }
    else if (act === 'comments') { closeMenu(); toggleComments(true); }
    else if (act === 'copylink') { closeMenu(); copyTitleLink(); }
    else if (act === 'opentab') { closeMenu(); openStreamTab(); }
    else if (act === 'help') openHelpMenu();
    else if (act === 'report') { closeMenu(); reportIssue(); }
    else if (act.indexOf('src:') === 0) { setSource(act.slice(4), true); openSourceMenu(); }
    else if (act.indexOf('rate:') === 0) { setRate(Number(act.slice(5))); openSpeedMenu(); }
    else if (act === 'sub:provider') { T.subs.mode = 'provider'; store.set('decan_pref_sub', 'provider'); openSubsMenu(); renderCaption(); toast('Provider captions selected'); }
    else if (act === 'sub:custom') {
      if (T.subs.cues.length) { T.subs.mode = 'custom'; store.set('decan_pref_sub', 'custom'); openSubsMenu(); renderCaption(); }
      else { const fi = $('#tpro-subfile-input'); if (fi) fi.click(); }
    }
    else if (act === 'sub:off') { T.subs.mode = 'off'; store.set('decan_pref_sub', 'off'); openSubsMenu(); renderCaption(); }
    else if (act === 'sub:yt') { toggleYtCaptions(); openSubsMenu(); }
    else if (act === 'sub:off-') { T.subs.offset -= 1; openSubsMenu(); renderCaption(); }
    else if (act === 'sub:off+') { T.subs.offset += 1; openSubsMenu(); renderCaption(); }
    else if (act === 'sub:size') {
      T.subs.size = T.subs.size >= 24 ? 14 : (T.subs.size >= 20 ? 24 : (T.subs.size >= 16 ? 20 : 16));
      openSubsMenu(); renderCaption();
    }
  }

  /* ---------------- transport ---------------- */
  function setPlayingUI() {
    if (!els.play) return;
    els.play.innerHTML = T.playing ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>';
    els.play.setAttribute('aria-label', T.playing ? 'Pause' : 'Play');
    const { veil } = stageOverlays();
    if (veil) veil.hidden = !(T.pausedVeil && T.mode === 'embed');
    setStatusPill();
  }
  function setStatusPill() {
    if (!els.pillStatus) return;
    const label = els.pillStatus.querySelector('span');
    if (T.mode === 'trailer') {
      els.pillStatus.className = 'tpro-pill cyan';
      if (label) label.textContent = T.playing ? 'Trailer · Playing' : 'Trailer · Paused';
    } else if (!T.playing) {
      els.pillStatus.className = 'tpro-pill';
      if (label) label.textContent = 'Paused · ' + progressPct() + '% watched';
    } else {
      els.pillStatus.className = 'tpro-pill cyan';
      if (label) label.textContent = 'Playing · ' + progressPct() + '% watched';
    }
    if (els.pillSource) {
      const s = SOURCES.find((x) => x.id === T.sourceId) || SOURCES[0];
      const sl = els.pillSource.querySelector('span');
      if (sl) sl.textContent = T.mode === 'trailer' ? 'YouTube · Trailer HD' : s.label;
    }
  }

  function renderTimes() {
    if (!els.seek) return;
    const pos = position();
    const dur = T.duration || 0;
    els.elapsed.textContent = fmtClock(pos);
    els.remaining.textContent = dur ? fmtLeft(dur - pos) : '-0s';
    els.duration.textContent = dur ? (T.durationKnown || T.mode === 'trailer' ? fmtClock(dur) : '~' + fmtClock(dur)) : '--:--';
    if (!T.scrubbing) {
      els.seek.max = Math.max(1, dur);
      els.seek.value = clamp(Math.round(pos), 0, Math.max(1, dur));
    }
    const fill = dur ? clamp((pos / dur) * 100, 0, 100) : 0;
    els.seek.style.setProperty('--fill', fill + '%');
    setStatusPill();
    renderCaption();
  }

  function renderResumePill() {
    if (!els.pillResume) return;
    if (T.base > 5 && !T.resumeShown) {
      els.pillResume.hidden = false;
      const s = els.pillResume.querySelector('span');
      if (s) s.textContent = 'Resumed at ' + fmtClock(T.base);
    } else if (T.resumeShown) {
      els.pillResume.hidden = true;
    }
  }

  function flashSaved() {
    if (!els.pillSaved) return;
    els.pillSaved.hidden = false;
    clearTimeout(flashSaved._t);
    flashSaved._t = setTimeout(() => { if (els.pillSaved) els.pillSaved.hidden = true; }, 2200);
  }

  function togglePlay() {
    if (!T.open) return;
    if (T.mode === 'trailer') {
      if (!T.yt || !T.ytReady) { toast('Trailer is still loading…'); return; }
      try {
        const st = T.yt.getPlayerState();
        if (st === window.YT.PlayerState.PLAYING) T.yt.pauseVideo();
        else T.yt.playVideo();
      } catch (_) {}
      return;
    }
    if (T.playing) pauseEmbed();
    else resumeEmbed();
  }

  function pauseEmbed() {
    if (T.mode !== 'embed' || !T.playing) return;
    persistPosition('pause');
    flashSaved();
    T.playing = false;
    T.pausedVeil = true;
    stopClock(false);
    try { $('#theater-iframe-wrapper').querySelectorAll('iframe').forEach((f) => f.remove()); } catch (_) {}
    const vs = $('#tpro-veil-sub');
    if (vs) vs.textContent = 'Paused at ' + fmtClock(position()) + ' · ' + progressPct() + '% — position saved. Press Play to reload.';
    setPlayingUI(); renderTimes();
    toast('Paused at ' + fmtClock(position()) + ' — progress saved');
  }

  function resumeEmbed() {
    if (T.mode !== 'embed') return;
    T.pausedVeil = false;
    mountEmbed(true);
    T.playing = true;
    startClock();
    setPlayingUI(); renderTimes();
  }

  function seekBy(delta) {
    if (!T.open) return;
    if (T.mode === 'trailer' && T.yt && T.ytReady) {
      try {
        const cur = Number(T.yt.getCurrentTime()) || 0;
        const dur = Number(T.yt.getDuration()) || 0;
        T.yt.seekTo(clamp(cur + delta, 0, Math.max(0, dur - 1)), true);
        persistSoon();
        return;
      } catch (_) {}
    }
    const np = clamp(Math.round(position() + delta), 0, Math.max(0, (T.duration || 0)));
    T.base = np; T.elapsed = 0;
    persistPosition('seek');
    flashSaved(); renderTimes();
    try {
      const f = $('#theater-iframe-wrapper iframe');
      if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'decan:seek', position: np }, '*');
    } catch (_) {}
    toast((delta < 0 ? 'Back 10s · bookmark ' : 'Forward 10s · bookmark ') + fmtClock(np) + ' — use the video’s own seek for exact frames');
  }

  function scrubTo(seconds) {
    const v = clamp(Math.round(Number(seconds) || 0), 0, Math.max(0, T.duration || 0));
    if (T.mode === 'trailer' && T.yt && T.ytReady) {
      try { T.yt.seekTo(v, true); } catch (_) {}
      return;
    }
    T.base = v; T.elapsed = 0;
    persistPosition('seek');
    flashSaved(); renderTimes();
    toast('Bookmark set to ' + fmtClock(v));
  }

  function restartStream(fromBeginning) {
    if (!T.open) return;
    closeMenu();
    if (fromBeginning) {
      T.base = 0; T.elapsed = 0;
      persistPosition('restart');
    }
    if (T.mode === 'trailer' && T.yt && T.ytReady) {
      try { T.yt.seekTo(0, true); T.yt.playVideo(); } catch (_) {}
      toast(fromBeginning ? 'Playing trailer from the beginning' : 'Trailer restarted');
      return;
    }
    T.pausedVeil = false;
    mountEmbed(true);
    T.playing = true;
    startClock(); setPlayingUI(); renderTimes();
    toast(fromBeginning ? 'Playing from the beginning — bookmark cleared' : 'Stream restarted');
  }

  function reloadStream() {
    if (!T.open) return;
    T.pausedVeil = false;
    if (T.mode === 'trailer') buildTrailerPlayer(true);
    else mountEmbed(true);
    T.playing = true; startClock(); setPlayingUI(); renderTimes();
  }

  /* ---------------- volume / mute / rate ---------------- */
  function applyAudio() {
    if (els.vol) {
      els.vol.value = T.muted ? 0 : T.volume;
      els.vol.style.setProperty('--fill', (T.muted ? 0 : T.volume) + '%');
    }
    if (els.mute) {
      els.mute.innerHTML = (T.muted || T.volume === 0)
        ? '<i class="fas fa-volume-xmark"></i>' : (T.volume < 55 ? '<i class="fas fa-volume-low"></i>' : '<i class="fas fa-volume-high"></i>');
      els.mute.classList.toggle('active', T.muted);
    }
    try {
      if (T.mode === 'trailer' && T.yt && T.ytReady) {
        if (T.muted) T.yt.mute(); else { T.yt.unMute(); T.yt.setVolume(T.volume); }
      }
    } catch (_) {}
    try {
      if (window.MusicPro && typeof window.MusicPro.setVolume === 'function') {
        window.MusicPro.setVolume(T.muted ? 0 : T.volume / 100, true);
      }
    } catch (_) {}
  }
  function setVolume(v, fromSlider) {
    T.volume = clamp(Math.round(v), 0, 100);
    if (T.volume > 0 && fromSlider) T.muted = false;
    store.set('decan_pref_volume', T.volume);
    store.set('decan_pref_muted', T.muted);
    applyAudio();
  }
  function toggleMute() {
    T.muted = !T.muted;
    store.set('decan_pref_muted', T.muted);
    applyAudio();
    if (T.mode === 'embed') toast(T.muted ? 'Decan audio muted (trailers + music). Provider volume uses its own controls.' : 'Decan audio unmuted');
    else toast(T.muted ? 'Trailer muted' : 'Trailer unmuted');
  }
  function setRate(v) {
    if (!SPEEDS.includes(v)) v = 1;
    T.rate = v;
    store.set('decan_pref_rate', v);
    if (els.speedLabel) els.speedLabel.textContent = (v + '').replace(/\.0$/, '') + 'x';
    try { if (T.mode === 'trailer' && T.yt && T.ytReady) T.yt.setPlaybackRate(v); } catch (_) {}
    try { if (window.MusicPro && typeof window.MusicPro.setRate === 'function') window.MusicPro.setRate(v); } catch (_) {}
    toast(T.mode === 'trailer' ? 'Trailer speed: ' + v + 'x' : 'Speed ' + v + 'x saved for trailers + music');
  }

  /* ---------------- sources ---------------- */
  function setSource(id, reload) {
    const found = SOURCES.find((s) => s.id === id);
    if (!found) return;
    T.sourceId = id;
    store.set('decan_pref_source', id);
    setStatusPill();
    if (reload && T.mode === 'embed' && T.open) {
      T.pausedVeil = false;
      mountEmbed(true);
      T.playing = true; startClock(); setPlayingUI(); renderTimes();
      toast('Source switched: ' + found.label + ' — position kept at ' + fmtClock(position()));
    }
  }
  function cycleSource(dir) {
    const i = SOURCES.findIndex((s) => s.id === T.sourceId);
    const n = SOURCES[(i + dir + SOURCES.length) % SOURCES.length];
    setSource(n.id, true);
  }
  function currentStreamUrl() {
    if (!T.item) return '';
    const s = SOURCES.find((x) => x.id === T.sourceId) || SOURCES[0];
    if (T.item.type === 'tv') return s.tv(T.item.id, T.item.season || 1, T.item.episode || 1);
    return s.movie(T.item.id);
  }

  /* ---------------- embed mount ---------------- */
  function mountEmbed(showLoading) {
    const stage = $('#theater-iframe-wrapper');
    if (!stage || !T.item) return;
    destroyTrailer();
    T.streamUrl = currentStreamUrl();
    if (showLoading) showLoader(true);
    // Reuse the platform's iframe when it already points at the wanted stream.
    const existing = stage.querySelector('iframe#decan-theater-iframe');
    const oldYt = $('#tpro-yt'); if (oldYt) oldYt.remove();
    if (existing && existing.src === T.streamUrl) {
      existing.addEventListener('load', () => showLoader(false));
      stageOverlays();
      renderResumePill();
      return;
    }
    stage.querySelectorAll('iframe').forEach((f) => f.remove());
    const f = document.createElement('iframe');
    f.className = 'theater-iframe';
    f.id = 'decan-theater-iframe';
    f.src = T.streamUrl;
    f.allowFullscreen = true;
    f.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture');
    f.setAttribute('title', T.item.title || 'Video player');
    f.addEventListener('load', () => showLoader(false));
    stage.prepend(f);
    stageOverlays();
    renderResumePill();
  }

  /* ---------------- trailer (YouTube API = real controls) ---------------- */
  function ensureYtApi() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (T.ytApiLoading) return T.ytApiLoading;
    T.ytApiLoading = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prev === 'function') { try { prev(); } catch (_) {} }
        resolve();
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => resolve();
      document.head.appendChild(s);
      setTimeout(resolve, 9000);
    });
    return T.ytApiLoading;
  }
  function destroyTrailer() {
    if (T.yt) { try { T.yt.destroy(); } catch (_) {} }
    T.yt = null; T.ytReady = false;
  }
  async function buildTrailerPlayer(reload) {
    const stage = $('#theater-iframe-wrapper');
    if (!stage || !T.ytKey) return;
    destroyTrailer();
    if (reload) showLoader(true, 'Loading trailer…');
    stage.querySelectorAll('iframe').forEach((f) => f.remove());
    let holder = $('#tpro-yt');
    if (!holder) { holder = document.createElement('div'); holder.id = 'tpro-yt'; holder.className = 'tpro-stage'; stage.prepend(holder); }
    else holder.innerHTML = '';
    stageOverlays();
    await ensureYtApi();
    if (!T.open || T.mode !== 'trailer') return;
    if (!(window.YT && window.YT.Player)) {
      // graceful fallback: plain embed still plays
      holder.innerHTML = '<iframe class="theater-iframe" src="https://www.youtube.com/embed/' + encodeURIComponent(T.ytKey) +
        '?autoplay=1&rel=0" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>';
      showLoader(false);
      return;
    }
    const inner = document.createElement('div');
    inner.id = 'tpro-yt-inner';
    inner.style.cssText = 'position:absolute;inset:0;';
    holder.appendChild(inner);
    try {
      T.yt = new window.YT.Player(inner, {
        videoId: T.ytKey,
        playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1, origin: window.location.origin },
        events: {
          onReady: onYtReady,
          onStateChange: onYtState,
          onError: () => {
            showLoader(false);
            setStatusPill();
            toast('Trailer failed to load — please try again');
          }
        }
      });
    } catch (_) {
      showLoader(false);
    }
  }
  function onYtReady() {
    T.ytReady = true;
    showLoader(false);
    try {
      if (T.muted) T.yt.mute(); else { T.yt.unMute(); T.yt.setVolume(T.volume); }
      T.yt.setPlaybackRate(T.rate);
      if (T.base > 5) { try { T.yt.seekTo(T.base, true); } catch (_) {} }
      const d = Number(T.yt.getDuration()) || 0;
      if (d > 0) setDuration(d, true);
    } catch (_) {}
    T.playing = true;
    startClock(); setPlayingUI(); renderTimes();
  }
  function onYtState(e) {
    if (!window.YT) return;
    const PS = window.YT.PlayerState;
    if (e.data === PS.PLAYING) {
      showLoader(false);
      T.playing = true;
      try {
        const d = Number(T.yt.getDuration()) || 0;
        if (d > 0 && !T.durationKnown) setDuration(d, true);
      } catch (_) {}
      startClock();
    } else if (e.data === PS.PAUSED) {
      T.playing = false;
      stopClock(false);
      persistPosition('pause'); flashSaved();
    } else if (e.data === PS.ENDED) {
      T.playing = false;
      stopClock(false);
      T.base = Math.max(0, (T.duration || 0) - 1); T.elapsed = 0;
      persistPosition('ended'); flashSaved();
    } else if (e.data === PS.CUED || e.data === PS.BUFFERING) {
      showLoader(e.data === PS.BUFFERING);
    }
    setPlayingUI(); renderTimes();
  }
  function toggleYtCaptions() {
    if (T.mode !== 'trailer' || !T.yt || !T.ytReady) { toast('YouTube captions are available while a trailer is loaded'); return; }
    try {
      if (T.captionsOn) { T.yt.unloadModule('captions'); T.captionsOn = false; toast('YouTube captions off'); }
      else { T.yt.loadModule('captions'); T.captionsOn = true; toast('YouTube captions on'); }
    } catch (_) { toast('Captions control is unavailable for this trailer'); }
  }

  /* ---------------- custom subtitles ---------------- */
  function parseTimestamp(v) {
    const m = String(v).trim().replace(',', '.').match(/(?:(\d+):)?(\d{1,2}):(\d{1,2})\.(\d{1,3})/);
    if (!m) return null;
    const h = Number(m[1] || 0), mi = Number(m[2]), s = Number(m[3]), ms = Number((m[4] + '000').slice(0, 3));
    return h * 3600 + mi * 60 + s + ms / 1000;
  }
  function parseSubtitles(text) {
    const cues = [];
    const clean = String(text).replace(/\r/g, '').replace(/^WEBVTT[^\n]*\n/, '');
    const blocks = clean.split(/\n\s*\n/);
    blocks.forEach((b) => {
      const lines = b.split('\n').map((x) => x.trim()).filter(Boolean);
      if (!lines.length) return;
      let ti = lines.findIndex((l) => l.indexOf('-->') > -1);
      if (ti < 0) return;
      const parts = lines[ti].split('-->');
      const start = parseTimestamp(parts[0]);
      const end = parseTimestamp(parts[1]);
      const body = lines.slice(ti + 1).join('<br>');
      if (start != null && end != null && body) cues.push({ start, end, body });
    });
    cues.sort((a, b) => a.start - b.start);
    return cues;
  }
  function loadSubtitleFile(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const cues = parseSubtitles(rd.result || '');
        if (!cues.length) { toast('No cues found in that subtitle file'); return; }
        T.subs.cues = cues;
        T.subs.fileName = file.name;
        T.subs.mode = 'custom';
        store.set('decan_pref_sub', 'custom');
        closeMenu();
        renderCaption();
        toast(cues.length + ' subtitle cues loaded — synced to your watch clock');
      } catch (_) { toast('Could not parse that subtitle file'); }
    };
    rd.onerror = () => toast('Could not read that subtitle file');
    rd.readAsText(file);
  }
  function renderCaption() {
    const layer = $('#tpro-caption-layer');
    const cueEl = $('#tpro-caption-cue');
    if (!layer || !cueEl) return;
    if (!T.open || T.subs.mode !== 'custom' || !T.subs.cues.length) { layer.hidden = true; return; }
    const t = position() + Number(T.subs.offset || 0);
    const cue = T.subs.cues.find((c) => t >= c.start && t <= c.end);
    if (cue) {
      cueEl.innerHTML = cue.body;
      cueEl.style.fontSize = T.subs.size + 'px';
      layer.hidden = false;
    } else layer.hidden = true;
  }

  /* ---------------- clock ---------------- */
  function startClock() {
    stopClock(true);
    T.clockTimer = setInterval(() => {
      if (!T.open || !T.playing) return;
      if (document.hidden) return;
      if (T.mode === 'trailer' && T.yt && T.ytReady) {
        try {
          const cur = Number(T.yt.getCurrentTime()) || 0;
          T.base = Math.floor(cur); T.elapsed = 0;
        } catch (_) { T.elapsed += 1; }
      } else {
        T.elapsed += 1;
      }
      renderTimes();
    }, 1000);
    clearInterval(T.saveTimer);
    T.saveTimer = setInterval(() => { if (T.open && T.playing) { persistPosition('auto'); } }, 8000);
  }
  function stopClock(hard) {
    if (T.clockTimer) clearInterval(T.clockTimer);
    T.clockTimer = null;
    if (hard !== false && T.saveTimer) { clearInterval(T.saveTimer); T.saveTimer = null; }
  }
  let _persistT = null;
  function persistSoon() {
    clearTimeout(_persistT);
    _persistT = setTimeout(() => persistPosition('seek'), 600);
  }

  /* ---------------- view modes ---------------- */
  function toggleFullscreen() {
    const c = $('#theater-container');
    if (!c) return;
    try {
      if (document.fullscreenElement) { try { const _p = document.exitFullscreen(); if (_p && _p.catch) _p.catch(() => {}); } catch (_) {} }
      else if (c.requestFullscreen) { try { const _q = c.requestFullscreen(); if (_q && _q.catch) _q.catch(() => toast('Fullscreen was blocked by the browser')); } catch (_) { toast('Fullscreen is not available'); } }
      else toast('Fullscreen is not supported on this device');
    } catch (_) { toast('Fullscreen is not available'); }
  }
  function toggleMini(force) {
    const c = $('#theater-container');
    if (!c || !T.open) return;
    T.mini = typeof force === 'boolean' ? force : !T.mini;
    c.classList.toggle('tpro-mini', T.mini);
    if (els.pip) els.pip.classList.toggle('active', T.mini);
    if (els.miniH) els.miniH.classList.toggle('active', T.mini);
    if (T.mini && document.fullscreenElement) { try { document.exitFullscreen(); } catch (_) {} }
    toast(T.mini ? 'Mini player on — browse while watching' : 'Mini player off');
  }
  async function pipOrMini() {
    // Real browser PiP where a native video element exists, else mini-player mode.
    try {
      const vids = $$('#theater-container video').filter((v) => v.readyState >= 1 && !v.disablePictureInPicture);
      if (vids.length && document.pictureInPictureEnabled) {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await vids[0].requestPictureInPicture();
        return;
      }
    } catch (_) { /* fall through to mini mode */ }
    toggleMini();
  }
  function toggleLights() {
    const c = $('#theater-container');
    if (!c) return;
    T.lightsOut = !T.lightsOut;
    c.classList.toggle('tpro-lights', T.lightsOut);
    c.classList.remove('tpro-idle');
    toast(T.lightsOut ? 'Lights out — controls auto-hide, move to reveal' : 'Lights on');
  }
  function pokeIdle() {
    const c = $('#theater-container');
    if (!c || !T.lightsOut || !T.open) return;
    c.classList.remove('tpro-idle');
    clearTimeout(T.idleTimer);
    T.idleTimer = setTimeout(() => c.classList.add('tpro-idle'), 3000);
  }

  function copyTitleLink() {
    if (!T.item) return;
    const url = window.location.origin + window.location.pathname +
      '?title=' + encodeURIComponent(T.item.type) + '&id=' + encodeURIComponent(T.item.id);
    const done = () => toast('Title link copied');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => toast('Copy was blocked by the browser'));
    else {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (_) { toast('Copy is unavailable'); }
      ta.remove();
    }
  }
  function openStreamTab() {
    const url = T.mode === 'trailer'
      ? 'https://www.youtube.com/watch?v=' + encodeURIComponent(T.ytKey)
      : (T.streamUrl || currentStreamUrl());
    if (!url) { toast('No stream is available to open.'); return; }
    const w = window.open(url, '_blank', 'noopener,noreferrer');
    if (!w) toast('The browser blocked the new window. Allow pop-ups for Decan Movie, then try again.');
  }
  function reportIssue() {
    try {
      const log = store.get('decan_playback_reports', []);
      log.unshift({ key: T.key, mode: T.mode, source: T.sourceId, at: Date.now(), url: window.location.href });
      store.set('decan_playback_reports', log.slice(0, 50));
    } catch (_) {}
    toast('Thanks — this playback issue was logged for review');
  }

  /* ---------------- comments bridge ---------------- */
  function toggleComments(force) {
    if (window.CommentsPro && typeof window.CommentsPro.toggle === 'function') {
      const want = typeof force === 'boolean' ? force : undefined;
      window.CommentsPro.toggle(want, { key: T.key, title: (T.item && T.item.title) || $('#theater-title').textContent || 'This title' });
    } else {
      toast('Comments are still loading — try again in a moment');
    }
  }

  /* ---------------- wiring ---------------- */
  function wireControls() {
    els.play.addEventListener('click', togglePlay);
    els.rw.addEventListener('click', () => seekBy(-10));
    els.fw.addEventListener('click', () => seekBy(10));
    els.prev.addEventListener('click', () => { if (typeof window.playPreviousInQueue === 'function') window.playPreviousInQueue(); });
    els.next.addEventListener('click', () => { if (typeof window.playNextInQueue === 'function') window.playNextInQueue(); });
    els.mute.addEventListener('click', toggleMute);
    els.vol.addEventListener('input', (e) => setVolume(Number(e.target.value), true));
    els.vol.addEventListener('change', () => { if (T.mode === 'embed') toast('Volume saved for trailers + music · ' + (T.muted ? 0 : T.volume) + '%'); });
    els.more.addEventListener('click', () => (els.menu.hidden ? openMoreMenu() : closeMenu()));
    els.qualityBtn.addEventListener('click', () => (els.menu.hidden ? openSourceMenu() : closeMenu()));
    els.speedBtn.addEventListener('click', () => (els.menu.hidden ? openSpeedMenu() : closeMenu()));
    els.subsBtn.addEventListener('click', () => (els.menu.hidden ? openSubsMenu() : closeMenu()));
    els.pip.addEventListener('click', pipOrMini);
    els.commentsH.addEventListener('click', () => toggleComments());
    els.miniH.addEventListener('click', () => toggleMini());
    els.fsH.addEventListener('click', toggleFullscreen);
    els.backdrop.addEventListener('click', closeMenu);
    els.menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (b) handleMenuAction(b.dataset.act);
    });
    els.seek.addEventListener('pointerdown', () => { T.scrubbing = true; });
    els.seek.addEventListener('pointerup', () => { T.scrubbing = false; });
    els.seek.addEventListener('input', (e) => {
      const v = Number(e.target.value) || 0;
      const dur = T.duration || 1;
      e.target.style.setProperty('--fill', clamp((v / dur) * 100, 0, 100) + '%');
      if (els.elapsed) els.elapsed.textContent = fmtClock(v);
    });
    els.seek.addEventListener('change', (e) => { T.scrubbing = false; scrubTo(Number(e.target.value) || 0); });
    els.seek.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') e.stopPropagation();
    });

    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('mousemove', pokeIdle, { passive: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden && T.open) persistPosition('hidden'); });
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      if (els.fsH) els.fsH.classList.toggle('active', on);
    });
  }

  function onKeydown(e) {
    if (!T.open) return;
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
    if (e.key === 'Escape') {
      if (els.menu && !els.menu.hidden) { closeMenu(); e.stopPropagation(); return; }
      if (window.CommentsPro && window.CommentsPro.isOpen && window.CommentsPro.isOpen()) {
        toggleComments(false); e.stopPropagation(); return;
      }
      return; // let the platform close the theater
    }
    if (typing) return;
    const k = e.key;
    if (k === ' ' || k === 'k' || k === 'K') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft' || k === 'j' || k === 'J') { e.preventDefault(); seekBy(-10); }
    else if (k === 'ArrowRight' || k === 'l' || k === 'L') { e.preventDefault(); seekBy(10); }
    else if (k === 'ArrowUp') { e.preventDefault(); setVolume(T.volume + 5, true); }
    else if (k === 'ArrowDown') { e.preventDefault(); setVolume(T.volume - 5, true); }
    else if (k === 'm' || k === 'M') toggleMute();
    else if (k === 'f' || k === 'F') toggleFullscreen();
    else if (k === 't' || k === 'T' || k === 'i' || k === 'I') pipOrMini();
    else if (k === 'c' || k === 'C') toggleComments();
    else if (k === 'r' || k === 'R') restartStream(false);
    else if (k === 'Home') { e.preventDefault(); scrubTo(0); }
    else if (k === 'End' && T.duration) { e.preventDefault(); scrubTo(T.duration - 5); }
  }

  /* ---------------- attach / detach ---------------- */
  function queueLabel() {
    if (!els.pillQueue) return;
    const prev = $('#theater-prev-btn'), next = $('#theater-next-btn');
    const hasPrev = prev && !prev.disabled, hasNext = next && !next.disabled;
    const s = els.pillQueue.querySelector('span');
    if (s) s.textContent = (hasPrev || hasNext) ? 'Up next available' : 'Queue: this title';
  }

  function attachEmbed(item) {
    T.mode = 'embed';
    T.item = item;
    T.key = mediaKeyOf(item);
    T.open = true;
    T.playing = false;
    T.pausedVeil = false;
    T.resumeShown = false;
    T.ytKey = '';
    restoreBookmark();
    ensureDuration();
    mountEmbed(true);
    startClock();
    setPlayingUI(); renderTimes(); renderResumePill();
    applyAudio();
    if (els.speedLabel) els.speedLabel.textContent = (T.rate + '').replace(/\.0$/, '') + 'x';
    queueLabel();
    if (els.container) { els.container.classList.remove('tpro-mini'); T.mini = false; }
    // swap to preferred source if the platform loaded the default
    if (T.sourceId !== 'auto') {
      const want = currentStreamUrl();
      const f = $('#theater-iframe-wrapper iframe');
      if (f && want && f.src !== want) f.src = want;
      T.streamUrl = want;
    }
    if (window.CommentsPro && typeof window.CommentsPro.preload === 'function') {
      window.CommentsPro.preload(T.key);
    }
    if (T.base > 5) {
      setTimeout(() => {
        toast('Resumed at ' + fmtClock(T.base) + ' — ' + progressPct() + '% watched');
        T.resumeShown = true; renderResumePill();
      }, 1200);
    }
  }

  async function attachTrailer(ytKey, title) {
    T.mode = 'trailer';
    T.ytKey = ytKey;
    T.open = true;
    T.playing = false;
    T.pausedVeil = false;
    T.resumeShown = false;
    // trailer context: current title from URL, else last embed item
    let item = T.item;
    try {
      if (typeof window.decanGetTitleFromPath === 'function') {
        const p = window.decanGetTitleFromPath();
        if (p && p.id) item = { id: Number(p.id), type: p.type, media_type: p.type, title: title || 'Trailer', season: 0, episode: 0 };
      }
    } catch (_) {}
    T.item = item || { id: 0, type: 'movie', media_type: 'movie', title: title || 'Trailer', season: 0, episode: 0 };
    T.key = mediaKeyOf(T.item) || ('trailer:' + ytKey);
    T.duration = 0; T.durationKnown = false;
    restoreBookmark();
    buildTrailerPlayer(true);
    setPlayingUI(); renderTimes();
    applyAudio();
    if (els.speedLabel) els.speedLabel.textContent = (T.rate + '').replace(/\.0$/, '') + 'x';
    queueLabel();
    if (els.container) { els.container.classList.remove('tpro-mini'); T.mini = false; }
    if (window.CommentsPro && typeof window.CommentsPro.preload === 'function') {
      window.CommentsPro.preload(T.key);
    }
  }

  function detach() {
    if (!T.open) return;
    persistPosition('close');
    T.open = false;
    T.playing = false;
    stopClock(true);
    closeMenu();
    clearTimeout(T.loadTimeout);
    showLoader(false);
    destroyTrailer();
    if (window.CommentsPro && typeof window.CommentsPro.close === 'function') {
      try { window.CommentsPro.close(); } catch (_) {}
    }
    if (els.container) {
      els.container.classList.remove('tpro-mini', 'tpro-lights', 'tpro-idle');
      T.mini = false; T.lightsOut = false;
    }
    if (document.pictureInPictureElement) { try { document.exitPictureInPicture(); } catch (_) {} }
  }

  /* ---------------- wrap platform player functions ---------------- */
  function wrapGlobals() {
    const origLaunch = window.launchTheaterPlayer;
    window.launchTheaterPlayer = async function (id, type, encodedTitle, seasonNum, episodeNum, options) {
      buildChrome();
      const title = (() => { try { return decodeURIComponent(encodedTitle); } catch (_) { return 'Direct Stream'; } })();
      const item = {
        id: Number(id), type, media_type: type, title,
        season: type === 'tv' ? (seasonNum || 1) : 0,
        episode: type === 'tv' ? (episodeNum || 1) : 0
      };
      let out;
      try {
        out = await origLaunch.call(this, id, type, encodedTitle, seasonNum, episodeNum, options);
      } catch (err) {
        // Original player failed — still bring up the pro shell with recovery tools.
        try {
          $('#theater-container').style.display = 'flex';
          $('#theater-title').textContent = title;
        } catch (_) {}
      }
      try { attachEmbed(item); } catch (err) { console.warn('TheaterPro attach:', err); }
      return out;
    };

    // The shipped launchTrailerModal references undefined variables — override with a
    // working YouTube-API trailer player while keeping its public signature.
    window.launchTrailerModal = async function (youtubeKey, encodedTitle) {
      buildChrome();
      const title = (() => { try { return decodeURIComponent(encodedTitle || ''); } catch (_) { return 'Trailer'; } })();
      try {
        $('#theater-title').textContent = title;
        $('#theater-container').style.display = 'flex';
        const shield = $('#player-adblock-shield');
        if (shield) shield.style.display = 'none';
      } catch (_) {}
      try { await attachTrailer(youtubeKey, title); } catch (err) { console.warn('TheaterPro trailer:', err); }
    };

    const origClose = window.closeTheater;
    window.closeTheater = function () {
      try { detach(); } catch (_) {}
      try { return origClose.apply(this, arguments); } catch (_) {}
      try { $('#theater-container').style.display = 'none'; } catch (_) {}
    };
  }

  /* ---------------- boot ---------------- */
  function boot() {
    buildChrome();
    stageOverlays();
    showLoader(false);
    wrapGlobals();
    setVolume(T.volume, false);
    if (T.muted) applyAudio();
    if (els.speedLabel) els.speedLabel.textContent = (T.rate + '').replace(/\.0$/, '') + 'x';
    window.TheaterPro = {
      toggleComments, openMenu: openMoreMenu, getKey: () => T.key,
      getItem: () => T.item, isOpen: () => T.open, getPosition: position,
      getDuration: () => T.duration, seekBy, togglePlay, setSource, cycleSource
    };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
