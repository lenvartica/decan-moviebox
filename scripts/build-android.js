const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '..');
const webDir = path.join(root, 'www');
const files = [
  'index.html',
  'catalog.html',
  'characters.html',
  'movie-hub.html',
  'platforms.html',
  'trending.html',
  'decan-atom-logo.svg',
  'decan-icon-192.png',
  'decan-icon-512.png',
  'decan-v3.css',
  'catalog.css',
  'catalog-player.css',
  'catalog.js',
  'catalog-player.js',
  'music-pro.css',
  'music-pro.js',
  'watch-pro.css',
  'watch-pro.js',
  'manifest.json',
  'service-worker.js',
  'supabase-config.js',
  'catalogs/approved.json',
  'trending/index.html'
];

fs.rmSync(webDir, { recursive: true, force: true });
fs.mkdirSync(webDir, { recursive: true });

for (const file of files) {
  const source = path.join(root, file);
  if (!fs.existsSync(source)) {
    throw new Error(`Android web asset is missing: ${file}`);
  }
  const destination = path.join(webDir, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

const configuredApi = process.env.DECAN_TMDB_API_BASE ||
  'https://decan-konnect-movie-three.vercel.app/api/tmdb';
const apiUrl = new URL(configuredApi);
if (apiUrl.protocol !== 'https:' || !apiUrl.pathname.replace(/\/+$/, '').endsWith('/api/tmdb')) {
  throw new Error('DECAN_TMDB_API_BASE must be an HTTPS URL ending in /api/tmdb.');
}

fs.writeFileSync(
  path.join(webDir, 'native-config.js'),
  `window.DECAN_TMDB_API_BASE=${JSON.stringify(apiUrl.toString().replace(/\/+$/, ''))};\n`
);

const indexPath = path.join(webDir, 'index.html');
let index = fs.readFileSync(indexPath, 'utf8');
if (!index.includes('<head>') || !index.includes('<script src="catalog.js">')) {
  throw new Error('Android index is missing the expected native-config or catalog script insertion points.');
}
index = index.replace('<head>', '<head>\n    <script src="native-config.js"></script>');
index = index.replace(
  '<script src="catalog.js">',
  '<script src="native-media-bridge.js"></script>\n    <script src="catalog.js">'
);
fs.writeFileSync(indexPath, index);

const catalogPath = path.join(webDir, 'catalog.html');
let catalog = fs.readFileSync(catalogPath, 'utf8');
if (!catalog.includes('<script src="catalog.js" defer>')) {
  throw new Error('Android catalog is missing the expected native bridge insertion point.');
}
catalog = catalog.replace(
  '<script src="catalog.js" defer>',
  '<script src="native-media-bridge.js" defer></script>\n  <script src="catalog.js" defer>'
);
fs.writeFileSync(catalogPath, catalog);

build({
  entryPoints: [path.join(root, 'native', 'media-bridge.js')],
  outfile: path.join(webDir, 'native-media-bridge.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
