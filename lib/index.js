// Indexer: scans the osu! Songs folder for audio files and the beatmap
// folder for .osu files, joins them on the audio MD5, and writes the result
// into SQLite. Runs once per (re)build; the DB file is persisted afterwards.

import fs from 'node:fs';
import path from 'node:path';
import { parseOsuFile, modeFromOsuPath } from './osu.js';
import { setMeta } from './db.js';
import { parseFile } from 'music-metadata';

const AUDIO_EXTS = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.opus': 'audio/opus',
  '.wma': 'audio/x-ms-wma',
};

const TAGGED_EXTS = new Set(['mp3', 'ogg', 'm4a', 'flac', 'aiff', 'aif']);

// osu! hit sounds that ship inside beatmap set folders (and the tutorial
// folder, where they may be .mp3 instead of .wav). They are game SFX, not
// songs — indexing them would bloat the library and make the game "play"
// 44-byte files as tracks. Matched on the extension-less basename.
const HIT_SOUND_BASENAMES = new Set([
  'countin',
  'sectionfail',
  'sectionpass',
  'slidebar',
  'normal-slidertick',
  'soft-slidertick',
  'drum-slidertick',
  'soft-hitnormal',
  'soft-hitclap',
  'soft-hitwhistle',
  'soft-sliderslide',
  'normal-hitnormal',
  'normal-hitclap',
  'normal-hitwhistle',
  'normal-sliderslide',
  'drum-hitnormal',
  'drum-hitnormal2',
  'drum-hitclap',
  'drum-hitwhistle',
  'drum-hitfinish',
]);

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Strip the audio extension(s) from a base filename. */
function stripAudioExt(base) {
  const lower = base.toLowerCase();
  if (lower.endsWith('.ogg.flac')) return base.slice(0, -'.ogg.flac'.length);
  const ext = path.extname(base).toLowerCase();
  if (AUDIO_EXTS[ext]) return base.slice(0, -ext.length);
  return base;
}

/**
 * Normalize an AudioFilename reference ("audio.mp3", "Songs/abc.mp3",
 * "deadbeef.ogg.flac") to a lowercase extension-less basename for matching.
 */
function audioRefNoExt(value) {
  if (!value) return null;
  const base = value.split(/[\\/]/).pop();
  const noExt = stripAudioExt(base);
  return noExt === base ? null : noExt.toLowerCase();
}

export function audioExtAndMime(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.ogg.flac')) return { ext: 'flac', mime: AUDIO_EXTS['.flac'] };
  const ext = path.extname(lower);
  if (AUDIO_EXTS[ext]) return { ext: ext.slice(1), mime: AUDIO_EXTS[ext] };
  return null;
}

/**
 * Recursive walk with depth protection. Symlinks are NEVER followed: a
 * symlinked audio file could point outside the songs folder and be exposed
 * through the /audio endpoint. Yields absolute file paths.
 */
export function* walkFiles(dir, maxDepth = 25) {
  const seen = new Set();
  const stack = [[dir, 0]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop();
    if (depth > maxDepth) continue;
    let real;
    try {
      real = fs.realpathSync(current);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(current, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push([full, depth + 1]);
      else if (e.isFile()) yield full;
    }
  }
}

/** Scan the Songs folder for audio files. Reports progress as it walks. */
async function scanSongs(songsDir, onProgress) {
  const songs = [];
  let seen = 0;
  let skippedHitSounds = 0;
  let lastReport = 0;
  for (const abs of walkFiles(songsDir)) {
    seen++;
    if (seen - lastReport >= 500) {
      lastReport = seen;
      onProgress({ phase: 'songs', done: seen });
    }
    if (seen % 200 === 0) await tick(); // keep the event loop (and HTTP) alive
    const base = path.basename(abs);
    const lower = base.toLowerCase();
    const found = audioExtAndMime(lower);
    if (!found) continue;
    if (HIT_SOUND_BASENAMES.has(stripAudioExt(lower))) {
      skippedHitSounds++;
      continue;
    }
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch {
      continue;
    }
    const rel = path.relative(songsDir, abs);
    const noExt = stripAudioExt(base);
    const md5name = /^[0-9a-f]{32}$/i.test(noExt) ? noExt.toLowerCase() : null;
    songs.push({
      name: base,
      ext: found.ext,
      mime: found.mime,
      size,
      rel,
      dir: path.dirname(rel),
      md5name,
      abs,
    });
  }
  onProgress({ phase: 'songs', done: seen, total: seen, songs: songs.length });
  return { songs, seen, skippedHitSounds };
}

/**
 * Scan for .osu beatmap files and group them by the audio they reference.
 *
 * Three match keys are built:
 *  - byMd5:          standard layout, AudioFilename is the audio's MD5
 *  - bySameDir:      per-set libraries where the audio file sits next to the
 *                    .osu file(s) in the same folder (some installs store
 *                    each set — audio included — inside the Songs folder);
 *                    keyed by folder + referenced audio basename
 *  - byOriginalName: AudioFilenameOriginal fallback (non-MD5 libraries)
 *
 * Only .osu/.osu.* files are ever parsed, so audio files can never be
 * misread as beatmaps even when the songs folder lies inside the beatmap
 * folder. Reports progress as it walks.
 */
async function scanBeatmaps(beatmapsDir, songsDir, onProgress) {
  const byMd5 = new Map(); // md5 -> [meta, ...]
  const bySameDir = new Map(); // dirRel + '\u0000' + audioRef -> [meta, ...]
  const byOriginalName = new Map(); // lower original basename (no ext) -> [meta, ...]
  let unparseable = 0;
  let parsed = 0;
  let seen = 0;
  let lastReport = 0;

  // The songs tree and the beatmap tree can be the same underlying directory
  // reached through different paths (e.g. two bind mounts of the same osu!
  // install, one of them pointing at the Songs subfolder). Neither plain path
  // comparison nor realpath sees through bind mounts — but device + inode do.
  const songsRootStat = fs.statSync(songsDir);
  const dirRelCache = new Map(); // dir -> rel | null
  const isSongsRoot = new Map(); // dir -> true (confirmed by dev+ino)

  /**
   * `dir`'s path relative to the songs root, or null when `dir` is not part
   * of the songs tree. Walks up parent directories until it finds one that
   * IS the songs root (same dev + ino). Memoized per directory.
   */
  function dirRelToSongs(dir) {
    let rel = dirRelCache.get(dir);
    if (rel !== undefined) return rel;
    rel = null;
    let cur = dir;
    for (let depth = 0; depth < 50; depth++) {
      if (isSongsRoot.get(cur)) {
        rel = path.relative(cur, dir);
        break;
      }
      let st;
      try {
        st = fs.statSync(cur);
      } catch {
        break; // unreadable directory
      }
      if (st.dev === songsRootStat.dev && st.ino === songsRootStat.ino) {
        isSongsRoot.set(cur, true);
        rel = path.relative(cur, dir);
        break;
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    dirRelCache.set(dir, rel);
    return rel;
  }

  for (const abs of walkFiles(beatmapsDir)) {
    seen++;
    if (seen - lastReport >= 500) {
      lastReport = seen;
      onProgress({ phase: 'beatmaps', done: seen, osu: parsed });
    }
    if (seen % 200 === 0) await tick(); // keep the event loop (and HTTP) alive
    const mode = modeFromOsuPath(abs);
    if (!mode) continue;
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      unparseable++;
      continue;
    }
    parsed++;
    const meta = { ...parseOsuFile(text), mode, osuRel: path.relative(beatmapsDir, abs) };
    if (meta.audio) push(byMd5, meta.audio, meta);
    const audioRef = audioRefNoExt(meta.audioRaw);
    if (audioRef != null) {
      // If the .osu file lives inside the songs tree (per-set libraries),
      // the audio in its own folder is by far the most likely candidate.
      const dirRel = dirRelToSongs(path.dirname(abs));
      if (dirRel != null) push(bySameDir, dirRel + '\u0000' + audioRef, meta);
    }
    if (meta.audioOriginal) {
      // Key by the extension-less name so it can be matched against song
      // files stored under their original name (non-MD5 libraries).
      const key = stripAudioExt(path.basename(meta.audioOriginal).toLowerCase());
      push(byOriginalName, key, meta);
    }
  }
  onProgress({ phase: 'beatmaps', done: seen, total: seen, osu: parsed });
  return { byMd5, bySameDir, byOriginalName, parsed, unparseable };
}

function push(map, key, item) {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/** Read embedded tags for songs that have no beatmap metadata. */
async function readTags(songs, onProgress) {
  const candidates = songs.filter((s) => !s.matched && TAGGED_EXTS.has(s.ext));
  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    try {
      const meta = await parseFile(s.abs, { duration: false, skipCovers: true });
      const c = meta.common || {};
      const title = c.title || '';
      const artist = c.artist || (c.artists || []).join(', ') || '';
      if (title || artist) {
        s.title = title;
        s.artist = artist;
        s.origin = 'tags';
      }
    } catch {
      // unparseable tag — keep the file-based fallback
    }
    if (i % 25 === 0) {
      onProgress({ phase: 'tags', done: i, total: candidates.length });
    }
  }
  onProgress({ phase: 'tags', done: candidates.length, total: candidates.length });
}

function pickFromList(list) {
  // Prefer the set that contributed the most difficulties.
  const setId = (b) => b.beatmapSetId ?? b.beatmapMd5 ?? b.osuRel;
  const counts = new Map();
  for (const b of list) counts.set(setId(b), (counts.get(setId(b)) || 0) + 1);
  let best = list[0];
  let bestN = -1;
  for (const b of list) {
    const n = counts.get(setId(b)) || 0;
    if (n > bestN) {
      bestN = n;
      best = b;
    }
  }
  return best;
}

/**
 * Stable scanner: walks the Songs folder for audio and the beatmap folder
 * for .osu files, joins them on the audio MD5, and attaches the result to
 * each song. Returns { songs, summary }.
 */
async function scanStable(opts, onProgress) {
  const { songsDir, beatmapsDir, useTags = true } = opts;
  const hasBeatmaps = fs.existsSync(beatmapsDir);

  const { songs, skippedHitSounds } = await scanSongs(songsDir, onProgress);
  const {
    byMd5,
    bySameDir,
    byOriginalName,
    parsed: beatmapsParsed = 0,
    unparseable: beatmapsUnparseable = 0,
  } = hasBeatmaps
    ? await scanBeatmaps(beatmapsDir, songsDir, onProgress)
    : { byMd5: new Map(), bySameDir: new Map(), byOriginalName: new Map() };

  for (const s of songs) {
    const noExt = path.basename(stripAudioExt(s.name)).toLowerCase();
    // '' for the songs root, mirroring how beatmap dirs are keyed.
    const dirKey = s.dir === '.' ? '' : s.dir;
    let list = s.md5name ? byMd5.get(s.md5name) : undefined;
    if (!list) list = bySameDir.get(dirKey + '\u0000' + noExt);
    if (!list) list = byOriginalName.get(noExt);
    if (list && list.length > 0) {
      s.matched = true;
      s.origin = 'beatmap';
      s.beatmaps = list;
      const main = pickFromList(list);
      s.title = main.title || `Unknown (${s.name.slice(0, 10)}…)`;
      s.titleUnicode = main.titleUnicode || '';
      s.artist = main.artist || 'Unknown';
      s.artistUnicode = main.artistUnicode || '';
      s.source = main.source || '';
      s.tags = main.tags || '';
      s.previewTime = Number.isFinite(main.previewTime) ? main.previewTime : -1;
      const creators = [...new Set(list.map((b) => b.creator).filter(Boolean))];
      s.creator = creators.slice(0, 4).join(', ');
    } else {
      s.matched = false;
      s.beatmaps = [];
      s.origin = 'file';
      s.title = `Unknown (${s.name.slice(0, 10)}…)`;
      s.titleUnicode = '';
      s.artist = 'Unknown';
      s.artistUnicode = '';
      s.previewTime = -1;
    }
  }

  if (useTags) await readTags(songs, onProgress);

  return {
    songs,
    summary: {
      songCount: songs.length,
      beatmapCount: songs.reduce((n, s) => n + s.beatmaps.length, 0),
      tagless: songs.filter((s) => s.origin === 'file').length,
      hitSoundsSkipped: skippedHitSounds,
      beatmapsParsed,
      beatmapsUnparseable,
    },
  };
}

/** Write the song list into SQLite, wiping previous rows atomically. */
function writeIndex(db, songs, summary, onProgress) {
  const insertSong = db.prepare(
    `INSERT INTO songs
       (name, ext, path, size, mime, title, title_unicode, artist, artist_unicode,
        preview_time, creator, source, tags, origin, beatmap_count)
     VALUES (@name, @ext, @path, @size, @mime, @title, @title_unicode, @artist,
        @artist_unicode, @preview_time, @creator, @source, @tags, @origin, @beatmap_count)`,
  );
  const insertBeatmap = db.prepare(
    `INSERT INTO beatmaps
       (song_id, osu_path, mode, difficulty, creator, set_title, set_artist, set_source, set_tags, beatmap_id, set_id)
     VALUES (@song_id, @osu_path, @mode, @difficulty, @creator, @set_title, @set_artist, @set_source, @set_tags, @beatmap_id, @set_id)`,
  );

  onProgress({ phase: 'write', done: 0, total: songs.length });
  const writeAll = db.transaction(() => {
    db.prepare('DELETE FROM beatmaps').run();
    db.prepare('DELETE FROM songs').run();
    for (const s of songs) {
      const info = insertSong.run({
        name: s.name,
        ext: s.ext,
        path: s.rel,
        size: s.size,
        mime: s.mime,
        title: s.title,
        title_unicode: s.titleUnicode || '',
        artist: s.artist,
        artist_unicode: s.artistUnicode || '',
        preview_time: Number.isInteger(s.previewTime) ? s.previewTime : -1,
        creator: s.creator || '',
        source: s.source || '',
        tags: s.tags || '',
        origin: s.origin,
        beatmap_count: s.beatmaps.length,
      });
      s.dbId = info.lastInsertRowid;
      for (const b of s.beatmaps) {
        insertBeatmap.run({
          song_id: s.dbId,
          osu_path: b.osuRel,
          mode: b.mode,
          difficulty: b.version || b.difficulty || 'Unknown',
          creator: b.creator || '',
          set_title: b.title || '',
          set_artist: b.artist || '',
          set_source: b.source || '',
          set_tags: b.tags || '',
          beatmap_id: b.beatmapId ?? b.beatmap_id ?? null,
          set_id: b.beatmapSetId ?? b.set_id ?? null,
        });
      }
    }
    setMeta(db, 'lastIndexed', new Date().toISOString());
  });
  writeAll();

  onProgress({ phase: 'done', done: summary.songCount, total: summary.songCount });
  return summary;
}

/**
 * Build (or rebuild) the full index. Wipes previous rows atomically.
 *
 * The library comes from one of two sources (see OSU_SOURCE):
 *  - "stable" — scan SONGS_DIR for audio and BEATMAPS_DIR for .osu files
 *  - "lazer"  — read client.realm + the files/ store (see lib/lazer.js)
 * Both produce the same shape and share writeIndex().
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{songsDir: string, beatmapsDir?: string, useTags?: boolean,
 *          source?: 'stable'|'lazer', osuDir?: string,
 *          onProgress?: (p: object) => void}} opts
 */
export async function rebuildIndex(db, opts) {
  const { songsDir, source = 'stable', onProgress = () => {} } = opts;
  onProgress({ phase: 'start', done: 0, total: 0 });

  if (!fs.existsSync(songsDir)) {
    throw new Error(`Audio directory not found: ${songsDir}`);
  }

  let songs;
  let summary;
  if (source === 'lazer') {
    const { scanLazer } = await import('./lazer.js');
    const r = await scanLazer({ osuDir: opts.osuDir, songsDir, onProgress });
    songs = r.songs;
    summary = r.summary;
  } else {
    const r = await scanStable(opts, onProgress);
    songs = r.songs;
    summary = r.summary;
  }

  return writeIndex(db, songs, summary, onProgress);
}