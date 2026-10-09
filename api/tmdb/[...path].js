// Decan Movie — catch-all TMDB route.
// This makes /api/tmdb/discover/movie and similar paths work directly on Vercel.
// The shared handler keeps the TMDB access token server-side.
import handler from '../tmdb.js';

export default handler;
