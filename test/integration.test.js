// End-to-end test: builds a synthetic osu! library, boots the real server
// against it, and exercises the whole game API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;

const FIX = '/tmp/opencode/osu-test';
const TMPDB = fs.mkdtempSync(path.join(os.tmpdir(), 'osuguessr-db-'));

let server;

async function waitFor(fn, timeoutMs = 30000, what = 'condition') {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function status() {
  const res = await fetch(`${BASE}/api/status`);
  return res.json();
}

before(async () => {
  execFileSync('python3', [path.join(__dirname, 'make_fixture.py'), FIX], { stdio: 'inherit' });
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      SONGS_DIR: path.join(FIX, 'Songs'),
      BEATMAPS_DIR: FIX,
      DB_PATH: path.join(TMPDB, 'index.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.DEBUG && process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`[server:err] ${d}`));
  await waitFor(async () => (await status()).indexing === false, 60000, 'initial index build');
}, { timeout: 90000 });

after(() => {
  server?.kill('SIGKILL');
  fs.rmSync(TMPDB, { recursive: true, force: true });
});

async function findSongId(fragment) {
  const res = await fetch(`${BASE}/api/suggest?q=${encodeURIComponent(fragment)}`);
  const items = await res.json();
  assert.ok(items.length >= 1, `expected a suggestion for "${fragment}"`);
  return items[0].id;
}

test('index built with correct counts', async () => {
  const st = await status();
  assert.equal(st.songCount, 9); // 9 audio files; readme.txt, hit sounds, symlink, orphan beatmap ignored
  assert.equal(st.beatmapCount, 9); // 2 + 1 + 1 + 1 + 1 + 1 + 1 + 1 (orphan excluded)
  assert.ok(st.lastIndexed);
});

test('symlink escaping the Songs dir is not indexed or servable', async () => {
  // the fixture contains <md5>.mp3 -> ../osuguessr-secret.txt
  const items = await (await fetch(`${BASE}/api/suggest?q=0123456789abcdef`)).json();
  assert.equal(items.length, 0, 'symlinked file must not be in the index');
});

test('round hands out a random song id only', async () => {
  const res = await fetch(`${BASE}/api/round`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Number.isInteger(body.songId));
  assert.deepEqual(Object.keys(body).sort(), ['songId']); // nothing that reveals the song
});

test('round honours exclude until the library is exhausted', async () => {
  const ids = [];
  for (;;) {
    const res = await fetch(`${BASE}/api/round?exclude=${ids.join(',')}`);
    if (res.status === 404) break;
    assert.equal(res.status, 200, `draw ${ids.length} should succeed`);
    const body = await res.json();
    assert.ok(Number.isInteger(body.songId), `draw ${ids.length} returned ${JSON.stringify(body)}`);
    ids.push(body.songId);
  }
  assert.equal(new Set(ids).size, 9); // every song exactly once
});

test('tags endpoint lists the top tags with counts', async () => {
  const res = await fetch(`${BASE}/api/tags`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.all, 9); // one untagged song, 8 with set tags
  // circles ×2 sets; synthwave/neon/night, catch, mania/fast, mp3, local,
  // and "per set demo" (three tags) once each
  assert.equal(data.tags.length, 12);
  assert.deepEqual(data.tags[0], { tag: 'circles', count: 2 });
  const counts = Object.fromEntries(data.tags.map((t) => [t.tag, t.count]));
  assert.equal(counts.synthwave, 1);
  assert.equal(counts.local, 1);
  assert.equal(counts.per, 1);
  for (let i = 1; i < data.tags.length; i++) {
    assert.ok(data.tags[i - 1].count >= data.tags[i].count, 'counts must be non-increasing');
  }
});

test('round with a tag only deals songs carrying that tag', async () => {
  const ids = [];
  for (;;) {
    const res = await fetch(`${BASE}/api/round?tag=circles&exclude=${ids.join(',')}`);
    if (res.status === 404) break;
    assert.equal(res.status, 200, `draw ${ids.length} should succeed`);
    ids.push((await res.json()).songId);
  }
  assert.equal(new Set(ids).size, 2, 'both Circles songs, each exactly once');
  for (const id of ids) {
    const song = await (await fetch(`${BASE}/api/song/${id}`)).json();
    assert.ok(song.tags.split(/\s+/).map((t) => t.trim()).includes('circles'));
  }
});

test('round tag matching is whole-token; unknown tags are a 404', async () => {
  const res = await fetch(`${BASE}/api/round?tag=ne`); // must not match "neon"
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.match(body.error, /no songs with tag "ne"/);
});

test('suggest searches title, artist and mapper', async () => {
  const byTitle = await (await fetch(`${BASE}/api/suggest?q=neon`)).json();
  assert.equal(byTitle.length, 1);
  assert.equal(byTitle[0].title, 'Neon Skyline');
  assert.equal(byTitle[0].artist, 'DJ Nova');

  const byArtist = await (await fetch(`${BASE}/api/suggest?q=DJ Nova`)).json();
  assert.equal(byArtist.length, 1);
  assert.equal(byArtist[0].title, 'Neon Skyline');

  const byMapper = await (await fetch(`${BASE}/api/suggest?q=Mapper Two`)).json();
  assert.equal(byMapper.length, 1);
  assert.equal(byMapper[0].title, 'Catchy Beat');

  const none = await (await fetch(`${BASE}/api/suggest?q=zzzznotfound`)).json();
  assert.deepEqual(none, []);

  // unknown song (no beatmap, no tags) is still guessable
  const unknown = await (await fetch(`${BASE}/api/suggest?q=Unknown`)).json();
  assert.equal(unknown.length, 1);

  // song stored under its original (non-MD5) name matched via AudioFilenameOriginal
  const named = await (await fetch(`${BASE}/api/suggest?q=Named Track`)).json();
  assert.equal(named.length, 1);
  assert.equal(named[0].artist, 'Local Artist');
});

test('song detail exposes full metadata and all difficulties', async () => {
  const id = await findSongId('Neon Skyline');
  const res = await fetch(`${BASE}/api/song/${id}`);
  assert.equal(res.status, 200);
  const song = await res.json();
  assert.equal(song.title, 'Neon Skyline');
  assert.equal(song.artist, 'DJ Nova');
  assert.equal(song.creator, 'Mapper One');
  assert.equal(song.beatmap_count, 2);
  assert.equal(song.beatmaps.length, 2);
  const diffs = song.beatmaps.map((b) => b.difficulty).sort();
  assert.deepEqual(diffs, ['Insane', 'Normal']);
  assert.ok(song.beatmaps.every((b) => b.mode === 'standard'));
  assert.ok(song.beatmaps.every((b) => b.beatmap_id));
  assert.ok(!('path' in song), 'filesystem path must not be exposed');

  const catchId = await findSongId('Catchy Beat');
  const catchSong = await (await fetch(`${BASE}/api/song/${catchId}`)).json();
  assert.equal(catchSong.beatmaps[0].mode, 'catch');
  assert.equal(catchSong.beatmaps[0].set_source, 'Party');
});

test('audio streams with correct type and range support', async () => {
  const id = await findSongId('Neon Skyline');
  const res = await fetch(`${BASE}/audio/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');

  const ranged = await fetch(`${BASE}/audio/${id}`, {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(ranged.status, 206);
  const buf = Buffer.from(await ranged.arrayBuffer());
  assert.equal(buf.length, 100);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
});

test('guess checking: id and free text', async () => {
  const id = await findSongId('Neon Skyline');
  const other = await findSongId('Catchy Beat');

  const ok = await (
    await fetch(`${BASE}/api/guess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: id, guessId: id }),
    })
  ).json();
  assert.equal(ok.correct, true);

  const wrong = await (
    await fetch(`${BASE}/api/guess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: id, guessId: other }),
    })
  ).json();
  assert.equal(wrong.correct, false);

  const byText = await (
    await fetch(`${BASE}/api/guess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: id, text: 'DJ Nova - Neon Skyline' }),
    })
  ).json();
  assert.equal(byText.correct, true);

  const byTitleOnly = await (
    await fetch(`${BASE}/api/guess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: id, text: 'neon skyline' }),
    })
  ).json();
  assert.equal(byTitleOnly.correct, true);

  const noMatch = await (
    await fetch(`${BASE}/api/guess`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: id, text: 'definitely not in the library' }),
    })
  ).json();
  assert.equal(noMatch.correct, false);
  assert.equal(noMatch.guessId, null);
});

test('free-text guess works with duplicate titles', async () => {
  const res = await fetch(`${BASE}/api/suggest?q=Circles`);
  const items = await res.json();
  assert.ok(items.length >= 2, 'both Circles songs must be suggested');
  const [idA, idB] = items.map((s) => s.id);
  assert.notEqual(idA, idB);

  // ...for BOTH of them, the raw text "Circles" is a correct guess
  for (const songId of [idA, idB]) {
    const out = await (
      await fetch(`${BASE}/api/guess`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songId, text: 'Circles' }),
      })
    ).json();
    assert.equal(out.correct, true, `text "Circles" should be correct for song ${songId}`);
  }
});

test('original-name fallback song has its beatmap attached', async () => {
  const id = await findSongId('Named Track');
  const song = await (await fetch(`${BASE}/api/song/${id}`)).json();
  assert.equal(song.beatmap_count, 1);
  assert.equal(song.beatmaps.length, 1);
  assert.equal(song.beatmaps[0].difficulty, 'Normal');
  assert.equal(song.beatmaps[0].creator, 'Local Mapper');
  assert.equal(song.beatmaps[0].beatmap_id, 555555);
});

test('per-set layout: audio next to .osu matches via the same folder', async () => {
  const items = await (await fetch(`${BASE}/api/suggest?q=Demo Song`)).json();
  assert.equal(items.length, 1);
  const song = await (await fetch(`${BASE}/api/song/${items[0].id}`)).json();
  assert.equal(song.title, 'Demo Song');
  assert.equal(song.artist, 'Per Set');
  assert.equal(song.origin, 'beatmap');
  assert.equal(song.beatmap_count, 1);
  assert.equal(song.beatmaps[0].difficulty, 'Medium');
  assert.equal(song.beatmaps[0].creator, 'Set Mapper');
  assert.equal(song.beatmaps[0].beatmap_id, 700001);

  // the audio (fake mp3 name, wav bytes) must be servable
  const res = await fetch(`${BASE}/audio/${items[0].id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');

  // osu! hit sounds inside set folders are never songs
  const junk = await (await fetch(`${BASE}/api/suggest?q=drum-hitnormal`)).json();
  assert.deepEqual(junk, []);
});

test('guess on unknown song id is a 404', async () => {
  const res = await fetch(`${BASE}/api/guess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songId: 999999, guessId: 999999 }),
  });
  assert.equal(res.status, 404);
});

test('static UI is served', async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('osu!'));
  const js = await fetch(`${BASE}/app.js`);
  assert.equal(js.status, 200);
});

test('reindex rebuilds the same library', async () => {
  const res = await fetch(`${BASE}/api/reindex`, { method: 'POST' });
  assert.equal(res.status, 202);
  await waitFor(async () => (await status()).indexing === false, 60000, 'reindex build');
  const st = await status();
  assert.equal(st.songCount, 9);
  assert.equal(st.beatmapCount, 9);
  assert.equal(st.error, null);
});