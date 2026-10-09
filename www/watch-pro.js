/* ============================================================
   DECAN MOVIE — Watch Pro
   Continue-watching rail, resume helpers, and history
   management. Reuses the platform's continue/history stores
   and cloud sync — presentation + management only.
   ============================================================ */
(function () {
  'use strict';
  if (window.__DECAN_WATCH_PRO__) return;
  window.__DECAN_WATCH_PRO__ = true;

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.showToast === 'function') window.showToast(m); };
  const IMG = 'https://image.tmdb.org/t/p/w500';
  const FALLBACK = 'https://images.unsplash.com/photo-1594322436404-5a0526db4d13?q=80&w=400';

  function getList() {
    try { return JSON.parse(localStorage.getItem('decan_continue_watching') || '[]'); } catch (_) { return []; }
  }
  function setList(l) {
    try { localStorage.setItem('decan_continue_watching', JSON.stringify(l)); } catch (_) {}
    try { if (typeof window.updateLibraryStats === 'function') window.updateLibraryStats(); } catch (_) {}
  }
  function sameKey(a, b) {
    return Number(a.id) === Number(b.id) &&
      (a.type || a.media_type || 'movie') === (b.type || b.media_type || 'movie') &&
      Number(a.season || 0) === Number(b.season || 0) &&
      Number(a.episode || 0) === Number(b.episode || 0);
  }
  function fmtPos(sec) {
    if (typeof window.formatPlaybackTime === 'function') return window.formatPlaybackTime(sec);
    const n = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(n / 60) + 'm ' + String(n % 60).padStart(2, '0') + 's';
  }
  function timeAgo(ts) {
    const d = Date.now() - Number(ts || 0);
    if (!Number.isFinite(d) || d < 0) return '';
    const m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const days = Math.floor(h / 24);
    if (days < 7) return days + 'd ago';
    return new Date(Number(ts)).toLocaleDateString();
  }
  function gridVisible() {
    const g = $('#movie-grid');
    if (!g || g.style.display === 'none') return false;
    const ms = $('#music-section');
    if (ms && !ms.hidden) return false;
    return true;
  }

  /* ---------------- home rail ---------------- */
  let lastRail = 0;
  function renderRail() {
    const now = Date.now();
    const rail = $('#continue-rail');
    if (!rail) return;
    const list = getList().filter((x) => x && x.id != null);
    const shouldShow = list.length > 0 && gridVisible();
    // Visibility flips always apply immediately; throttling only skips
    // redundant content re-renders while state is unchanged.
    if (rail.hidden === !shouldShow && now - lastRail < 1500) return;
    lastRail = now;
    if (!shouldShow) { rail.hidden = true; rail.innerHTML = ''; return; }
    const prevScroll = rail.querySelector('.wpro-track') ? rail.querySelector('.wpro-track').scrollLeft : 0;
    rail.hidden = false;
    const cards = list.slice(0, 12).map((item) => {
      const title = item.title || item.name || 'Untitled';
      const type = item.type || item.media_type || 'movie';
      const poster = item.poster_path ? IMG + item.poster_path : FALLBACK;
      const pct = Math.max(0, Math.min(100, Number(item.progress_percent || 0)));
      const resume = item.progress_seconds ? 'Resume at ' + fmtPos(item.progress_seconds) : 'Ready to watch';
      const when = item.updated_at ? timeAgo(item.updated_at) : '';
      const ep = item.season ? ('S' + item.season + ' E' + (item.episode || 1)) : (type === 'tv' ? 'Series' : 'Movie');
      return '<article class="wpro-card" data-id="' + Number(item.id) + '" data-type="' + esc(type) + '"' +
        ' data-season="' + Number(item.season || 0) + '" data-episode="' + Number(item.episode || 0) + '">' +
        '<div class="wpro-poster" data-act="play" role="button" tabindex="0" aria-label="Continue watching ' + esc(title) + '">' +
          '<img loading="lazy" src="' + esc(poster) + '" alt="' + esc(title) + ' poster">' +
          '<button class="wpro-play" type="button" aria-label="Play"><i class="fas fa-play"></i></button>' +
          '<button class="wpro-x" data-act="rm" type="button" aria-label="Remove from Continue Watching"><i class="fas fa-xmark"></i></button>' +
        '</div>' +
        '<div class="wpro-info"><b>' + esc(title) + '</b>' +
          '<span class="wpro-sub">' + esc(ep) + (when ? ' · ' + esc(when) : '') + '</span>' +
          '<div class="wpro-bar" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100" aria-label="' + pct + '% watched"><i style="width:' + pct + '%"></i></div>' +
          '<span class="wpro-sub">' + esc(resume) + ' · ' + pct + '%</span>' +
          '<button class="wpro-continue" data-act="play" type="button"><i class="fas fa-play"></i> Continue watching</button>' +
        '</div></article>';
    }).join('');
    rail.innerHTML =
      '<div class="wpro-rail-head"><h2><i class="fas fa-forward"></i>Continue Watching</h2>' +
      '<button class="wpro-viewall" data-act="all" type="button">View all</button></div>' +
      '<div class="wpro-track">' + cards + '</div>';
  }

  function wireRail() {
    const rail = $('#continue-rail');
    if (!rail || rail.dataset.wired) return;
    rail.dataset.wired = '1';
    rail.addEventListener('click', (e) => {
      const allBtn = e.target.closest('[data-act="all"]');
      if (allBtn) { if (typeof window.showContinueWatching === 'function') window.showContinueWatching(); return; }
      const card = e.target.closest('.wpro-card');
      if (!card) return;
      const ref = {
        id: Number(card.dataset.id), type: card.dataset.type,
        season: Number(card.dataset.season || 0), episode: Number(card.dataset.episode || 0)
      };
      const actBtn = e.target.closest('[data-act]');
      const act = actBtn ? actBtn.dataset.act : 'play';
      if (act === 'rm') {
        e.stopPropagation();
        removeItem(ref);
        return;
      }
      resume(ref);
    });
    rail.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-act="play"]')) {
        e.preventDefault();
        e.target.click();
      }
    });
  }

  function resume(ref) {
    if (typeof window.resumeContinueItem === 'function') {
      window.resumeContinueItem(Number(ref.id), ref.type, Number(ref.season || 0), Number(ref.episode || 0));
    }
  }
  function removeItem(ref) {
    const next = getList().filter((x) => !sameKey(x, ref));
    setList(next);
    lastRail = 0;
    renderRail();
    toast('Removed from Continue Watching');
    // if the full list is on screen, refresh it too
    const gt = $('#grid-title');
    if (gt && /continue watching/i.test(gt.textContent) && typeof window.showContinueWatching === 'function') {
      window.showContinueWatching();
    }
  }
  function clearContinue() {
    const list = getList();
    if (!list.length) { toast('Continue Watching is already empty'); return; }
    const ok = window.confirm('Remove all ' + list.length + ' title(s) from Continue Watching? This cannot be undone.');
    if (!ok) return;
    setList([]);
    lastRail = 0;
    renderRail();
    toast('Continue Watching cleared');
    if (typeof window.showContinueWatching === 'function') window.showContinueWatching();
  }

  /* ---------------- decorate full Continue Watching grid ---------------- */
  function decorateContinueGrid() {
    const grid = $('#movie-grid');
    if (!grid) return;
    const old = $('#wpro-manage');
    if (old) old.remove();
    const list = getList();
    const bar = document.createElement('div');
    bar.id = 'wpro-manage';
    bar.className = 'wpro-manage';
    bar.innerHTML = '<span><i class="fas fa-forward"></i> ' + list.length + ' partially watched title' + (list.length === 1 ? '' : 's') +
      ' · saved on this device</span>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="danger" id="wpro-clear"><i class="fas fa-trash"></i> Clear all</button>';
    grid.before(bar);
    $('#wpro-clear').addEventListener('click', clearContinue);

    const cards = Array.from(grid.querySelectorAll('.movie-card'));
    cards.forEach((card, i) => {
      const item = list[i];
      if (!item || card.classList.contains('wpro-decorated')) return;
      card.classList.add('wpro-decorated');
      const x = document.createElement('button');
      x.className = 'wpro-remove-x';
      x.type = 'button';
      x.setAttribute('aria-label', 'Remove from Continue Watching');
      x.innerHTML = '<i class="fas fa-xmark"></i>';
      x.addEventListener('click', (e) => { e.stopPropagation(); removeItem(item); });
      card.appendChild(x);
      const info = card.querySelector('.movie-info');
      if (info) {
        const row = document.createElement('div');
        row.className = 'wpro-cardbtns';
        row.innerHTML = '<button type="button" data-w="go"><i class="fas fa-play"></i> Continue watching</button>' +
          '<button type="button" class="rm" data-w="rm" aria-label="Remove"><i class="fas fa-trash"></i></button>';
        row.querySelector('[data-w="go"]').addEventListener('click', (e) => { e.stopPropagation(); resume(item); });
        row.querySelector('[data-w="rm"]').addEventListener('click', (e) => { e.stopPropagation(); removeItem(item); });
        info.appendChild(row);
      }
    });
  }

  /* ---------------- decorate history grid with progress ---------------- */
  function playbackFor(item) {
    try {
      if (typeof window.getPlaybackState !== 'function') return null;
      const direct = window.getPlaybackState(item);
      if (direct && Number(direct.currentTime) > 0) return direct;
      // fallback: scan saved playback keys for the same title id
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || k.indexOf('decan_playback:') !== 0) continue;
        const parts = k.split(':');
        if (Number(parts[1]) === Number(item.id)) {
          try {
            const st = JSON.parse(localStorage.getItem(k));
            if (st && Number(st.currentTime) > 0) return st;
          } catch (_) {}
        }
      }
    } catch (_) {}
    return null;
  }
  function decorateHistoryGrid() {
    const grid = $('#movie-grid');
    if (!grid) return;
    let history = [];
    try { history = JSON.parse(localStorage.getItem('decan_history') || '[]'); } catch (_) {}
    const norm = (v) => String(v || '').trim().toLowerCase();
    const byTitle = {};
    history.forEach((h) => { const t = norm(h.title || h.name); if (t && !byTitle[t]) byTitle[t] = h; });
    const cards = Array.from(grid.querySelectorAll('.movie-card'));
    cards.forEach((card, i) => {
      // Match by card title (robust across cloud pulls), fall back to position.
      const cardTitle = norm(card.querySelector('.movie-info h3') ? card.querySelector('.movie-info h3').textContent : '');
      const item = (cardTitle && byTitle[cardTitle]) || history[i];
      if (!item || card.querySelector('.wpro-progress-line')) return;
      const st = playbackFor(item);
      if (!st) return;
      const pct = st.duration ? Math.max(0, Math.min(100, Math.round((st.currentTime / st.duration) * 100))) : 0;
      const info = card.querySelector('.movie-info');
      if (!info) return;
      const line = document.createElement('div');
      line.className = 'wpro-progress-line';
      line.innerHTML = '<div class="wpro-bar"><i style="width:' + pct + '%"></i></div><span>' + pct + '% · ' + fmtPos(st.currentTime) + '</span>';
      info.appendChild(line);
    });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    wireRail();
    renderRail();
    // wrap library views (additive decoration only)
    try {
      if (typeof window.showContinueWatching === 'function' && !window.showContinueWatching.__wpro__) {
        const orig = window.showContinueWatching;
        const wrapped = function () { const r = orig.apply(this, arguments); try { decorateContinueGrid(); } catch (_) {} return r; };
        wrapped.__wpro__ = true;
        window.showContinueWatching = wrapped;
      }
      if (typeof window.showHistory === 'function' && !window.showHistory.__wpro__) {
        const orig = window.showHistory;
        const wrapped = function () { const r = orig.apply(this, arguments); try { decorateHistoryGrid(); } catch (_) {} return r; };
        wrapped.__wpro__ = true;
        window.showHistory = wrapped;
      }
    } catch (_) {}

    document.addEventListener('decan:continue-updated', () => renderRail());
    document.addEventListener('decan:cloud-library-updated', () => { lastRail = 0; renderRail(); });
    window.addEventListener('storage', (e) => {
      if (e.key === 'decan_continue_watching') { lastRail = 0; renderRail(); }
    });
    window.addEventListener('focus', () => renderRail());
    // re-evaluate once the first category finishes loading
    setTimeout(renderRail, 2500);
    setTimeout(renderRail, 6000);

    window.WatchPro = { renderRail, clearContinue, removeItem, resume, decorateContinueGrid, decorateHistoryGrid };
    window.clearContinueWatching = clearContinue;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
