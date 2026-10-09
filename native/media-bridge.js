import { Capacitor } from '@capacitor/core';
import { FileTransfer } from '@capacitor/file-transfer';
import { Directory, Filesystem } from '@capacitor/filesystem';

const downloadsKey = 'decan-approved-offline-movies';

function readDownloads() {
  try {
    const value = JSON.parse(localStorage.getItem(downloadsKey) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (error) {
    console.error('Could not read offline movie list.', error);
    return [];
  }
}

async function download(item, onProgress) {
  if (!Capacitor.isNativePlatform()) {
    throw new Error('Offline movie downloads are available in the Android app.');
  }

  const fileName = `${item.id}.${item.fileExtension}`;
  await Filesystem.mkdir({ directory: Directory.Data, path: 'movies', recursive: true });
  const file = await Filesystem.getUri({ directory: Directory.Data, path: `movies/${fileName}` });
  const listener = await FileTransfer.addListener('progress', event => {
    if (event.contentLength > 0) {
      onProgress(Math.min(100, Math.round(event.bytes / event.contentLength * 100)));
    }
  });

  try {
    await FileTransfer.downloadFile({
      url: item.url,
      path: file.uri,
      progress: true
    });
  } finally {
    await listener.remove();
  }

  const saved = {
    id: item.id,
    title: item.title,
    path: `movies/${fileName}`,
    fileUri: file.uri,
    sourcePage: item.sourcePage,
    attribution: item.attribution,
    savedAt: Date.now()
  };
  const downloads = readDownloads().filter(downloaded => downloaded.id !== item.id);
  downloads.unshift(saved);
  localStorage.setItem(downloadsKey, JSON.stringify(downloads));
  return saved;
}

async function playOffline(item) {
  if (!Capacitor.isNativePlatform()) throw new Error('Offline playback requires the Android app.');
  const file = await Filesystem.getUri({ directory: Directory.Data, path: item.path });
  return Capacitor.convertFileSrc(file.uri);
}

async function deleteDownload(item) {
  if (!Capacitor.isNativePlatform()) throw new Error('Offline downloads require the Android app.');
  await Filesystem.deleteFile({ directory: Directory.Data, path: item.path });
  localStorage.setItem(downloadsKey, JSON.stringify(readDownloads().filter(downloaded => downloaded.id !== item.id)));
}

window.DecanNativeMedia = {
  isNative: Capacitor.isNativePlatform(),
  readDownloads,
  download,
  playOffline,
  deleteDownload
};
