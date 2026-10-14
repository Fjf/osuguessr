// Unit tests for the SQLite layer: topTags aggregation and the randomSong
// tag filter (whole-token, case-insensitive, LIKE-escape-safe).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, topTags, randomSong } from '../lib/db.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osuguessr-dbtest-'));
  const db = openDb(path.join(dir, 'test.db'));
  return { db, dir };
}

function addSong(db, title, tags = '') {
  db.prepare(
    `INSERT INTO songs
       (name, ext, path, size, mime, title, artist, creator, source, tags, origin, beatmap_count)
     VALUES (?, 'mp3', ?, 0, 'audio/mpeg', ?, 'Unknown', '', '', ?, 'beatmap', 1)`,
  ).run(`${title}.mp3`, `${title}.mp3`, title, tags);
  return db.prepare('SELECT id, tags FROM songs WHERE title = ?').get(title);
}

test('topTags aggregates, dedupes, normalises case and sorts', () => {
  const { db, dir } = tempDb();
  try {
    addSong(db, 'a', 'Rock Pop  jazz  JAZZ rock');
    addSong(db, 'b', 'pop blues');
    addSong(db, 'c', ''); // no tags
    addSong(db, 'd', '   '); // only whitespace
    assert.deepEqual(topTags(db, 25), [
      { tag: 'jazz', count: 2 },
      { tag: 'pop', count: 2 },
      { tag: 'rock', count: 2 },
      { tag: 'blues', count: 1 },
    ]);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('topTags honours the limit', () => {
  const { db, dir } = tempDb();
  try {
    for (let i = 0; i < 30; i++) addSong(db, `s${i}`, `tag${String(i).padStart(2, '0')}`);
    const all = topTags(db, 25);
    assert.equal(all.length, 25);
    assert.ok(all.every((t) => t.count === 1));
    assert.equal(all[0].tag, 'tag00'); // alphabetical tie-break
    assert.equal(all[24].tag, 'tag24');
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('randomSong tag filter is whole-token and case-insensitive', () => {
  const { db, dir } = tempDb();
  try {
    addSong(db, 'neon1', 'neon');
    addSong(db, 'neon2', 'synthwave neon');
    addSong(db, 'ne-song', 'ne');
    addSong(db, 'plain', '');
    // "ne" must never match "neon"
    for (let i = 0; i < 20; i++) {
      const s = randomSong(db, [], 'ne');
      assert.equal(s.tags, 'ne');
    }
    // "neon" (any case) matches only the two neon songs
    const seen = new Set();
    let s;
    while ((s = randomSong(db, [...seen], 'NEON'))) seen.add(s.id);
    assert.equal(seen.size, 2);
    for (const id of seen) {
      assert.match(db.prepare('SELECT tags FROM songs WHERE id = ?').get(id).tags, /neon/);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('randomSong tag filter escapes LIKE wildcards', () => {
  const { db, dir } = tempDb();
  try {
    addSong(db, 'pct', '100%');
    addSong(db, 'other', '100x');
    // Unescaped, "%,100%,%" would also match "100x" — it must not.
    const seen = new Set();
    let s;
    while ((s = randomSong(db, [...seen], '100%'))) seen.add(s.id);
    const titles = [...seen]
      .map((id) => db.prepare('SELECT title FROM songs WHERE id = ?').get(id).title);
    assert.deepEqual(titles, ['pct']);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('randomSong without a tag still honours exclude', () => {
  const { db, dir } = tempDb();
  try {
    const a = addSong(db, 'a');
    const b = addSong(db, 'b');
    const sa = randomSong(db, [], null);
    const sb = randomSong(db, [sa.id], null);
    assert.notEqual(sb.id, sa.id);
    const both = new Set([a.id, b.id]);
    assert.equal(randomSong(db, [...both], null), null);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});