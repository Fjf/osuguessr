// osuguessr — Express server.
// Serves the game UI, the game API, and the (range-capable) audio stream.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
  openDb,
  getStats,
  randomSong,
  suggest,
  findExact,
  getSong,
  getSongPath,
  countSongs,
  topTags,
} from './lib/db.js';
import { rebuildIndex } from './lib/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const SONGS_DIR = path.resolve(process.env.SONGS_DIR || path.join(__dirname, 'Songs'));
const BEATMAPS_DIR = path.resolve(
  process.env.BEATMAPS_DIR || path.dirname(SONGS_DIR),
);
const DB_PATH = path.resolve(
  process.env.DB_PATH || path.join(__dirname, 'data', 'osuguessr.db'),
);
const USE_TAGS = process.env.USE_AUDIO_TAGS !== '0';

const db = openDb(DB_PATH);

// --- index lifecycle -------------------------------------------------------

const indexState = {
  running: false,
  phase: 'idle',
  done: 0,
  total: 0,
  startedAt: null,
  error: null,
  summary: null,
};

// --- stdout progress ---------------------------------------------------------
// A rebuild can take minutes on a large library, so keep `docker logs`
// informed: at most one line per second, and always on a phase change.

const PHASE_LABELS = {
  start: 'starting',
  songs: 'scanning audio files',
  beatmaps: 'scanning beatmaps',
  tags: 'reading audio tags',
  write: 'writing index',
  done: 'finished',
};

const fmtInt = (n) => Number(n ?? 0).toLocaleString('en-US');

let lastProgressLogAt = 0;
let lastLoggedPhase = null;

function logProgress(p) {
  if (p.phase === 'done') {
    lastLoggedPhase = p.phase;
    return; // the completion summary line below covers this
  }
  const now = Date.now();
  const phaseChanged = p.phase !== lastLoggedPhase;
  if (!phaseChanged && now - lastProgressLogAt < 1000) return;
  lastProgressLogAt = now;
  lastLoggedPhase = p.phase;
  const label = PHASE_LABELS[p.phase] || p.phase;
  if (p.total != null && p.total > 0) {
    const pct = Math.min(100, Math.round((p.done / p.total) * 100));
    console.log(`[index] ${label}: ${fmtInt(p.done)}/${fmtInt(p.total)} (${pct}%)`);
  } else {
    console.log(`[index] ${label}: ${fmtInt(p.done)} files so far`);
  }
}

async function startRebuild() {
  if (indexState.running) return;
  indexState.running = true;
  indexState.phase = 'start';
  indexState.done = 0;
  indexState.total = 0;
  indexState.startedAt = Date.now();
  indexState.error = null;
  lastLoggedPhase = null;
  lastProgressLogAt = 0;
  const startedAt = Date.now();
  console.log(`[index] rebuild started (songs: ${SONGS_DIR}, beatmaps: ${BEATMAPS_DIR})`);
  try {
    const summary = await rebuildIndex(db, {
      songsDir: SONGS_DIR,
      beatmapsDir: BEATMAPS_DIR,
      useTags: USE_TAGS,
      onProgress: (p) => {
        indexState.phase = p.phase;
        indexState.done = p.done ?? 0;
        indexState.total = p.total ?? 0;
        logProgress(p);
      },
    });
    indexState.summary = summary;
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[index] rebuild finished in ${secs}s: ${fmtInt(summary.songCount)} songs, ` +
        `${fmtInt(summary.beatmapCount)} beatmaps, ${fmtInt(summary.tagless)} without metadata`,
    );
  } catch (err) {
    indexState.error = err.message;
    console.error('[index] rebuild failed:', err);
  } finally {
    indexState.running = false;
    indexState.phase = 'idle';
  }
}

/**
 * The persisted index can go stale: the songs folder gets remounted at a
 * different path, files move, a different install gets mounted, etc. The
 * app would still "load" but every /audio/<id> would 404. Detect that at
 * startup by stat-ing the indexed paths (parallel batches so it stays fast
 * even on slow/bridged filesystems; random sample for very large libraries).
 */
async function countMissingIndexedSongs(db, { limit = 5000, sample = 1000 } = {}) {
  const rows = db.prepare('SELECT path FROM songs').all();
  if (rows.length === 0) return 0;
  let paths = rows.map((r) => r.path);
  if (paths.length > limit) {
    for (let i = paths.length - 1; i > sample; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [paths[i], paths[j]] = [paths[j], paths[i]];
    }
    paths = paths.slice(0, sample);
  }
  let missing = 0;
  const BATCH = 64;
  for (let i = 0; i < paths.length; i += BATCH) {
    const results = await Promise.all(
      paths.slice(i, i + BATCH).map((rel) =>
        fs.promises.stat(path.join(SONGS_DIR, rel)).then(() => false, () => true),
      ),
    );
    for (const m of results) if (m) missing++;
  }
  return missing;
}

// Build on first start (empty DB) or when REINDEX=1. Otherwise verify the
// persisted index against disk — restarts stay instant when it is valid.
const forceReindex = process.env.REINDEX === '1';
(async () => {
  const songCount = countSongs(db);
  if (songCount === 0 || forceReindex) {
    if (songCount > 0) console.log('[osuguessr] REINDEX=1 set — rebuilding index');
    startRebuild();
    return;
  }
  console.log(`[osuguessr] verifying persisted index (${songCount} songs) against ${SONGS_DIR}…`);
  const missing = await countMissingIndexedSongs(db);
  if (missing > 0) {
    console.log(
      `[osuguessr] persisted index is stale (${fmtInt(missing)}/${fmtInt(songCount)} indexed ` +
        `songs missing from disk) — rebuilding index`,
    );
    startRebuild();
  } else {
    console.log(
      `[osuguessr] using persisted index (${songCount} songs, ${getStats(db).beatmapCount} beatmaps)`,
    );
  }
})();

// --- app -------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function indexStatus() {
  const stats = getStats(db);
  return {
    ready: !indexState.running && stats.songCount > 0,
    indexing: indexState.running,
    phase: indexState.phase,
    progress: indexState.running
      ? { done: indexState.done, total: indexState.total }
      : null,
    error: indexState.error,
    lastError: indexState.error,
    summary: indexState.summary,
    ...stats,
    songsDir: SONGS_DIR,
    beatmapsDir: BEATMAPS_DIR,
    useTags: USE_TAGS,
  };
}

app.get('/api/status', (_req, res) => {
  res.json(indexStatus());
});

app.post('/api/reindex', (_req, res) => {
  if (indexState.running) {
    res.status(409).json({ error: 'index already in progress' });
    return;
  }
  startRebuild();
  res.status(202).json({ started: true });
});

/** Most popular tags in the library, for the tag-filter dropdown. */
app.get('/api/tags', (_req, res) => {
  if (indexState.running) {
    res.status(503).json({ error: 'index is being built' });
    return;
  }
  res.json({ all: countSongs(db), tags: topTags(db, 25) });
});

/**
 * Start a round: hand the client one random song id (and nothing else!).
 * Optional `tag` restricts the draw to songs carrying that tag.
 */
app.get('/api/round', (req, res) => {
  if (indexState.running) {
    res.status(503).json({ error: 'index is being built, try again shortly' });
    return;
  }
  const exclude = String(req.query.exclude || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter(Number.isInteger)
    .slice(0, 50);
  const tag = String(req.query.tag || '').trim().slice(0, 100);
  const song = randomSong(db, exclude, tag || null);
  if (!song) {
    res.status(404).json({
      error: tag ? `no songs with tag "${tag}"` : 'no songs in the library',
    });
    return;
  }
  res.json({ songId: song.id });
});

/** Autocomplete over the whole library: title, artist, mapper. */
app.get('/api/suggest', (req, res) => {
  const q = String(req.query.q || '');
  if (!q.trim()) {
    res.json([]);
    return;
  }
  if (indexState.running) {
    res.status(503).json({ error: 'index is being built' });
    return;
  }
  res.json(suggest(db, q, 12));
});

/** Full metadata for one song — only call after the round is over. */
app.get('/api/song/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const song = Number.isInteger(id) ? getSong(db, id) : null;
  if (!song) {
    res.status(404).json({ error: 'no such song' });
    return;
  }
  delete song.path; // never leak filesystem layout
  res.json(song);
});

/** Check a guess. Accepts a song id or free text. */
app.post('/api/guess', (req, res) => {
  const { songId, guessId, text } = req.body || {};
  if (!Number.isInteger(songId)) {
    res.status(400).json({ error: 'songId is required' });
    return;
  }
  const song = db.prepare('SELECT id FROM songs WHERE id = ?').get(songId);
  if (!song) {
    res.status(404).json({ error: 'no such song' });
    return;
  }
  let guess = null;
  if (Number.isInteger(guessId)) {
    guess = guessId;
  } else if (typeof text === 'string' && text.trim()) {
    // Duplicate titles are common: a free-text guess is correct iff the
    // actual round song is one of the exact matches.
    const matches = findExact(db, text);
    guess = matches.includes(songId) ? songId : null;
  }
  res.json({ correct: guess === songId, guessId: guess });
});

/** Stream the song, with Range support so the browser can play it natively. */
app.get('/audio/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = Number.isInteger(id) ? getSongPath(db, id) : null;
  if (!row) {
    res.status(404).end();
    return;
  }
  const abs = path.resolve(SONGS_DIR, row.path);
  const root = path.resolve(SONGS_DIR);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    res.status(400).end();
    return;
  }
  // Resolve symlinks and re-check containment: a symlinked audio file must
  // still point inside the songs folder.
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    res.status(404).end();
    return;
  }
  const realRoot = fs.realpathSync(SONGS_DIR);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    res.status(400).end();
    return;
  }
  res.sendFile(real, {
    acceptRanges: true,
    cacheControl: 'no-store', // ids can be reassigned by a reindex
    headers: { 'Content-Type': row.mime },
  });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, HOST, () => {
  console.log(`[osuguessr] listening on http://${HOST}:${PORT}`);
  console.log(`[osuguessr] songs dir:  ${SONGS_DIR}`);
  console.log(`[osuguessr] beatmaps:   ${BEATMAPS_DIR}`);
  console.log(`[osuguessr] db:         ${DB_PATH}`);
});