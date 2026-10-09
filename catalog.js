(function () {
  'use strict';

  const BUILTIN_MANIFEST = 'catalogs/approved.json';
  const ADDONS_KEY = 'decan-catalog-manifest-urls';
  const LICENSES = new Set([
    'https://creativecommons.org/licenses/by/3.0/',
    'https://creativecommons.org/licenses/by/4.0/',
    'https://creativecommons.org/publicdomain/zero/1.0/',
    'https://creativecommons.org/publicdomain/mark/1.0/'
  ]);
  const state = { manifests: [], items: [], loaded: false, loading: null, showDownloads: false };
  const $ = selector => document.querySelector(selector);

  function safeHttps(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function safeSubtitleUrl(value, sourceUrl) {
    try {
      const baseUrl = new URL(sourceUrl, document.baseURI);
      const url = new URL(value, baseUrl);
      return url.protocol === 'https:' ||
        (url.protocol === location.protocol && url.origin === location.origin) ? url.href : '';
    } catch (_) {
      return '';
    }
  }

  function readAddonUrls() {
    try {
      const saved = JSON.parse(localStorage.getItem(ADDONS_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : [];
    } catch (error) {
      console.warn('Could not read saved catalog add-ons.', error);
      return [];
    }
  }

  function normalizeManifest(manifest, sourceUrl) {
    if (!manifest || manifest.schemaVersion !== 1 || !Array.isArray(manifest.items)) {
      throw new Error('This manifest is not a supported Decan Movie catalog (schemaVersion 1 required).');
    }
    if (manifest.items.length > 500) throw new Error('A catalog manifest may contain no more than 500 titles.');

    const publisher = String(manifest.publisher || manifest.name || 'Catalog publisher').slice(0, 120);
    return manifest.items.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || !String(raw.title || '').trim()) {
        throw new Error(`Catalog title ${index + 1} is missing its title.`);
      }

      const sourcePage = safeHttps(raw.sourcePage);
      if (!sourcePage) throw new Error(`“${raw.title}” must include an HTTPS official source page.`);

      const rights = raw.rights && typeof raw.rights === 'object' ? raw.rights : {};
      const licenseUrl = safeHttps(rights.licenseUrl);
      const reviewed = rights.status === 'reviewed' && LICENSES.has(licenseUrl) &&
        String(rights.attribution || '').trim() && safeHttps(rights.evidenceUrl);

      const streams = Array.isArray(raw.streams) ? raw.streams.slice(0, 6).flatMap(stream => {
        const url = safeHttps(stream && stream.url);
        const mimeType = String(stream && stream.mimeType || '').toLowerCase();
        if (!url || !/^(video\/(mp4|webm|quicktime|x-matroska|ogg)|application\/(vnd\.apple\.mpegurl|dash\+xml))$/.test(mimeType)) return [];
        return [{ url, mimeType, label: String(stream.label || 'Video').slice(0, 60) }];
      }) : [];

      const downloadUrl = safeHttps(raw.download && raw.download.url);
      const downloadAllowed = !!(
        reviewed &&
        raw.download &&
        raw.download.allowed === true &&
        downloadUrl &&
        /^[a-z0-9]{2,6}$/i.test(String(raw.download.fileExtension || ''))
      );
      const subtitles = Array.isArray(raw.subtitles) ? raw.subtitles.slice(0, 16).flatMap(track => {
        const url = safeSubtitleUrl(track && track.url, sourceUrl);
        const format = String(track && track.format || 'vtt').toLowerCase();
        if (!url || !['vtt', 'srt'].includes(format)) return [];
        return [{
          url,
          language: String(track.language || 'en').slice(0, 12),
          label: String(track.label || track.language || 'Subtitles').slice(0, 40),
          format
        }];
      }) : [];

      return {
        id: `${String(manifest.id || 'addon').slice(0, 80)}:${String(raw.id || index).slice(0, 100)}`,
        itemId: String(raw.id || index).slice(0, 100),
        title: String(raw.title).trim().slice(0, 200),
        year: Number.isInteger(Number(raw.year)) ? Number(raw.year) : null,
        mediaType: raw.mediaType === 'tv' ? 'tv' : 'movie',
        description: String(raw.description || '').slice(0, 1500),
        poster: safeHttps(raw.poster),
        sourcePage,
        sourceName: String(manifest.name || publisher).slice(0, 100),
        manifestUrl: sourceUrl,
        tmdbId: Number.isInteger(Number(raw.tmdbId)) ? Number(raw.tmdbId) : null,
        reviewed: !!reviewed,
        license: String(rights.license || '').slice(0, 100),
        licenseUrl,
        evidenceUrl: safeHttps(rights.evidenceUrl),
        attribution: String(rights.attribution || '').slice(0, 500),
        territoryNote: String(rights.territoryNote || '').slice(0, 500),
        streams: reviewed ? streams : [],
        subtitles: reviewed ? subtitles : [],
        download: downloadAllowed ? {
          url: downloadUrl,
          fileExtension: String(raw.download.fileExtension).toLowerCase(),
          estimatedBytes: Number.isFinite(Number(raw.download.estimatedBytes)) ? Number(raw.download.estimatedBytes) : null
        } : null
      };
    });
  }

  async function fetchManifest(url, builtin) {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'application/json' }
    });
    if (!response.ok) throw new Error(`Catalog returned HTTP ${response.status}.`);

    const contentType = response.headers.get('content-type') || '';
    if (!/application\/(?:[\w.+-]*\+)?json\b/i.test(contentType)) {
      throw new Error('The catalog URL did not return JSON.');
    }
    const body = await response.text();
    if (body.length > 1_000_000) throw new Error('A catalog manifest may not exceed 1 MB.');

    let manifest;
    try {
      manifest = JSON.parse(body);
    } catch {
      throw new Error('The catalog response contains invalid JSON.');
    }

    const items = normalizeManifest(manifest, url);
    return { manifest, items, builtin: !!builtin, url };
  }

  async function ensureLoaded() {
    if (state.loaded) return state.items;
    if (state.loading) return state.loading;

    state.loading = (async () => {
      const urls = [BUILTIN_MANIFEST, ...readAddonUrls()];
      const settled = await Promise.allSettled(urls.map((url, index) => fetchManifest(url, index === 0)));
      state.manifests = [];
      state.items = [];
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          state.manifests.push(result.value);
          state.items.push(...result.value.items);
        } else {
          console.warn(`Could not load catalog manifest ${urls[index]}.`, result.reason);
          if (urls[index] === BUILTIN_MANIFEST) throw new Error(`The built-in movie catalog could not load: ${result.reason.message}`);
        }
      });
      state.loaded = true;
      return state.items;
    })().finally(() => { state.loading = null; });

    return state.loading;
  }

  function make(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return 'size varies';
    return bytes >= 1_000_000_000
      ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
      : `${Math.round(bytes / 1_000_000)} MB`;
  }

  function createLink(label, href, className) {
    const link = make('a', className, label);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function createCard(item, downloaded) {
    const card = make('article', 'catalog-card');
    const art = make('div', 'catalog-art');
    if (item.poster) {
      const image = make('img');
      image.src = item.poster;
      image.alt = '';
      image.loading = 'lazy';
      art.append(image);
    } else {
      art.append(make('i', 'fa-solid fa-film'));
    }

    const body = make('div', 'catalog-card-body');
    body.append(make('span', 'catalog-source', item.sourceName));
    const title = make('h3', '', `${item.title}${item.year ? ` (${item.year})` : ''}`);
    body.append(title);
    body.append(make('span', 'catalog-year', item.reviewed ? 'Reviewed open license' : 'Source listing'));
    body.append(make('p', 'catalog-description', item.description || 'Open the original source for film details.'));

    if (item.reviewed) {
      const license = make('p', 'catalog-license');
      license.append(document.createTextNode(`${item.license}. `));
      license.append(createLink('License and attribution', item.licenseUrl, 'catalog-source-link'));
      body.append(license);
      if (item.attribution) body.append(make('p', 'catalog-license', item.attribution));
    } else {
      body.append(make('span', 'catalog-unreviewed', 'Rights not verified · source page only'));
    }

    const actions = make('div', 'catalog-actions');
    if (item.reviewed && item.streams.length) {
      const play = make('button', 'catalog-button primary', 'Play movie');
      play.type = 'button';
      play.addEventListener('click', () => window.DecanCatalogPlayer.open(item));
      actions.append(play);
    }
    if (downloaded) {
      const playOffline = make('button', 'catalog-button secondary', 'Play offline');
      playOffline.type = 'button';
      playOffline.addEventListener('click', () => window.DecanCatalogPlayer.playOffline(downloaded, item));
      actions.append(playOffline);
      const remove = make('button', 'catalog-button secondary', 'Remove download');
      remove.type = 'button';
      remove.addEventListener('click', async () => {
        try {
          await window.DecanNativeMedia.deleteDownload(downloaded);
          render();
        } catch (error) {
          setStatus(error.message || 'Could not remove the offline movie.', true);
        }
      });
      actions.append(remove);
    } else if (item.download) {
      const download = make('button', 'catalog-button secondary', `Download · ${formatSize(item.download.estimatedBytes)}`);
      download.type = 'button';
      if (!window.DecanNativeMedia || !window.DecanNativeMedia.isNative) {
        download.title = 'Offline saving is available in the Android app.';
      }
      download.addEventListener('click', () => window.DecanCatalogPlayer.download(item));
      actions.append(download);
    }
    actions.append(createLink('Official source', item.sourcePage, 'catalog-button secondary'));
    body.append(actions);
    card.append(art, body);
    return card;
  }

  function setStatus(message, error) {
    const status = $('#addon-status');
    if (!status) return;
    status.textContent = message;
    status.style.color = error ? '#ffb2bf' : '';
  }

  function render() {
    const grid = $('#catalog-grid');
    if (!grid) return;
    const search = ($('#catalog-search')?.value || '').trim().toLowerCase();
    const heading = $('#catalog-heading');
    const count = $('#catalog-count');
    const empty = $('#catalog-empty');
    const downloadedItems = window.DecanNativeMedia ? window.DecanNativeMedia.readDownloads() : [];
    const available = state.showDownloads
      ? state.items.filter(item => downloadedItems.some(saved => saved.id === item.id))
      : state.items;
    const items = available.filter(item => !search || `${item.title} ${item.description} ${item.sourceName}`.toLowerCase().includes(search));

    if (heading) heading.textContent = state.showDownloads ? 'My offline movies' : 'Approved titles';
    if (count) count.textContent = `${items.length} ${items.length === 1 ? 'title' : 'titles'}`;
    if (empty) {
      empty.hidden = items.length > 0;
      empty.textContent = state.showDownloads ? 'No movies are saved on this device yet.' : 'No titles match this search.';
    }
    grid.replaceChildren(...items.map(item => createCard(
      item,
      downloadedItems.find(saved => saved.id === item.id) || null
    )));
  }

  async function boot() {
    const grid = $('#catalog-grid');
    if (!grid) return;

    try {
      await ensureLoaded();
      render();
    } catch (error) {
      grid.replaceChildren(make('p', 'catalog-empty', error.message || 'The catalog could not be loaded.'));
      console.error('Movie catalog failed to load.', error);
    }

    $('#catalog-search')?.addEventListener('input', render);
    $('#addon-toggle')?.addEventListener('click', () => {
      const form = $('#addon-form');
      if (form) form.hidden = !form.hidden;
    });
    $('#downloads-toggle')?.addEventListener('click', () => {
      state.showDownloads = !state.showDownloads;
      render();
    });
    $('#addon-form')?.addEventListener('submit', async event => {
      event.preventDefault();
      const input = $('#addon-url');
      const url = safeHttps(input.value.trim());
      if (!url) {
        setStatus('Enter a valid HTTPS JSON manifest URL.', true);
        return;
      }

      const button = $('#addon-form button[type="submit"]');
      button.disabled = true;
      setStatus('Checking JSON format and entries…', false);
      try {
        const candidate = await fetchManifest(url, false);
        if (!candidate.items.length) throw new Error('This manifest contains no movie entries.');
        const approved = window.confirm(
          `Install “${candidate.manifest.name || candidate.manifest.id || 'catalog'}” with ${candidate.items.length} title(s)?\n\nRights fields are publisher claims. Only mark sources reviewed if you checked their license and actual media links.`
        );
        if (!approved) {
          setStatus('Add-on not installed.', false);
          return;
        }
        const urls = readAddonUrls();
        if (!urls.includes(url)) {
          urls.push(url);
          localStorage.setItem(ADDONS_KEY, JSON.stringify(urls));
        }
        state.loaded = false;
        await ensureLoaded();
        input.value = '';
        state.showDownloads = false;
        render();
        setStatus('Catalog add-on installed.', false);
      } catch (error) {
        setStatus(error.message || 'Could not install this manifest. Check its CORS and JSON settings.', true);
      } finally {
        button.disabled = false;
      }
    });
  }

  window.DecanMovieCatalog = {
    ready: ensureLoaded,
    getItems: ensureLoaded,
    normalizeManifest,
    formatSize,
    readDownloads() {
      return window.DecanNativeMedia ? window.DecanNativeMedia.readDownloads() : [];
    }
  };

  boot();
})();
