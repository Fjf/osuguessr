// End-to-end lazer test: builds a synthetic client.realm + files/ store
// (test/make_lazer_fixture.js), runs the real scanLazer against it, then
// boots the real server in OSU_SOURCE=lazer mode and exercises the game
// API — including romanised/unicode answer matching and audio streaming
// from the files/ store.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanLazer } from '../lib/lazer.js';
import { buildLazerFixture } from './make_lazer_fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 18100;
const BASE = `http://127.0.0.1:${PORT}`;
const FIX = '/tmp/opencode/osu-lazer-test';
const TMPDB = fs.mkdtempSync(path.join(os.tmpdir(), 'osuguessr-lazer-db-'));

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

async function guess(songId, text) {
  const res = await fetch(`${BASE}/api/guess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ songId, text }),
  });
  return res.json();
}

before(async () => {
  await buildLazerFixture(FIX);
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      OSU_SOURCE: 'lazer',
      OSU_DIR: FIX,
      DB_PATH: path.join(TMPDB, 'index.db'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => process.env.DEBUG && process.stdout.write(`[server] ${d}`));
  server.stderr.on('data', (d) => process.stdout.write(`[server:err] ${d}`));
  await waitFor(async () => (await status()).indexing === false, 60000, 'initial index build');
  const st = await status();
  if (st.error) throw new Error(`index build failed: ${st.error}`);
}, { timeout: 120000 });

after(() => {
  server?.kill('SIGKILL');
  fs.rmSync(TMPDB, { recursive: true, force: true });
  fs.rmSync(FIX, { recursive: true, force: true });
  // realm keeps native handles alive after close() — exit explicitly so
  // this test-runner child process cannot hang the suite.
  process.exit(process.exitCode ?? 0);
});

test('scanLazer resolves the library from a synthetic client.realm', async () => {
  const { songs, summary } = await scanLazer({
    osuDir: FIX,
    songsDir: path.join(FIX, 'files'),
    onProgress: () => {},
  });
  assert.equal(summary.setsScanned, 9);
  assert.equal(summary.skipped.deletePending, 1); // set 4
  assert.equal(summary.skipped.empty, 1); // set 8
  assert.equal(summary.skipped.noMatch, 1); // set 5
  assert.equal(summary.skipped.missingOnDisk, 1); // set 6
  assert.equal(summary.skipped.unknownMode, 1); // set 7
  assert.equal(summary.skipped.noAudio, 0);
  assert.equal(summary.skipped.unrecognizedAudio, 0);
  assert.equal(summary.songCount, 3);
  assert.equal(summary.beatmapCount, 5);

  const neon = songs.find((s) => s.title === 'Neon Skyline');
  assert.ok(neon, 'shared-audio song present');
  assert.equal(neon.titleUnicode, 'Néo Skÿline');
  assert.equal(neon.artist, 'DJ Nova');
  assert.equal(neon.artistUnicode, 'DJ Noïa');
  // dedup: two sets, three difficulties, one song
  assert.equal(neon.beatmaps.length, 3);
  assert.deepEqual(neon.beatmaps.map((b) => b.mode).sort(), ['standard', 'standard', 'taiko']);
  assert.equal(neon.creator, 'Mapper One, Mapper Two');
  assert.equal(neon.source, 'Synthwave');
  assert.equal(neon.mime, 'audio/wav');
  assert.match(neon.rel, /^a\/aa\/a{40}$/);
  assert.equal(neon.previewTime, 5000);

  const kage = songs.find((s) => s.titleUnicode === 'カゲロウ');
  assert.ok(kage, 'unicode-only-title song present');
  assert.match(kage.title, /^Unknown \(b{10}…\)$/); // romanised form absent
  assert.equal(kage.artist, 'Unknown');
  assert.equal(kage.artistUnicode, 'DECO*27');
  assert.equal(kage.mime, 'audio/ogg');
  assert.equal(kage.previewTime, 8000);

  const named = songs.find((s) => s.title === 'Named Track');
  assert.ok(named, 'directory-prefixed AudioFile resolved');
  assert.equal(named.artist, 'Local Artist');
  assert.equal(named.creator, 'Local Mapper');
  assert.equal(named.previewTime, 1234);
});

test('server status reflects the lazer library', async () => {
  const st = await status();
  assert.equal(st.source, 'lazer');
  assert.equal(st.songCount, 3);
  assert.equal(st.beatmapCount, 5);
  assert.ok(st.lastIndexed);
  assert.ok(st.songsDir.endsWith(path.join('files')), st.songsDir);
});

test('suggest finds songs by romanised AND unicode text', async () => {
  const roman = await (await fetch(`${BASE}/api/suggest?q=Neon Skyline`)).json();
  assert.equal(roman.length, 1);
  assert.equal(roman[0].title_unicode, 'Néo Skÿline');

  const uni = await (await fetch(`${BASE}/api/suggest?q=カゲロウ`)).json();
  assert.equal(uni.length, 1);
  assert.equal(uni[0].artist_unicode, 'DECO*27');
});

test('free-text guess accepts romanised and unicode forms', async () => {
  const kage = (await (await fetch(`${BASE}/api/suggest?q=カゲロウ`)).json())[0];
  assert.equal((await guess(kage.id, 'カゲロウ')).correct, true); // unicode title
  assert.equal((await guess(kage.id, 'DECO*27')).correct, true); // unicode artist
  assert.equal((await guess(kage.id, 'not in the library')).correct, false);

  const neon = (await (await fetch(`${BASE}/api/suggest?q=Neon Skyline`)).json())[0];
  assert.equal((await guess(neon.id, 'DJ Nova - Neon Skyline')).correct, true);
  // unicode form, ASCII case folded (SQLite lower() is ASCII-only, as in
  // the stable path — accented letters match exactly)
  assert.equal((await guess(neon.id, 'néo Skÿline')).correct, true);
});

test('song detail lists all difficulties from both sets', async () => {
  const neon = (await (await fetch(`${BASE}/api/suggest?q=Neon Skyline`)).json())[0];
  const song = await (await fetch(`${BASE}/api/song/${neon.id}`)).json();
  assert.equal(song.title, 'Neon Skyline');
  assert.equal(song.title_unicode, 'Néo Skÿline');
  assert.equal(song.artist_unicode, 'DJ Noïa');
  assert.equal(song.creator, 'Mapper One, Mapper Two');
  assert.equal(song.beatmap_count, 3);
  assert.equal(song.preview_time, 5000);
  assert.deepEqual(song.beatmaps.map((b) => b.mode).sort(), ['standard', 'standard', 'taiko']);
  assert.deepEqual(song.beatmaps.map((b) => b.difficulty).sort(), ['Hard', 'Insane', 'Normal']);
  assert.ok(song.beatmaps.every((b) => b.beatmap_id && b.set_id));
  assert.ok(!('path' in song), 'filesystem path must not be exposed');
});

test('audio streams from the files/ store with range support', async () => {
  const neon = (await (await fetch(`${BASE}/api/suggest?q=Neon Skyline`)).json())[0];
  const res = await fetch(`${BASE}/audio/${neon.id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/wav');

  const kage = (await (await fetch(`${BASE}/api/suggest?q=カゲロウ`)).json())[0];
  const res2 = await fetch(`${BASE}/audio/${kage.id}`);
  assert.equal(res2.status, 200);
  assert.equal(res2.headers.get('content-type'), 'audio/ogg');

  const ranged = await fetch(`${BASE}/audio/${neon.id}`, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  const buf = Buffer.from(await ranged.arrayBuffer());
  assert.equal(buf.length, 100);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
});

test('reindex rebuilds the same library', async () => {
  const res = await fetch(`${BASE}/api/reindex`, { method: 'POST' });
  assert.equal(res.status, 202);
  await waitFor(async () => (await status()).indexing === false, 60000, 'reindex build');
  const st = await status();
  assert.equal(st.songCount, 3);
  assert.equal(st.beatmapCount, 5);
  assert.equal(st.error, null);
});