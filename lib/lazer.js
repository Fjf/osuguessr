// Read-only indexer for osu!lazer.
//
// lazer stores its library in `client.realm` (a Realm database) plus a
// content-addressed `files/` store laid out as files/<h[0]>/<h[0..2]>/<hash>,
// where the stored file has NO extension. Each beatmap difficulty references
// its audio by original file name (Beatmap.Metadata.AudioFile); the set's
// Files list maps that name to a stored hash (deduplicated across sets);
// the hash maps to the on-disk path.
//
// The realm is opened READ-ONLY and with NO schema, so schema bumps in
// lazer (renamed tables, new fields, embedded<->link changes) do not break
// the open — we read only the properties we need and tolerate both the old
// and the current shape where they differ. The file is copied to a temp
// directory first: the mount may be read-only, lazer may hold a write
// lock, and the copy gives us a stable snapshot. We never write to the
// user's install.
//
// Output matches the shape the stable scanner produces (songs[] with
// beatmaps[] attached), so both sources share the same SQLite writer.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// realm is a heavy native module — load it lazily and only when actually
// indexing a lazer library, so stable installs never pay the load cost.
let realmPromise = null;
function loadRealm() {
  realmPromise ??= import('realm').then((m) => m.default || m);
  return realmPromise;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// --- pure helpers (exported for unit tests) --------------------------------

/**
 * On-disk path of a stored file, relative to the files/ root.
 * lazer lays files out as <first char>/<first two chars>/<full hash>.
 */
export function pathFromHash(hash) {
  const h = String(hash || '').toLowerCase();
  if (h.length < 3) return null;
  return `${h[0]}/${h.slice(0, 2)}/${h}`;
}

const MODE_BY_SHORTNAME = {
  osu: 'standard',
  taiko: 'taiko',
  ctb: 'catch',
  mania: 'mania',
};

/** Map a lazer ruleset short name (osu/taiko/ctb/mania) to our mode labels. */
export function modeFromShortName(shortName) {
  return MODE_BY_SHORTNAME[String(shortName || '').toLowerCase()] || null;
}

/**
 * Detect an audio format from magic bytes — stored lazer files have no
 * extension, so the content is the only source of truth. Returns
 * { ext, mime } or null when the content is not a recognised audio format.
 */
export function detectAudio(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.length < 12) return null;
  const s4 = (o, n) => b.toString('latin1', o, o + n);
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return { ext: 'mp3', mime: 'audio/mpeg' };
  if (s4(0, 3) === 'ID3') return { ext: 'mp3', mime: 'audio/mpeg' };
  if (s4(0, 4) === 'OggS') {
    // The codec identifier header in a later Ogg page tells opus apart from
    // vorbis; scan the head of the file for it.
    const head = b.toString('latin1', 0, Math.min(b.length, 8192));
    return head.includes('OpusHead')
      ? { ext: 'opus', mime: 'audio/opus' }
      : { ext: 'ogg', mime: 'audio/ogg' };
  }
  if (s4(0, 4) === 'fLaC') return { ext: 'flac', mime: 'audio/flac' };
  if (s4(0, 4) === 'RIFF' && s4(8, 4) === 'WAVE') return { ext: 'wav', mime: 'audio/wav' };
  if (s4(4, 4) === 'ftyp') return { ext: 'm4a', mime: 'audio/mp4' };
  return null;
}

/** Read just the head of a file and detect its audio format. */
function sniffFile(abs, byteLength = 8192) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(byteLength);
    const n = fs.readSync(fd, buf, 0, byteLength, 0);
    return detectAudio(buf.subarray(0, n));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

function baseNameLower(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return value.split(/[\\/]/).pop().toLowerCase();
}

/**
 * Resolve a beatmap's AudioFile reference against a set's Files list.
 * Matches case-insensitively on the basename (lazer stores the original
 * file name; the reference may carry a directory prefix). Tolerates both
 * the current shape ({ File: { Hash }, Filename }) and the pre-2023 shape
 * ({ Hash, Filename }).
 * @param {{Files?: Array<{Filename?: string, File?: {Hash?: string}, Hash?: string}>}} set
 * @param {string} audioFile  BeatmapMetadata.AudioFile
 * @returns {{hash: string, rel: string} | null}
 */
export function resolveAudio(set, audioFile) {
  const target = baseNameLower(audioFile);
  if (!target) return null;
  for (const usage of set?.Files || []) {
    if (baseNameLower(usage?.Filename) !== target) continue;
    const hash = usage?.File?.Hash ?? usage?.Hash;
    if (typeof hash !== 'string' || !hash) continue;
    const rel = pathFromHash(hash);
    if (!rel) continue;
    return { hash: hash.toLowerCase(), rel };
  }
  return null;
}

/**
 * Map a realm Author field to a plain string. Older realms store a string;
 * current realms store a user object with Username.
 */
export function authorName(author) {
  if (!author) return '';
  if (typeof author === 'string') return author;
  return author.Username || author.username || '';
}

function onlineId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Pick the beatmap whose metadata represents the song for display: prefer
 * the set that contributed the most difficulties, and within that a
 * beatmap that actually has a title. Mirrors pickFromList() in index.js.
 */
function pickPrimary(list) {
  const setId = (b) => b.set_id ?? b.beatmap_id ?? b.difficulty;
  const counts = new Map();
  for (const b of list) counts.set(setId(b), (counts.get(setId(b)) || 0) + 1);
  let best = null;
  let bestN = -1;
  for (const b of list) {
    const n = counts.get(setId(b)) || 0;
    if (n > bestN) {
      bestN = n;
      best = b;
    }
  }
  for (const b of list) {
    if ((counts.get(setId(b)) || 0) === bestN && (b.titleUnicode || b.title)) return b;
  }
  return best;
}

// --- scanning ----------------------------------------------------------------

/**
 * Scan a lazer install and build the song list.
 *
 * @param {{osuDir: string, songsDir: string,
 *          onProgress?: (p: object) => void}} opts
 *   osuDir    folder containing client.realm (the lazer data folder)
 *   songsDir  the files/ store — stored paths are relative to this
 *   onProgress same {phase, done, total} protocol as the stable scanner
 * @returns {Promise<{songs: object[], summary: object}>}
 */
export async function scanLazer(opts) {
  const { osuDir, songsDir } = opts;
  const onProgress = opts.onProgress || (() => {});
  const realmPath = path.join(osuDir, 'client.realm');
  if (!fs.existsSync(realmPath)) {
    throw new Error(
      `client.realm not found in ${osuDir} — point OSU_DIR at the lazer data ` +
        `folder (the one containing client.realm and files/; lazer can move it ` +
        `via Settings > Storage)`,
    );
  }

  // Copy the realm into a scratch dir: never touch the user's install
  // (no lock files, no writes, stable snapshot), and give realm a place
  // to create its management files.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'osuguessr-realm-'));
  let realm = null;
  try {
    const size = fs.statSync(realmPath).size;
    onProgress({
      phase: 'realm',
      done: 0,
      total: 0,
      detail: `copying client.realm (${(size / 1048576).toFixed(0)} MB)`,
    });
    fs.copyFileSync(realmPath, path.join(tmp, 'client.realm'));

    const Realm = await loadRealm();
    realm = await Realm.open(path.join(tmp, 'client.realm'), {
      readOnly: true,
      fifoFilesFallbackPath: tmp, // some mounts can't host realm's FIFO files
    });

    let sets;
    try {
      sets = realm.objects('BeatmapSet');
    } catch (err) {
      throw new Error(
        `could not read the BeatmapSet table — the realm was probably written by a ` +
          `newer osu!lazer than this reader supports (${err.message})`,
      );
    }

    const total = sets.length;
    const byHash = new Map(); // audio hash -> { hash, rel, abs, size, beatmaps: [] }
    const skipped = {
      deletePending: 0,
      empty: 0,
      noAudio: 0,
      noMatch: 0,
      missingOnDisk: 0,
      unknownMode: 0,
      unrecognizedAudio: 0,
    };
    let beatmaps = 0;

    for (let i = 0; i < total; i++) {
      if (i % 200 === 0) await tick(); // keep the event loop (and HTTP) alive
      const set = sets[i].toJSON();
      if (set.DeletePending) {
        skipped.deletePending++;
        continue;
      }
      const diffs = Array.isArray(set.Beatmaps) ? set.Beatmaps : [];
      if (diffs.length === 0) {
        skipped.empty++;
        continue;
      }
      const setId = onlineId(set.OnlineID);
      for (const raw of diffs) {
        const meta = raw.Metadata || {};
        const audioFile = typeof meta.AudioFile === 'string' ? meta.AudioFile : '';
        if (!audioFile.trim()) {
          skipped.noAudio++;
          continue;
        }
        const hit = resolveAudio(set, audioFile);
        if (!hit) {
          skipped.noMatch++;
          continue;
        }
        const mode = modeFromShortName(raw.Ruleset?.ShortName);
        if (!mode) {
          skipped.unknownMode++;
          continue;
        }
        const abs = path.join(songsDir, hit.rel);
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch {
          skipped.missingOnDisk++;
          continue;
        }
        beatmaps++;
        const preview = Number(meta.PreviewTime);
        let entry = byHash.get(hit.hash);
        if (!entry) {
          entry = { hash: hit.hash, rel: hit.rel, abs, size: stat.size, beatmaps: [] };
          byHash.set(hit.hash, entry);
        }
        entry.beatmaps.push({
          mode,
          difficulty: raw.DifficultyName || 'Unknown',
          creator: authorName(meta.Author),
          title: typeof meta.Title === 'string' ? meta.Title : '',
          titleUnicode: typeof meta.TitleUnicode === 'string' ? meta.TitleUnicode : '',
          artist: typeof meta.Artist === 'string' ? meta.Artist : '',
          artistUnicode: typeof meta.ArtistUnicode === 'string' ? meta.ArtistUnicode : '',
          source: typeof meta.Source === 'string' ? meta.Source : '',
          tags: typeof meta.Tags === 'string' ? meta.Tags : '',
          previewTime: Number.isFinite(preview) ? preview : -1,
          beatmap_id: onlineId(raw.OnlineID),
          set_id: setId,
          osuRel: '',
        });
      }
      if (i % 100 === 0 || i === total - 1) {
        onProgress({ phase: 'beatmaps', done: i + 1, total });
      }
    }

    // One song per unique audio file — difficulties and sets that share
    // audio are unioned onto a single entry.
    const songs = [];
    for (const entry of byHash.values()) {
      const found = sniffFile(entry.abs);
      if (!found) {
        skipped.unrecognizedAudio++;
        console.log(`[index] skipping ${entry.rel} — unrecognised audio format`);
        continue;
      }
      const primary = pickPrimary(entry.beatmaps);
      const previewTimes = entry.beatmaps
        .map((b) => b.previewTime)
        .filter((t) => Number.isInteger(t) && t >= 0);
      songs.push({
        name: `${entry.hash}.${found.ext}`,
        ext: found.ext,
        mime: found.mime,
        size: entry.size,
        rel: entry.rel,
        dir: path.dirname(entry.rel),
        md5name: entry.hash,
        abs: entry.abs,
        matched: true,
        origin: 'beatmap',
        beatmaps: entry.beatmaps,
        title: primary.title || `Unknown (${entry.hash.slice(0, 10)}…)`,
        titleUnicode: primary.titleUnicode || '',
        artist: primary.artist || 'Unknown',
        artistUnicode: primary.artistUnicode || '',
        source: primary.source || '',
        tags: primary.tags || '',
        creator: [...new Set(entry.beatmaps.map((b) => b.creator).filter(Boolean))]
          .slice(0, 4)
          .join(', '),
        previewTime: previewTimes.length ? Math.min(...previewTimes) : -1,
      });
    }

    onProgress({ phase: 'beatmaps', done: total, total });
    return {
      songs,
      summary: {
        songCount: songs.length,
        beatmapCount: beatmaps,
        tagless: 0,
        hitSoundsSkipped: 0,
        beatmapsParsed: beatmaps,
        beatmapsUnparseable: 0,
        setsScanned: total,
        skipped,
      },
    };
  } finally {
    if (realm) {
      try {
        realm.close();
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}