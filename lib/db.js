// SQLite layer. The index is built once (at first start or on demand) and
// persisted in a single file so restarts are instant and random access is O(1).

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS songs (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,          -- file name, e.g. d41d....mp3
  ext           TEXT NOT NULL,          -- mp3 | ogg | flac | wav | m4a | ...
  path          TEXT NOT NULL UNIQUE,   -- path relative to SONGS_DIR
  size          INTEGER NOT NULL DEFAULT 0,
  mime          TEXT NOT NULL,
  title         TEXT NOT NULL,          -- romanised form
  title_unicode TEXT NOT NULL DEFAULT '',
  artist        TEXT NOT NULL,          -- romanised form
  artist_unicode TEXT NOT NULL DEFAULT '',
  preview_time  INTEGER NOT NULL DEFAULT -1, -- ms into the track, -1 = unknown
  creator       TEXT NOT NULL DEFAULT '',  -- mapper(s), comma-joined
  source        TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '',
  origin        TEXT NOT NULL DEFAULT 'file', -- file | tags | beatmap
  beatmap_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS beatmaps (
  id           INTEGER PRIMARY KEY,
  song_id      INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  osu_path     TEXT NOT NULL,            -- path relative to BEATMAPS_DIR
  mode         TEXT NOT NULL,            -- standard | taiko | catch | mania
  difficulty   TEXT NOT NULL,            -- "Version" field of the .osu file
  creator      TEXT NOT NULL DEFAULT '',
  set_title    TEXT NOT NULL DEFAULT '',
  set_artist   TEXT NOT NULL DEFAULT '',
  set_source   TEXT NOT NULL DEFAULT '',
  set_tags     TEXT NOT NULL DEFAULT '',
  beatmap_id   INTEGER,
  set_id       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_beatmaps_song ON beatmaps(song_id);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS leaves older indexes without the newer
  // columns — add them once (no-op on a fresh or current database).
  const cols = new Set(db.prepare('PRAGMA table_info(songs)').all().map((r) => r.name));
  if (!cols.has('title_unicode'))
    db.exec("ALTER TABLE songs ADD COLUMN title_unicode TEXT NOT NULL DEFAULT ''");
  if (!cols.has('artist_unicode'))
    db.exec("ALTER TABLE songs ADD COLUMN artist_unicode TEXT NOT NULL DEFAULT ''");
  if (!cols.has('preview_time'))
    db.exec('ALTER TABLE songs ADD COLUMN preview_time INTEGER NOT NULL DEFAULT -1');
  return db;
}

const qStats = () => `
  SELECT
    (SELECT COUNT(*) FROM songs)    AS songCount,
    (SELECT COUNT(*) FROM beatmaps) AS beatmapCount
`;

export function getStats(db) {
  const row = db.prepare(qStats()).get();
  const lastIndexed = db
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get('lastIndexed')?.value ?? null;
  return { ...row, lastIndexed };
}

export function countSongs(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM songs').get().n;
}

/**
 * Pick a random song, optionally excluding a list of recently-seen ids and/or
 * restricting to songs carrying `tag`. Tags are the space-separated osu!
 * tag list; matching is on the whole token, case-insensitive, so tag "ne"
 * never matches "neon".
 * @param {import('better-sqlite3').Database} db
 * @param {number[]} exclude
 * @param {string|null} [tag]
 */
export function randomSong(db, exclude = [], tag = null) {
  let sql = 'SELECT * FROM songs';
  const where = [];
  const params = [];
  const ids = [...new Set(exclude.map(Number).filter(Number.isInteger))].slice(0, 50);
  if (ids.length > 0) {
    where.push(`id NOT IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  if (tag) {
    where.push(`(' ' || lower(tags) || ' ') LIKE ? ESCAPE '\\'`);
    params.push(` %${escapeLike(String(tag).toLowerCase().trim().replace(/\s+/g, ' '))} %`);
  }
  if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY RANDOM() LIMIT 1';
  return db.prepare(sql).get(...params) ?? null;
}

/**
 * Aggregate the space-separated osu! tags across the whole library and
 * return the most popular tags, most frequent first (ties: alphabetical).
 * @param {import('better-sqlite3').Database} db
 * @param {number} limit
 * @returns {{tag: string, count: number}[]}
 */
export function topTags(db, limit = 25) {
  const counts = new Map();
  for (const { tags } of db.prepare("SELECT tags FROM songs WHERE tags != ''").all()) {
    for (const raw of tags.split(/\s+/)) {
      const t = raw.trim().toLowerCase();
      if (!t) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, limit);
}

function escapeLike(term) {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Search the whole library by title / artist / mapper for autocomplete.
 * @param {import('better-sqlite3').Database} db
 * @param {string} term
 * @param {number} limit
 */
export function suggest(db, term, limit = 12) {
  const t = escapeLike(term.trim());
  if (!t) return [];
  const like = `%${t}%`;
  const prefix = `${t}%`;
  return db
    .prepare(
      `SELECT id, title, title_unicode, artist, artist_unicode, creator FROM songs
        WHERE title LIKE ? ESCAPE '\\'
           OR title_unicode LIKE ? ESCAPE '\\'
           OR artist LIKE ? ESCAPE '\\'
           OR artist_unicode LIKE ? ESCAPE '\\'
           OR creator LIKE ? ESCAPE '\\'
        ORDER BY (title LIKE ? ESCAPE '\\') DESC, length(title) ASC, id ASC
        LIMIT ?`,
    )
    .all(like, like, like, like, like, prefix, limit);
}

/**
 * Resolve a free-text submission to exact song ids (case-insensitive match on
 * title, artist, or "Title - Artist" / "Artist - Title"). Returns [] when no
 * match. Duplicate titles are common, so the caller must check whether the
 * actual round song is among the matches.
 */
export function findExact(db, text) {
  const t = text.trim();
  if (!t) return [];
  return db
    .prepare(
      `SELECT id FROM songs
        WHERE lower(title) = lower(?)
           OR lower(title_unicode) = lower(?)
           OR lower(artist) = lower(?)
           OR lower(artist_unicode) = lower(?)
           OR lower(title || ' - ' || artist) = lower(?)
           OR lower(artist || ' - ' || title) = lower(?)
        LIMIT 20`,
    )
    .all(t, t, t, t, t, t)
    .map((r) => r.id);
}

export function getSong(db, id) {
  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(id);
  if (!song) return null;
  const beatmaps = db
    .prepare(
      `SELECT mode, difficulty, creator, set_title, set_artist,
              set_source, set_tags, beatmap_id, set_id
       FROM beatmaps WHERE song_id = ?
       ORDER BY CASE mode
                 WHEN 'standard' THEN 0
                 WHEN 'taiko'    THEN 1
                 WHEN 'catch'    THEN 2
                 WHEN 'mania'    THEN 3
                 ELSE 4 END,
              difficulty ASC`,
    )
    .all(id);
  return { ...song, beatmaps };
}

export function getSongPath(db, id) {
  return db.prepare('SELECT path, mime FROM songs WHERE id = ?').get(id) ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}