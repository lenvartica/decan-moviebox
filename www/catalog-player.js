(function () {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const state = { item: null, hls: null, dash: null, trackUrls: [], lastSavedAt: 0 };
  let root;
  let video;
  let status;
  let audioSelect;
  let subtitleSelect;
  let speedSelect;
  let downloadProgress;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(title, detail, visible = true) {
    status.replaceChildren();
    if (title) status.append(make('strong', '', title));
    if (detail) status.append(document.createTextNode(detail));
    status.hidden = !visible;
  }

  function licenseLinks(item) {
    const attribution = make('p', 'dm-player-attribution', item.attribution || '');
    const evidence = make('a', '', ' License and rights evidence');
    evidence.href = item.evidenceUrl;
    evidence.target = '_blank';
    evidence.rel = 'noopener noreferrer';
    attribution.append(evidence);
    const source = make('a', '', ' · Official source');
    source.href = item.sourcePage;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    attribution.append(source);
    if (item.territoryNote) attribution.append(make('span', '', ` ${item.territoryNote}`));
    return attribution;
  }

  function saveProgress() {
    if (!state.item || !Number.isFinite(video.currentTime)) return;
    const now = Date.now();
    if (now - state.lastSavedAt < 8000 && !video.ended) return;
    state.lastSavedAt = now;
    try {
      localStorage.setItem(`decan-player-progress:${state.item.id}`, JSON.stringify({
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        updatedAt: now
      }));
    } catch (error) {
      console.warn('Could not save playback position on this device.', error);
    }
  }

  function clearEngine() {
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    if (state.dash) {
      state.dash.reset();
      state.dash = null;
    }
    state.trackUrls.forEach(url => URL.revokeObjectURL(url));
    state.trackUrls = [];
    video.pause();
    video.removeAttribute('src');
    video.replaceChildren();
    video.load();
  }

  function videoErrorText() {
    const code = video.error?.code;
    if (code === MediaError.MEDIA_ERR_NETWORK) return 'The video could not be fetched. Check your connection or try the official source.';
    if (code === MediaError.MEDIA_ERR_DECODE) return 'This device cannot decode this video. Try another quality or the official source player.';
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return 'This video format is not supported by this browser or device.';
    return 'Playback stopped. Check the connection or open the official source.';
  }

  async function loadScript(src, ready) {
    if (ready()) return;
    await new Promise((resolve, reject) => {
      const script = make('script');
      script.src = src;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('A required open-source video playback library could not load.'));
      document.head.append(script);
    });
    if (!ready()) throw new Error('The video playback library loaded but could not initialize.');
  }

  function attachDash(url) {
    return loadScript('https://cdn.dashjs.org/v5.2.1/dash.all.min.js', () => !!window.dashjs)
      .then(() => {
        state.dash = window.dashjs.MediaPlayer().create();
        state.dash.initialize(video, url, false);
        state.dash.on(window.dashjs.MediaPlayer.events.ERROR, event => {
          if (event.error) setStatus('DASH playback error', event.error.message || 'This stream could not be played.');
        });
      });
  }

  function attachHls(url) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.load();
      return Promise.resolve();
    }
    return loadScript('https://cdn.jsdelivr.net/npm/hls.js@1.6.15/dist/hls.min.js', () => !!window.Hls)
      .then(() => {
        if (!window.Hls.isSupported()) throw new Error('HLS streaming is not supported on this device.');
        state.hls = new window.Hls({ enableWorker: true, lowLatencyMode: false });
        state.hls.loadSource(url);
        state.hls.attachMedia(video);
        state.hls.on(window.Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;
          setStatus('HLS playback error', 'The authorized stream could not continue. Try again or open its official source.');
          state.hls.destroy();
          state.hls = null;
        });
      });
  }

  function isDash(stream) {
    return stream.mimeType === 'application/dash+xml' || /\.mpd(?:$|[?#])/i.test(stream.url);
  }

  function isHls(stream) {
    return stream.mimeType === 'application/vnd.apple.mpegurl' || /\.m3u8(?:$|[?#])/i.test(stream.url);
  }

  async function addSubtitles(item) {
    subtitleSelect.replaceChildren(new Option('Off', ''));
    subtitleSelect.hidden = !item.subtitles.length;
    for (const subtitle of item.subtitles) {
      try {
        let trackUrl = subtitle.url;
        if (subtitle.format === 'srt') {
          const response = await fetch(subtitle.url, { mode: 'cors', credentials: 'omit' });
          if (!response.ok) throw new Error(`Subtitle request failed: HTTP ${response.status}`);
          let text = await response.text();
          if (text.length > 1_000_000) throw new Error('Subtitle file exceeds 1 MB.');
          text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
          text = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
          trackUrl = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }));
          state.trackUrls.push(trackUrl);
        }
        const track = make('track');
        track.kind = 'subtitles';
        track.label = subtitle.label;
        track.srclang = subtitle.language;
        track.src = trackUrl;
        video.append(track);
        subtitleSelect.append(new Option(subtitle.label, String(video.textTracks.length - 1)));
      } catch (error) {
        console.warn(`Could not load ${subtitle.label} subtitles.`, error);
      }
    }
    subtitleSelect.hidden = subtitleSelect.options.length < 2;
    subtitleSelect.onchange = () => {
      Array.from(video.textTracks).forEach((track, index) => {
        track.mode = index === Number(subtitleSelect.value) ? 'showing' : 'disabled';
      });
    };
  }

  function loadAudioTracks() {
    audioSelect.replaceChildren(new Option('Audio track', ''));
    const tracks = video.audioTracks;
    if (!tracks || tracks.length < 2) {
      audioSelect.hidden = true;
      return;
    }
    Array.from(tracks).forEach((track, index) => {
      audioSelect.append(new Option(track.label || track.language || `Track ${index + 1}`, String(index)));
    });
    audioSelect.hidden = false;
    audioSelect.value = String(Array.from(tracks).findIndex(track => track.enabled));
    audioSelect.onchange = () => {
      Array.from(tracks).forEach((track, index) => { track.enabled = index === Number(audioSelect.value); });
    };
  }

  function openLayer() {
    root.hidden = false;
    document.body.style.overflow = 'hidden';
    $('#dm-player-close').focus();
  }

  function closeLayer() {
    saveProgress();
    clearEngine();
    root.hidden = true;
    document.body.style.overflow = '';
    downloadProgress.hidden = true;
    setStatus('', '', false);
  }

  function showSourceOnly(item, message) {
    openLayer();
    $('#dm-player-title').textContent = item.title;
    clearEngine();
    setStatus('In-app playback is unavailable', message);
    $('#dm-player-credit').replaceChildren();
    const text = make('span', '', 'This entry is listed for discovery only. ');
    const link = make('a', '', 'Open the official source page.');
    link.href = item.sourcePage;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    text.append(link);
    $('#dm-player-credit').append(text);
  }

  async function openItem(item, options = {}) {
    if (!item || !item.reviewed || !item.streams.length || !item.licenseUrl || !item.evidenceUrl) {
      if (item) showSourceOnly(item, 'Rights or a supported stream have not been verified for this title.');
      return;
    }
    state.item = item;
    state.lastSavedAt = 0;
    openLayer();
    $('#dm-player-title').textContent = item.title;
    $('#dm-player-credit').replaceChildren(licenseLinks(item));
    clearEngine();
    setStatus('', '', false);
    await addSubtitles(item);

    const stream = item.streams[0];
    try {
      if (isDash(stream)) await attachDash(stream.url);
      else if (isHls(stream)) await attachHls(stream.url);
      else {
        video.src = stream.url;
        video.load();
      }

      let resume = null;
      try { resume = JSON.parse(localStorage.getItem(`decan-player-progress:${item.id}`) || 'null'); } catch (_) {}
      video.addEventListener('loadedmetadata', () => {
        if (resume && Number(resume.currentTime) > 10 && Number(resume.currentTime) < video.duration - 30 && !options.offline) {
          const resumeAt = Number(resume.currentTime);
          const resumePrompt = window.confirm(`Resume ${item.title} from ${formatTime(resumeAt)}?`);
          video.currentTime = resumePrompt ? resumeAt : 0;
        }
        loadAudioTracks();
      }, { once: true });
      video.play().catch(() => setStatus('Ready to play', 'Tap the play button to start this movie.'));
    } catch (error) {
      setStatus('Unable to start playback', error.message || 'Try the official source page instead.');
      console.error('Movie playback initialization failed.', error);
    }
  }

  function formatTime(seconds) {
    const total = Math.floor(Number(seconds) || 0);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function findTitleMatch(title, id, type) {
    const normalizedTitle = String(title || '').normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    return window.DecanMovieCatalog.getItems().then(items => {
      const exactId = items.find(item => Number(id) > 0 && item.tmdbId === Number(id) && item.mediaType === type);
      if (exactId) return exactId;
      return items.find(item => {
        const itemTitle = item.title.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
        return item.mediaType === type && itemTitle === normalizedTitle;
      }) || null;
    });
  }

  async function playTitle(details) {
    try {
      const item = await findTitleMatch(details.title, details.id, details.type === 'tv' ? 'tv' : 'movie');
      if (item) return openItem(item);
      openLayer();
      $('#dm-player-title').textContent = details.title || 'Movie';
      clearEngine();
      setStatus('No approved in-app stream for this title', 'Browse the approved catalog or visit the title’s official provider. This site does not search unverified streaming servers.');
      $('#dm-player-credit').replaceChildren();
      const link = make('a', 'catalog-button secondary', 'Browse approved titles');
      link.href = 'catalog.html';
      $('#dm-player-credit').append(link);
    } catch (error) {
      openLayer();
      setStatus('Movie catalog unavailable', error.message || 'Please try again later.');
    }
  }

  async function downloadTitle(details) {
    try {
      const item = await findTitleMatch(details.title, details.id, details.type === 'tv' ? 'tv' : 'movie');
      if (item) return download(item);
      openLayer();
      $('#dm-player-title').textContent = details.title || 'Movie';
      clearEngine();
      setStatus('No approved offline copy for this title', 'Browse the approved catalog for titles with reviewed download permission.');
      $('#dm-player-credit').replaceChildren();
      const link = make('a', 'catalog-button secondary', 'Browse approved titles');
      link.href = 'catalog.html';
      $('#dm-player-credit').append(link);
    } catch (error) {
      openLayer();
      setStatus('Movie catalog unavailable', error.message || 'Please try again later.');
    }
  }

  async function download(item) {
    if (!item || !item.reviewed || !item.download) {
      if (item) showSourceOnly(item, 'This title has no reviewed offline-download permission.');
      return;
    }
    const bytes = item.download.estimatedBytes;
    const size = bytes ? window.DecanMovieCatalog.formatSize(bytes) : 'an unknown amount of storage';
    if (!window.confirm(`Save “${item.title}” inside this Android app for offline viewing? The download is approximately ${size}. Mobile data charges may apply.`)) return;
    if (!window.DecanNativeMedia || !window.DecanNativeMedia.isNative) {
      window.open(item.download.url, '_blank', 'noopener,noreferrer');
      return;
    }

    openLayer();
    $('#dm-player-title').textContent = `Downloading ${item.title}`;
    clearEngine();
    setStatus('Downloading for offline viewing', 'Keep this app open until the download finishes.');
    downloadProgress.hidden = false;
    try {
      const saved = await window.DecanNativeMedia.download({
        id: item.id,
        title: item.title,
        url: item.download.url,
        fileExtension: item.download.fileExtension,
        sourcePage: item.sourcePage,
        attribution: item.attribution
      }, percent => {
        downloadProgress.firstElementChild.style.width = `${percent}%`;
      });
      setStatus('Download complete', `${item.title} is saved in My Downloads on this device.`);
      const play = make('button', 'catalog-button primary', 'Play offline');
      play.type = 'button';
      play.addEventListener('click', () => playOffline(saved, item));
      $('#dm-player-credit').replaceChildren(play, licenseLinks(item));
    } catch (error) {
      setStatus('Download failed', error.message || 'Check the connection and available device storage.');
      console.error('Offline movie download failed.', error);
    }
  }

  async function playOffline(saved, item) {
    try {
      const localUrl = await window.DecanNativeMedia.playOffline(saved);
      const offlineItem = {
        ...item,
        streams: [{ url: localUrl, mimeType: 'video/mp4', label: 'Saved offline' }],
        subtitles: []
      };
      await openItem(offlineItem, { offline: true });
    } catch (error) {
      showSourceOnly(item, error.message || 'The offline copy could not be opened.');
    }
  }

  function mount() {
    root = make('section', 'dm-player');
    root.id = 'dm-player';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Movie player');
    root.innerHTML = `
      <div class="dm-player-shell">
        <header class="dm-player-header">
          <h2 class="dm-player-title" id="dm-player-title">Movie</h2>
          <button class="dm-player-close" id="dm-player-close" type="button" aria-label="Close player">×</button>
        </header>
        <div class="dm-player-video-wrap" id="dm-player-video-wrap">
          <video class="dm-player-video" id="dm-player-video" controls playsinline preload="metadata"></video>
          <div class="dm-player-status" id="dm-player-status" role="status" hidden></div>
        </div>
        <div class="dm-player-controls">
          <label>Speed <select id="dm-player-speed" aria-label="Playback speed">
            <option value="0.5">0.5×</option><option value="0.75">0.75×</option><option value="1" selected>Normal</option>
            <option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="1.75">1.75×</option><option value="2">2×</option>
          </select></label>
          <label id="dm-player-subtitles-label" hidden>Subtitles <select id="dm-player-subtitles" aria-label="Subtitles"></select></label>
          <label id="dm-player-audio-label" hidden>Audio <select id="dm-player-audio" aria-label="Audio track"></select></label>
          <button type="button" id="dm-player-pip" hidden>Picture in picture</button>
          <button type="button" id="dm-player-fullscreen">Fullscreen</button>
        </div>
        <div class="dm-player-download-progress" id="dm-player-download-progress" hidden><span></span></div>
        <div class="dm-player-attribution" id="dm-player-credit"></div>
      </div>`;
    document.body.append(root);
    video = $('#dm-player-video', root);
    status = $('#dm-player-status', root);
    audioSelect = $('#dm-player-audio', root);
    subtitleSelect = $('#dm-player-subtitles', root);
    speedSelect = $('#dm-player-speed', root);
    downloadProgress = $('#dm-player-download-progress', root);

    $('#dm-player-close', root).addEventListener('click', closeLayer);
    $('#dm-player-fullscreen', root).addEventListener('click', async () => {
      try {
        const target = $('#dm-player-video-wrap');
        if (!document.fullscreenElement) await target.requestFullscreen();
        else await document.exitFullscreen();
      } catch (error) {
        setStatus('Fullscreen unavailable', error.message || 'Use your device’s video controls to change display mode.');
      }
    });
    $('#dm-player-pip', root).addEventListener('click', async () => {
      try { await video.requestPictureInPicture(); } catch (error) {
        setStatus('Picture in picture unavailable', error.message || 'This device does not support picture in picture.');
      }
    });
    speedSelect.addEventListener('change', () => { video.playbackRate = Number(speedSelect.value); });
    video.addEventListener('timeupdate', saveProgress);
    video.addEventListener('ended', () => {
      if (state.item) localStorage.removeItem(`decan-player-progress:${state.item.id}`);
    });
    video.addEventListener('loadeddata', () => setStatus('', '', false));
    video.addEventListener('error', () => {
      if (video.error) setStatus('Playback error', videoErrorText());
    });
    document.addEventListener('keydown', event => {
      if (root.hidden || event.target.matches('input,select,textarea,button')) return;
      if (event.key === 'Escape') closeLayer();
      if (event.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 10);
      if (event.key === 'ArrowRight' && Number.isFinite(video.duration)) video.currentTime = Math.min(video.duration, video.currentTime + 10);
      if (event.key === ' ') {
        event.preventDefault();
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      }
    });
    $('#dm-player-subtitles-label').append(subtitleSelect);
    $('#dm-player-audio-label').append(audioSelect);
    $('#dm-player-pip').hidden = !('pictureInPictureEnabled' in document);
  }

  mount();
  window.DecanCatalogPlayer = { open: openItem, playTitle, downloadTitle, download, playOffline, close: closeLayer };
  window.launchTheaterPlayer = (id, type, encodedTitle) => {
    let title = String(encodedTitle || 'Movie');
    try { title = decodeURIComponent(title); } catch (_) {}
    return playTitle({ id: Number(id), type, title: title.replace(/\s+\((?:1080p HD|720p)\)$/i, '') });
  };
  window.closeTheater = closeLayer;
})();
