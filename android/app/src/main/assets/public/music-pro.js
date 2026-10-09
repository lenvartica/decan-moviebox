/* ============================================================
   DECAN MOVIE — Music Pro
   Dedicated music section with real streaming (iTunes 30s
   previews + built-in radio fallback), queue, shuffle/repeat,
   and a living, performance-friendly visual background.
   ============================================================ */
(function () {
  'use strict';
  if (window.__DECAN_MUSIC_PRO__) return;
  window.__DECAN_MUSIC_PRO__ = true;

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.showToast === 'function') window.showToast(m); };
  const store = {
    get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch (_) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} }
  };
  const fmt = (s) => {
    s = Math.max(0, Math.floor(Number(s) || 0));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  };
  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- state ---------------- */
  const M = {
    audio: null,
    queue: [], index: -1,
    shuffle: false, repeat: 'off',
    volume: 0.8, rate: 1,
    results: [], lastTerm: '',
    playing: false, loadingTrack: false,
    ctx: null, analyser: null, freqData: null, audioLinked: false,
    energy: 0, raf: null, stageVisible: true,
    hue: 190, hue2: 320,
    errorCount: 0
  };
  const STATE_KEY = 'decan_music_state_v1';

  const PRESETS = [
    { label: '🔥 Top Hits', term: 'top hits' },
    { label: '🌍 Afrobeats', term: 'afrobeats' },
    { label: '🎹 Amapiano', term: 'amapiano' },
    { label: '🙏 Gospel', term: 'gospel' },
    { label: '🎤 Hip-Hop', term: 'hip hop' },
    { label: '💜 R&B', term: 'rnb' },
    { label: '🌙 Lo-Fi', term: 'lofi chill' },
    { label: '📻 Decan Radio', term: '__all__' }
  ];

  function radioSeeds() {
    const seeds = [];
    for (let i = 1; i <= 6; i++) {
      seeds.push({
        id: 'radio-' + i,
        title: 'Decan Radio · Instrumental Mix ' + i,
        artist: 'Decan Radio Session',
        album: 'Built-in Radio (always available)',
        art: radioArt(i),
        preview: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-' + i + '.mp3',
        duration: 0, radio: true
      });
    }
    return seeds;
  }
  function radioArt(i) {
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 300;
      const x = c.getContext('2d');
      const h = (i * 47 + 170) % 360;
      const g = x.createLinearGradient(0, 0, 300, 300);
      g.addColorStop(0, 'hsl(' + h + ',70%,28%)');
      g.addColorStop(1, 'hsl(' + ((h + 60) % 360) + ',75%,45%)');
      x.fillStyle = g; x.fillRect(0, 0, 300, 300);
      x.fillStyle = 'rgba(255,255,255,.9)';
      x.font = 'bold 120px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText('♪', 150, 160);
      return c.toDataURL('image/png');
    } catch (_) { return ''; }
  }

  function hashHue(str) {
    let h = 0;
    const s = String(str || 'decan');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  /* ---------------- Supabase full-track data ---------------- */
  const SUPABASE_URL =
    window.DECAN_SUPABASE_URL ||
    window.NEXT_PUBLIC_SUPABASE_URL ||
    window.SUPABASE_URL ||
    (window.supabaseConfig && window.supabaseConfig.url) ||
    (window.DECAN_SUPABASE_CONFIG && window.DECAN_SUPABASE_CONFIG.url) || '';

  const SUPABASE_KEY =
    window.DECAN_SUPABASE_PUBLISHABLE_KEY ||
    window.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    window.DECAN_SUPABASE_ANON_KEY ||
    window.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    window.SUPABASE_ANON_KEY ||
    (window.supabaseConfig && (window.supabaseConfig.publishableKey || window.supabaseConfig.anonKey)) ||
    (window.DECAN_SUPABASE_CONFIG && (window.DECAN_SUPABASE_CONFIG.publishableKey || window.DECAN_SUPABASE_CONFIG.anonKey)) || '';

  const MUSIC_TABLE = window.DECAN_MUSIC_TABLE || 'music_tracks';
  const MUSIC_BUCKET = window.DECAN_MUSIC_BUCKET || 'music';

  function supabaseHeaders() {
    return {
      accept: 'application/json',
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY
    };
  }

  function storageUrl(path) {
    if (!SUPABASE_URL || !path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return SUPABASE_URL.replace(/\/$/, '') +
      '/storage/v1/object/public/' + encodeURIComponent(MUSIC_BUCKET) +
      '/' + String(path).split('/').map(encodeURIComponent).join('/');
  }

  function normalizeTrack(t) {
    if (!t) return null;
    const audioUrl =
      t.audio_url || t.audioUrl || t.stream_url || t.streamUrl ||
      storageUrl(t.audio_path || t.audioPath || t.storage_path || t.storagePath || '');

    if (!audioUrl) return null;

    return {
      id: String(t.id ?? t.track_id ?? t.slug ?? ('track-' + Math.random().toString(36).slice(2))),
      title: t.title || t.track_name || 'Unknown title',
      artist: t.artist || t.artist_name || 'Unknown artist',
      album: t.album || t.collection_name || '',
      art: t.artwork_url || t.artworkUrl || t.cover_url || t.coverUrl ||
        storageUrl(t.artwork_path || t.artworkPath || ''),
      audio_url: audioUrl,
      preview: audioUrl,
      duration: Number(t.duration || t.duration_seconds || t.durationSeconds || 0) || 0,
      genre: t.genre || '',
      language: t.language || '',
      year: t.release_year || t.year || '',
      radio: !!t.radio
    };
  }

  async function searchMusic(term) {
    term = (term || '').trim() || 'top hits';

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      throw new Error('Missing Supabase URL or publishable key');
    }

    const endpoint =
      SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + encodeURIComponent(MUSIC_TABLE);

    const params = new URLSearchParams();
    params.set('select', '*');
    params.set('limit', '60');

    if (term !== '__all__' && term !== 'top hits') {
      const q = term.replace(/[,%]/g, ' ').trim();
      if (q) {
        params.set(
          'or',
          '(title.ilike.*' + q + '*,artist.ilike.*' + q +
          '*,album.ilike.*' + q + '*,genre.ilike.*' + q + '*)'
        );
      }
    }

    let response = await fetch(endpoint + '?' + params.toString(), {
      headers: supabaseHeaders(),
      cache: 'no-store'
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error('Supabase returned ' + response.status + ': ' + body.slice(0, 250));
    }

    const rows = await response.json();
    let tracks = (Array.isArray(rows) ? rows : [])
      .map(normalizeTrack)
      .filter(Boolean);

    // Protect the UI from a schema where unpublished rows are returned.
    tracks = tracks.filter(t => t.audio_url);

    if (term !== '__all__' && term !== 'top hits') {
      const q = term.toLowerCase();
      tracks = tracks.filter(t =>
        [t.title, t.artist, t.album, t.genre]
          .some(v => String(v || '').toLowerCase().includes(q))
      );
    }

    if (!tracks.length) throw new Error('No playable full tracks found');
    return tracks;
  }

  function radioSeeds() {
    // Radio is intentionally disabled here. DECAN Music now uses
    // authorized full-length tracks from Supabase instead of third-party
    // preview/radio URLs.
    return [];
  }

  /* ---------------- persistence ---------------- */
  function persist() {
    store.set(STATE_KEY, {
      queue: M.queue.slice(0, 60), index: M.index,
      shuffle: M.shuffle, repeat: M.repeat, volume: M.volume
    });
  }
  function restore() {
    const s = store.get(STATE_KEY, null);
    if (s && Array.isArray(s.queue) && s.queue.length) {
      M.queue = s.queue;
      M.index = Math.min(Math.max(s.index || 0, 0), M.queue.length - 1);
      M.shuffle = !!s.shuffle; M.repeat = s.repeat || 'off';
    }
    const tv = Number(store.get('decan_pref_volume', 80));
    M.volume = Number.isFinite(tv) ? Math.min(1, Math.max(0, tv / 100)) : 0.8;
    const tr = Number(store.get('decan_pref_rate', 1));
    M.rate = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].includes(tr) ? tr : 1;
  }
  function current() { return M.queue[M.index] || null; }

  /* ---------------- audio core ---------------- */
  function ensureAudio() {
    if (M.audio) return M.audio;
    const a = new Audio();
    a.preload = 'auto';
    a.playsInline = true;
    a.volume = M.volume;
    try { a.muted = JSON.parse(localStorage.getItem('decan_music_muted') || 'false') === true; } catch (_) {}
    a.playbackRate = M.rate;
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', () => { applyDuration(); renderProgress(); });
    a.addEventListener('play', () => { M.playing = true; M.loadingTrack = false; syncPlayUI(); startViz(); });
    a.addEventListener('pause', () => { M.playing = false; syncPlayUI(); });
    a.addEventListener('waiting', () => { M.loadingTrack = true; syncPlayUI(); });
    a.addEventListener('playing', () => { M.loadingTrack = false; syncPlayUI(); });
    a.addEventListener('ended', onEnded);
    a.addEventListener('error', onAudioError);
    a.addEventListener('stalled', () => { M.loadingTrack = true; syncPlayUI(); });
    a.addEventListener('canplay', () => { M.loadingTrack = false; syncPlayUI(); });
    M.audio = a;
    return a;
  }

  function linkAnalyser() {
    if (M.audioLinked) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !M.audio) return;
      M.ctx = new AC();
      const src = M.ctx.createMediaElementSource(M.audio);
      M.analyser = M.ctx.createAnalyser();
      M.analyser.fftSize = 64;
      M.analyser.smoothingTimeConstant = 0.8;
      src.connect(M.analyser);
      M.analyser.connect(M.ctx.destination);
      M.freqData = new Uint8Array(M.analyser.frequencyBinCount);
      M.audioLinked = true;
    } catch (_) { M.audioLinked = false; }
  }

  function playAt(i, autoplay) {
    ensureAudio();
    if (!M.queue.length) return;
    M.index = (i + M.queue.length) % M.queue.length;
    const t = current();
    M.errorCount = 0;
    M.audio.pause();
    M.audio.removeAttribute('src');
    M.audio.load();
    M.audio.src = t.audio_url;
    M.audio.load();
    M.audio.playbackRate = M.rate;
    M.audio.volume = M.volume;
    M.hue = hashHue(t.id + t.title); M.hue2 = (M.hue + 80 + (t.title.length * 7) % 120) % 360;
    applyTheme(); renderNow(); renderQueue(); renderMini(); persist();
    if (autoplay !== false) {
      if (M.ctx && M.ctx.state === 'suspended') { try { const _r = M.ctx.resume(); if (_r && _r.catch) _r.catch(() => {}); } catch (_) {} }
      M.loadingTrack = true; syncPlayUI();
      safePlay(() => { M.loadingTrack = false; syncPlayUI(); });
    } else { renderProgress(); }
  }

  function safePlay(onFail) {
    if (!M.audio) return;
    let settled = false;
    const fail = () => { if (!settled) { settled = true; if (onFail) onFail(); } };
    const ok = () => { settled = true; cleanup(); };
    const cleanup = () => {
      try {
        M.audio.removeEventListener('canplay', retry);
        M.audio.removeEventListener('loadeddata', retry);
      } catch (_) {}
    };
    const retry = () => {
      cleanup();
      try {
        const p2 = M.audio.play();
        if (p2 && typeof p2.then === 'function') p2.then(ok).catch(fail);
        else ok();
      } catch (_) { fail(); }
    };
    try {
      const p = M.audio.play();
      if (p && typeof p.then === 'function') {
        p.then(ok).catch((err) => {
          if (err && err.name === 'NotAllowedError') {
            settled = true;
            M.loadingTrack = false;
            syncPlayUI();
            toast('Press Play to start music — your browser blocked automatic playback.');
            return;
          }
          try {
            M.audio.addEventListener('canplay', retry, { once: true });
            M.audio.addEventListener('loadeddata', retry, { once: true });
          } catch (_) { fail(); }
          setTimeout(() => { if (!settled) retry(); }, 1200);
        });
      } else ok();
    } catch (_) { fail(); }
  }
  function togglePlay() {
    ensureAudio();
    if (!current()) {
      if (M.results.length) { M.queue = M.results.slice(); playAt(0); }
      else { toast('Search for a song or choose a music category first'); return; }
      return;
    }
    if (M.audio.paused) {
      if (M.ctx && M.ctx.state === 'suspended') { try { M.ctx.resume().catch(() => {}); } catch (_) {} }
      safePlay(() => toast('Playback was blocked — tap play again'));
    } else { try { M.audio.pause(); } catch (_) {} }
  }

  function next(auto) {
    if (!M.queue.length) return;
    if (M.repeat === 'one' && auto) { ensureAudio(); try { M.audio.currentTime = 0; } catch (_) {} safePlay(); return; }
    if (M.shuffle && M.queue.length > 1) {
      let n = M.index;
      let guard = 0;
      while (n === M.index && guard++ < 10) n = Math.floor(Math.random() * M.queue.length);
      playAt(n);
      return;
    }
    const n = M.index + 1;
    if (n >= M.queue.length) {
      if (M.repeat === 'all' || auto === false) playAt(0);
      else { ensureAudio(); M.audio.pause(); M.audio.currentTime = 0; toast('End of queue — repeat is off'); }
      return;
    }
    playAt(n);
  }
  function prev() {
    ensureAudio();
    if (!current()) return;
    if (M.audio.currentTime > 3) { M.audio.currentTime = 0; return; }
    playAt(M.index - 1);
  }
  function seekBy(d) {
    ensureAudio();
    if (!current()) return;
    const dur = Number(M.audio.duration) || (current().duration || 0);
    M.audio.currentTime = Math.min(Math.max(0, (M.audio.currentTime || 0) + d), Math.max(0, dur - 0.2));
    renderProgress();
  }
  function onEnded() {
    if (M.repeat === 'one') { try { M.audio.currentTime = 0; } catch (_) {} safePlay(); return; }
    if (M.index >= M.queue.length - 1 && M.repeat !== 'all') {
      M.playing = false; syncPlayUI(); persist();
      return;
    }
    next(true);
  }
  function onAudioError() {
    M.loadingTrack = false;
    const t = current();
    M.errorCount++;
    if (t && M.errorCount <= 2 && M.queue.length > 1) {
      toast('This full song failed to load — skipping to the next track');
      setTimeout(() => next(true), 900);
      return;
    }
    syncPlayUI();
    renderNow();
    toast('This track could not load. Press Play again or choose another track.');
  }
  function onTime() { renderProgress(); }
  function applyDuration() {
    const t = current();
    if (t && M.audio && Number.isFinite(M.audio.duration) && M.audio.duration > 0) {
      t.duration = Math.round(M.audio.duration);
    }
  }

  /* ---------------- UI: section ---------------- */
  function sectionEl() { return $('#music-section'); }
  function buildSection() {
    const sec = sectionEl();
    if (!sec || sec.dataset.built) return;
    sec.dataset.built = '1';
    sec.innerHTML =
      '<div class="mpro-searchbar">' +
        '<input class="mpro-input" id="mpro-q" placeholder="Search songs, artists, albums…" aria-label="Search music">' +
        '<button id="mpro-go" type="button"><i class="fas fa-search"></i> Search</button>' +
      '</div>' +
      '<div class="mpro-chips" id="mpro-chips">' +
        PRESETS.map((p, i) => '<button class="mpro-chip' + (i === 0 ? ' active' : '') + '" type="button" data-term="' + esc(p.term) + '">' + esc(p.label) + '</button>').join('') +
      '</div>' +
      '<div class="mpro-stage" id="mpro-stage">' +
        '<canvas class="mpro-bg" id="mpro-viz" aria-hidden="true"></canvas>' +
        '<div class="mpro-now">' +
          '<div class="mpro-artwrap">' +
            '<div class="mpro-art-ring"></div>' +
            '<img class="mpro-art" id="mpro-art" alt="Album artwork">' +
            '<span class="mpro-live-dot"><i></i>PLAYING</span>' +
          '</div>' +
          '<div class="mpro-track-meta">' +
            '<div class="mpro-kicker">NOW PLAYING</div>' +
            '<div class="mpro-track-title" id="mpro-title">Pick something to play</div>' +
            '<div class="mpro-track-artist" id="mpro-artist">Search above or try Decan Radio</div>' +
            '<div class="mpro-track-album" id="mpro-album"></div>' +
            '<div class="mpro-progress">' +
              '<input type="range" id="mpro-seek" min="0" max="30" value="0" step="0.5" aria-label="Music seek">' +
              '<div class="mpro-times"><span id="mpro-cur">0:00</span><span id="mpro-dur">0:00</span></div>' +
            '</div>' +
            '<div class="mpro-controls">' +
              '<button class="mpro-btn tiny" id="mpro-shuffle" type="button" aria-label="Shuffle"><i class="fas fa-shuffle"></i></button>' +
              '<button class="mpro-btn" id="mpro-prev" type="button" aria-label="Previous track"><i class="fas fa-backward-step"></i></button>' +
              '<button class="mpro-btn" id="mpro-rw" type="button" aria-label="Back 10 seconds"><i class="fas fa-rotate-left"></i></button>' +
              '<button class="mpro-btn main" id="mpro-play" type="button" aria-label="Play or pause"><i class="fas fa-play"></i></button>' +
              '<button class="mpro-btn" id="mpro-fw" type="button" aria-label="Forward 10 seconds"><i class="fas fa-rotate-right"></i></button>' +
              '<button class="mpro-btn" id="mpro-next" type="button" aria-label="Next track"><i class="fas fa-forward-step"></i></button>' +
              '<button class="mpro-btn tiny" id="mpro-repeat" type="button" aria-label="Repeat mode"><i class="fas fa-repeat"></i></button>' +
            '</div>' +
          '</div>' +
          '<div class="mpro-queue">' +
            '<div class="mpro-queue-head"><i class="fas fa-list-music"></i> Queue <span id="mpro-qcount" style="color:#8b8f9e;font-weight:700;"></span><button id="mpro-qclear" type="button">Clear</button></div>' +
            '<div class="mpro-queue-list" id="mpro-qlist"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="mpro-results" id="mpro-results"></div>';

    $('#mpro-play').addEventListener('click', togglePlay);
    $('#mpro-prev').addEventListener('click', prev);
    $('#mpro-next').addEventListener('click', () => next(false));
    $('#mpro-rw').addEventListener('click', () => seekBy(-10));
    $('#mpro-fw').addEventListener('click', () => seekBy(10));
    $('#mpro-shuffle').addEventListener('click', () => {
      M.shuffle = !M.shuffle; persist(); syncModeUI();
      toast(M.shuffle ? 'Shuffle on' : 'Shuffle off');
    });
    $('#mpro-repeat').addEventListener('click', () => {
      M.repeat = M.repeat === 'off' ? 'all' : (M.repeat === 'all' ? 'one' : 'off');
      persist(); syncModeUI();
      toast(M.repeat === 'off' ? 'Repeat off' : (M.repeat === 'all' ? 'Repeat queue' : 'Repeat this track'));
    });
    $('#mpro-seek').addEventListener('input', (e) => {
      ensureAudio();
      if (!current()) return;
      const v = Number(e.target.value) || 0;
      M.audio.currentTime = v;
      renderProgress();
    });
    $('#mpro-qclear').addEventListener('click', () => {
      if (!M.queue.length) return;
      ensureAudio(); M.audio.pause();
      M.queue = []; M.index = -1; M.playing = false;
      renderNow(); renderQueue(); renderMini(); syncPlayUI(); persist();
      toast('Queue cleared');
    });
    let deb = null;
    $('#mpro-q').addEventListener('input', (e) => {
      clearTimeout(deb);
      deb = setTimeout(() => runSearch(e.target.value), 550);
    });
    $('#mpro-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(e.target.value); });
    $('#mpro-go').addEventListener('click', () => runSearch($('#mpro-q').value));
    $('#mpro-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-term]');
      if (!b) return;
      $$('#mpro-chips .mpro-chip').forEach((c) => c.classList.remove('active'));
      b.classList.add('active');
      $('#mpro-q').value = b.dataset.term === '__all__' ? '' : b.dataset.term;
      runSearch(b.dataset.term);
    });
    observeStage();
  }

  async function runSearch(term) {
    term = (term || '').trim() || 'top hits';
    M.lastTerm = term;
    const box = $('#mpro-results');
    if (!box) return;
    box.innerHTML = Array(8).fill('<div class="mpro-skel-card"></div>').join('');
    try {
      const tracks = await searchMusic(term);
      M.results = tracks;
      renderResults();
    } catch (_) {
      M.results = [];
      renderResults();
      toast('Music could not load from Supabase. Check your table, Storage bucket, and policies.');
    }
  }

  function renderResults() {
    const box = $('#mpro-results');
    if (!box) return;
    if (!M.results.length) {
      box.innerHTML = '<div class="mpro-state"><i class="fas fa-music"></i><b>No tracks found</b><br>Try another search or Decan Radio.</div>';
      return;
    }
    box.innerHTML = M.results.map((t, i) =>
      '<article class="mpro-card" data-i="' + i + '">' +
        '<div class="art"><img loading="lazy" src="' + esc(t.art) + '" alt="' + esc(t.title) + ' artwork" onerror="this.style.display=\'none\'">' +
        '<div class="play-ov"><i class="fas fa-play"></i></div></div>' +
        '<div class="inf"><b>' + esc(t.title) + '</b><span>' + esc(t.artist) + '</span>' +
        '<div class="addrow"><button data-act="play" type="button"><i class="fas fa-play"></i> Play</button>' +
        '<button data-act="queue" type="button"><i class="fas fa-plus"></i> Queue</button></div></div>' +
      '</article>').join('');
  }

  function wireResults() {
    const box = $('#mpro-results');
    if (!box || box.dataset.wired) return;
    box.dataset.wired = '1';
    box.addEventListener('click', (e) => {
      const card = e.target.closest('.mpro-card');
      if (!card) return;
      const i = Number(card.dataset.i);
      const t = M.results[i];
      if (!t) return;
      const actBtn = e.target.closest('[data-act]');
      const act = actBtn ? actBtn.dataset.act : 'play';
      if (act === 'queue') {
        M.queue.push(t); persist(); renderQueue();
        toast('Added to queue: ' + t.title);
        if (M.index === -1) playAt(M.queue.length - 1);
      } else {
        M.queue = M.results.slice(); persist();
        playAt(i);
      }
    });
  }

  /* ---------------- UI: now / queue / mini ---------------- */
  function applyTheme() {
    const st = $('#mpro-stage');
    if (st) { st.style.setProperty('--mpro-hue', M.hue); st.style.setProperty('--mpro-hue2', M.hue2); }
  }
  function renderNow() {
    const t = current();
    const title = $('#mpro-title'), artist = $('#mpro-artist'), album = $('#mpro-album'), art = $('#mpro-art');
    if (!title) return;
    if (!t) {
      title.textContent = 'Pick something to play';
      artist.textContent = 'Search above or try Decan Radio';
      album.textContent = '';
      if (art) { art.removeAttribute('src'); art.alt = 'No track selected'; }
    } else {
      title.textContent = t.title;
      artist.textContent = t.artist;
      album.textContent = (t.album ? t.album + ' · ' : '') + (t.radio ? 'Full radio stream' : 'Full track · ' + fmt(t.duration || 0));
      if (art) { art.src = t.art || ''; art.alt = t.title + ' artwork'; }
    }
    renderProgress(); syncPlayUI();
  }
  function renderProgress() {
    ensureAudio();
    const t = current();
    const seek = $('#mpro-seek'), cur = $('#mpro-cur'), dur = $('#mpro-dur');
    if (!seek) return;
    const pos = t ? (M.audio.currentTime || 0) : 0;
    const total = t ? (Number(M.audio.duration) > 0 ? M.audio.duration : (t.duration || 0)) : 0;
    seek.max = Math.max(1, total || 1);
    if (document.activeElement !== seek) seek.value = pos;
    seek.style.setProperty('--fill', (total ? (pos / total) * 100 : 0) + '%');
    if (cur) cur.textContent = fmt(pos);
    if (dur) dur.textContent = fmt(total);
    const mp = $('#mpro-mini .mprog');
    if (mp) mp.style.width = (total ? (pos / total) * 100 : 0) + '%';
  }
  function renderQueue() {
    const list = $('#mpro-qlist');
    if (!list) return;
    $('#mpro-qcount').textContent = M.queue.length ? '(' + M.queue.length + ')' : '';
    if (!M.queue.length) {
      list.innerHTML = '<div class="mpro-queue-empty"><i class="fas fa-list-music"></i><br>Your queue is empty.<br>Press <b>+ Queue</b> on any track.</div>';
      return;
    }
    list.innerHTML = M.queue.map((t, i) =>
      '<div class="mpro-qitem' + (i === M.index ? ' current' : '') + '" data-i="' + i + '">' +
        '<img loading="lazy" src="' + esc(t.art) + '" alt="" onerror="this.style.display=\'none\'">' +
        '<div class="t"><b>' + esc(t.title) + '</b><span>' + esc(t.artist) + '</span></div>' +
        '<button class="rm" data-rm="' + i + '" type="button" aria-label="Remove from queue"><i class="fas fa-xmark"></i></button>' +
      '</div>').join('');
  }
  function wireQueue() {
    const list = $('#mpro-qlist');
    if (!list || list.dataset.wired) return;
    list.dataset.wired = '1';
    list.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) {
        e.stopPropagation();
        const i = Number(rm.dataset.rm);
        M.queue.splice(i, 1);
        if (i < M.index) M.index--;
        else if (i === M.index) {
          ensureAudio(); M.audio.pause();
          if (!M.queue.length) { M.index = -1; M.playing = false; }
          else { M.index = Math.min(M.index, M.queue.length - 1); playAt(M.index); }
        }
        persist(); renderNow(); renderQueue(); renderMini(); syncPlayUI();
        toast('Removed from queue');
        return;
      }
      const row = e.target.closest('.mpro-qitem');
      if (row) playAt(Number(row.dataset.i));
    });
  }

  function buildMini() {
    if ($('#mpro-mini')) return;
    const bar = document.createElement('div');
    bar.id = 'mpro-mini';
    bar.setAttribute('aria-label', 'Mini music player');
    bar.innerHTML =
      '<div class="mprog"></div>' +
      '<img id="mpro-mini-art" alt="Track artwork">' +
      '<div class="mt" id="mpro-mini-meta"><b id="mpro-mini-title">—</b><span id="mpro-mini-artist">—</span></div>' +
      '<button id="mpro-mini-prev" type="button" aria-label="Previous"><i class="fas fa-backward-step"></i></button>' +
      '<button id="mpro-mini-play" class="main" type="button" aria-label="Play or pause"><i class="fas fa-play"></i></button>' +
      '<button id="mpro-mini-next" type="button" aria-label="Next"><i class="fas fa-forward-step"></i></button>';
    document.body.appendChild(bar);
    $('#mpro-mini-play').addEventListener('click', togglePlay);
    $('#mpro-mini-prev').addEventListener('click', prev);
    $('#mpro-mini-next').addEventListener('click', () => next(false));
    $('#mpro-mini-meta').addEventListener('click', () => { showMusic(); setTimeout(() => { const st = $('#mpro-stage'); if (st && st.scrollIntoView) { try { st.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) {} } }, 60); });
  }
  function renderMini() {
    const bar = $('#mpro-mini');
    if (!bar) return;
    const t = current();
    bar.classList.toggle('show', !!t);
    document.body.classList.toggle('mpro-has-mini', !!t);
    if (t) {
      $('#mpro-mini-title').textContent = t.title;
      $('#mpro-mini-artist').textContent = t.artist;
      const im = $('#mpro-mini-art');
      if (im) { im.src = t.art || ''; im.alt = t.title + ' artwork'; }
    }
    syncPlayUI();
  }
  function syncPlayUI() {
    const icon = M.loadingTrack ? '<i class="fas fa-circle-notch fa-spin"></i>' : (M.playing ? '<i class="fas fa-pause"></i>' : '<i class="fas fa-play"></i>');
    const main = $('#mpro-play');
    if (main) { main.innerHTML = icon; main.setAttribute('aria-label', M.playing ? 'Pause' : 'Play'); }
    const mini = $('#mpro-mini-play');
    if (mini) mini.innerHTML = icon;
    const st = $('#mpro-stage');
    if (st) st.classList.toggle('is-playing', M.playing);
    syncModeUI();
  }
  function syncModeUI() {
    const sh = $('#mpro-shuffle');
    if (sh) sh.classList.toggle('active', M.shuffle);
    const rp = $('#mpro-repeat');
    if (rp) {
      rp.classList.toggle('active', M.repeat !== 'off');
      rp.innerHTML = M.repeat === 'one' ? '<i class="fas fa-repeat"></i><sup style="font-size:.55rem;">1</sup>' : '<i class="fas fa-repeat"></i>';
      rp.setAttribute('aria-label', 'Repeat: ' + M.repeat);
    }
  }

  /* ---------------- living background ---------------- */
  const blobs = [];
  function seedBlobs() {
    blobs.length = 0;
    for (let i = 0; i < 5; i++) {
      blobs.push({
        bx: Math.random(), by: Math.random(),
        r: 0.28 + Math.random() * 0.3,
        sp: 0.12 + Math.random() * 0.25,
        ph: Math.random() * Math.PI * 2,
        hueShift: (i * 37) % 90 - 20
      });
    }
  }
  function observeStage() {
    try {
      const st = $('#mpro-stage');
      if (!st || !('IntersectionObserver' in window)) return;
      const io = new IntersectionObserver((ents) => {
        M.stageVisible = ents[0].isIntersecting;
        if (M.stageVisible) startViz(); else stopViz();
      }, { threshold: 0.05 });
      io.observe(st);
    } catch (_) {}
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopViz(); else startViz(); });
  }
  function startViz() {
    if (M.raf || reducedMotion()) return;
    if (!M.stageVisible) return;
    if (document.hidden) return;
    const cv = $('#mpro-viz');
    if (!cv) return;
    seedBlobsIfNeeded();
    let last = performance.now();
    const loop = (now) => {
      M.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      drawViz(cv, now / 1000, dt);
    };
    M.raf = requestAnimationFrame(loop);
  }
  function seedBlobsIfNeeded() { if (!blobs.length) seedBlobs(); }
  function stopViz() {
    if (M.raf) cancelAnimationFrame(M.raf);
    M.raf = null;
  }
  function drawViz(cv, t, dt) {
    const box = cv.parentElement.getBoundingClientRect();
    const w = Math.max(2, Math.floor(box.width)), h = Math.max(2, Math.floor(box.height));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    const x = cv.getContext('2d');
    if (!x) { stopViz(); return; }
    x.clearRect(0, 0, w, h);
    // smooth energy toward playback activity (calm when paused)
    const target = M.playing ? 1 : 0.12;
    M.energy += (target - M.energy) * Math.min(1, dt * 2.2);
    let bands = null;
    if (M.audioLinked && M.analyser && M.playing) {
      try {
        M.analyser.getByteFrequencyData(M.freqData);
        bands = M.freqData;
      } catch (_) { bands = null; }
    }
    x.globalCompositeOperation = 'lighter';
    blobs.forEach((b, i) => {
      const speed = b.sp * (0.35 + M.energy);
      const px = (b.bx + 0.16 * Math.sin(t * speed + b.ph)) * w;
      const py = (b.by + 0.16 * Math.cos(t * speed * 0.9 + b.ph * 1.7)) * h;
      let boost = 0;
      if (bands && bands.length) {
        const v = bands[Math.floor((i + 1) * bands.length / 7)] / 255;
        boost = Number.isFinite(v) ? v : 0;
      }
      const rad = Math.max(w, h) * b.r * (0.75 + M.energy * 0.45 + boost * 0.35);
      const hue = (M.hue + b.hueShift + 360) % 360;
      const g = x.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, 'hsla(' + hue + ',85%,60%,' + (0.16 + M.energy * 0.14 + boost * 0.1) + ')');
      g.addColorStop(1, 'hsla(' + hue + ',85%,60%,0)');
      x.fillStyle = g;
      x.beginPath(); x.arc(px, py, rad, 0, Math.PI * 2); x.fill();
    });
    x.globalCompositeOperation = 'source-over';
  }

  /* ---------------- show / hide ---------------- */
  function setMenuActive() {
    $$('.menu-link').forEach((l) => l.classList.remove('active'));
    const m = $('#decan-music-menu');
    if (m) m.classList.add('active');
  }
  function showMusic() {
    if (typeof window.resetFeatureSurfaces === 'function') window.resetFeatureSurfaces();
    buildSection(); wireResults(); wireQueue(); buildMini();
    const grid = $('#movie-grid');
    if (grid) grid.style.display = 'none';
    const pag = $('.pagination-container');
    if (pag) pag.style.display = 'none';
    const rail = $('#continue-rail');
    if (rail) rail.hidden = true;
    const sec = sectionEl();
    if (sec) sec.hidden = false;
    const gt = $('#grid-title');
    if (gt) gt.textContent = 'Music';
    setMenuActive();
    if (window.innerWidth <= 900 && typeof window.setMobileMenu === 'function') { try { window.setMobileMenu(false); } catch (_) {} }
    const sb = $('#sidebar-menu');
    if (sb && window.innerWidth <= 900) sb.classList.remove('open');
    const mbd = $('#menu-backdrop');
    if (mbd) mbd.classList.remove('open');
    applyTheme(); renderNow(); renderQueue(); renderMini(); syncPlayUI();
    if (!M.results.length) runSearch('top hits');
    startViz();
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) {}
  }
  function hideMusicSection() {
    const sec = sectionEl();
    if (sec) sec.hidden = true;
    const grid = $('#movie-grid');
    if (grid) grid.style.display = '';
    const pag = $('.pagination-container');
    if (pag) pag.style.display = '';
    try { document.dispatchEvent(new CustomEvent('decan:continue-updated', { detail: { reason: 'view' } })); } catch (_) {}
  }
  function musicVisible() {
    const sec = sectionEl();
    return !!(sec && !sec.hidden);
  }

  /*
   * DECAN FULL-SONG REQUIREMENTS
   * -----------------------------
   * Supabase table: public.music_tracks
   * Required: title, audio_path OR audio_url, published
   *
   * Storage bucket: music
   * Example audio_path: songs/my-authorized-song.mp3
   *
   * For a PUBLIC bucket, audio_path is converted to a public Storage URL.
   * For a PRIVATE bucket, provide a valid signed URL in audio_url from a
   * trusted backend. Never put a Supabase service_role key in this file.
   */
  function toggleMute() {
    ensureAudio();
    const next = !M.audio.muted;
    M.audio.muted = next;
    if (!next && M.audio.volume <= 0) M.audio.volume = M.volume || 0.8;
    try { localStorage.setItem('decan_music_muted', JSON.stringify(next)); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('decan:music-state')); } catch (_) {}
    toast(next ? 'Music muted' : 'Music unmuted');
    return next;
  }
  function isMuted() { return !!(M.audio && M.audio.muted); }

  /* ---------------- boot ---------------- */
  function boot() {
    restore();
    buildSection(); wireResults(); wireQueue(); buildMini();
    // restore last session (paused — browsers block autoplay anyway)
    if (M.queue.length && M.index >= 0) {
      ensureAudio();
      const t = current();
      if (t) {
        M.audio.src = t.audio_url;
        M.audio.load();
        M.audio.volume = M.volume;
        M.hue = hashHue(t.id + t.title); M.hue2 = (M.hue + 90) % 360;
        applyTheme(); renderNow(); renderQueue(); renderMini();
      }
    }
    syncModeUI();
    // wrap platform view resets so Music hides whenever another view opens
    try {
      if (typeof window.resetFeatureSurfaces === 'function' && !window.resetFeatureSurfaces.__mpro__) {
        const orig = window.resetFeatureSurfaces;
        const wrapped = function () { hideMusicSection(); return orig.apply(this, arguments); };
        wrapped.__mpro__ = true;
        window.resetFeatureSurfaces = wrapped;
      }
      if (typeof window.switchCategory === 'function' && !window.switchCategory.__mpro__) {
        const orig = window.switchCategory;
        const wrapped = function () { hideMusicSection(); return orig.apply(this, arguments); };
        wrapped.__mpro__ = true;
        window.switchCategory = wrapped;
      }
      // pause music when video theater opens
      if (typeof window.launchTheaterPlayer === 'function' && !window.launchTheaterPlayer.__mpro__) {
        const orig = window.launchTheaterPlayer;
        const wrapped = async function () {
          try {
            if (M.audio && !M.audio.paused) { M.audio.pause(); toast('Music paused for video'); }
          } catch (_) {}
          return orig.apply(this, arguments);
        };
        wrapped.__mpro__ = true;
        window.launchTheaterPlayer = wrapped;
      }
      if (typeof window.launchTrailerModal === 'function' && !window.launchTrailerModal.__mpro__) {
        const orig = window.launchTrailerModal;
        const wrapped = async function () {
          try { if (M.audio && !M.audio.paused) M.audio.pause(); } catch (_) {}
          return orig.apply(this, arguments);
        };
        wrapped.__mpro__ = true;
        window.launchTrailerModal = wrapped;
      }
    } catch (_) {}

    window.MusicPro = {
      show: showMusic, togglePlay, next, prev, toggleMute, isMuted,
      setVolume(v01, silent) {
        M.volume = Math.min(1, Math.max(0, Number(v01) || 0));
        if (M.audio) M.audio.volume = M.volume;
        if (!silent) {
          try { localStorage.setItem('decan_pref_volume', JSON.stringify(Math.round(M.volume * 100))); } catch (_) {}
        }
      },
      setRate(r) { M.rate = r; if (M.audio) M.audio.playbackRate = r; },
      isVisible: musicVisible
    };
    window.showMusic = showMusic;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
