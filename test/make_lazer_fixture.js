// Generates a synthetic osu!lazer data folder for tests: a client.realm
// written with realm (the writer side needs a schema; the reader opens
// with none — the same asymmetry as a real lazer install) plus a fake
// files/ store holding tiny GENERATED silent audio files. No real or
// copyrighted audio ever touches this repo.
//
// Usage: node test/make_lazer_fixture.js <target-dir>
// Programmatic: import { buildLazerFixture } from './make_lazer_fixture.js'

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { default as Realm } from 'realm';

// Mirrors the table/property layout of the real client.realm (table names
// as stored in the file). Embedded FileUsage + linked File/BeatmapMetadata/
// Ruleset match the current ppy/osu models.
const SCHEMA = [
  {
    name: 'BeatmapSet',
    primaryKey: 'ID',
    properties: {
      ID: 'string',
      OnlineID: 'int',
      DeletePending: 'bool',
      Beatmaps: 'Beatmap[]',
      Files: 'FileUsage[]',
    },
  },
  { name: 'FileUsage', embedded: true, properties: { File: 'File', Filename: 'string' } },
  { name: 'File', primaryKey: 'Hash', properties: { Hash: 'string' } },
  {
    name: 'Beatmap',
    primaryKey: 'ID',
    properties: {
      ID: 'string',
      OnlineID: 'int',
      DifficultyName: 'string',
      Metadata: 'BeatmapMetadata',
      Ruleset: 'Ruleset',
    },
  },
  {
    name: 'BeatmapMetadata',
    primaryKey: 'ID',
    properties: {
      ID: 'string',
      Title: 'string',
      TitleUnicode: 'string',
      Artist: 'string',
      ArtistUnicode: 'string',
      Author: 'string',
      Source: 'string',
      Tags: 'string',
      PreviewTime: 'int',
      AudioFile: 'string',
      BackgroundFile: 'string',
    },
  },
  {
    name: 'Ruleset',
    primaryKey: 'ID',
    properties: { ID: 'string', ShortName: 'string', Name: 'string', OnlineID: 'int' },
  },
];

/** Minimal 16-bit mono PCM WAV of pure silence. */
export function silentWav(seconds = 0.25, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const data = Buffer.alloc(n * 2); // zeros = silence
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); // fmt chunk size
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // byte rate
  h.writeUInt16LE(2, 32); // block align
  h.writeUInt16LE(16, 34); // bits per sample
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** OggS page header — enough for magic-byte sniffing. */
export function oggStub() {
  const b = Buffer.alloc(48);
  b.write('OggS', 0, 'latin1');
  b.writeUInt32LE(2, 4); // version
  return b;
}

const H = {
  a: 'a'.repeat(40), // shared by two sets → dedup + case-insensitivity case
  b: 'b'.repeat(40), // unicode-only title
  c: 'c'.repeat(40), // set is delete-pending
  d: 'd'.repeat(40), // AudioFile absent from the set's Files
  e: 'e'.repeat(40), // file missing on disk
  g: 'g'.repeat(40), // AudioFile reference with a directory prefix
};

const fileRel = (h) => path.join('files', h[0], h.slice(0, 2), h);

/**
 * Build the fixture at `dir`.
 * @returns {{dir: string, hashes: object, fileRel: (h: string) => string}}
 */
export async function buildLazerFixture(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Audio on disk: a, b, c, g. (d and e are deliberately absent.)
  const onDisk = [
    [H.a, silentWav()],
    [H.b, oggStub()],
    [H.c, silentWav()],
    [H.g, silentWav()],
  ];
  for (const [h, content] of onDisk) {
    const p = path.join(dir, fileRel(h));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }

  const realm = new Realm({ path: path.join(dir, 'client.realm'), schema: SCHEMA });
  realm.write(() => {
    const ruleset = (id, short) =>
      realm.create('Ruleset', { ID: id, ShortName: short, Name: short, OnlineID: 0 });
    const meta = (id, p) =>
      realm.create('BeatmapMetadata', {
        ID: id,
        Title: '',
        TitleUnicode: '',
        Artist: '',
        ArtistUnicode: '',
        Author: '',
        Source: '',
        Tags: '',
        PreviewTime: -1,
        AudioFile: '',
        BackgroundFile: '',
        ...p,
      });
    const beatmap = (id, { onlineId, diff, rulesetId, metaId }) =>
      realm.create('Beatmap', {
        ID: id,
        OnlineID: onlineId,
        DifficultyName: diff,
        Metadata: realm.objectForPrimaryKey('BeatmapMetadata', metaId),
        Ruleset: realm.objectForPrimaryKey('Ruleset', rulesetId),
      });
    const set = (id, { onlineId, deletePending = false, beatmaps = [], files = [] }) =>
      realm.create('BeatmapSet', {
        ID: id,
        OnlineID: onlineId,
        DeletePending: deletePending,
        Beatmaps: beatmaps,
        Files: files,
      });

    const rsOsu = ruleset('r-osu', 'osu');
    const rsTaiko = ruleset('r-taiko', 'taiko');
    const rs3d = ruleset('r-3d', '3d'); // not a legacy mode → skipped

    const fA = realm.create('File', { Hash: H.a });
    const fB = realm.create('File', { Hash: H.b });
    const fC = realm.create('File', { Hash: H.c });
    const fE = realm.create('File', { Hash: H.e });
    const fG = realm.create('File', { Hash: H.g });

    // Set 1: two standard difficulties sharing audio A.
    const m1a = meta('m-1a', {
      Title: 'Neon Skyline',
      TitleUnicode: 'Néo Skÿline',
      Artist: 'DJ Nova',
      ArtistUnicode: 'DJ Noïa',
      Author: 'Mapper One',
      Source: 'Synthwave',
      Tags: 'synthwave neon',
      PreviewTime: 5000,
      AudioFile: 'track-a.mp3',
    });
    const m1b = meta('m-1b', {
      Title: 'Neon Skyline',
      Artist: 'DJ Nova',
      Author: 'Mapper One',
      Source: 'Synthwave',
      Tags: 'synthwave neon',
      AudioFile: 'track-a.mp3',
    });
    const b1a = beatmap('b-1a', { onlineId: 1001, diff: 'Insane', rulesetId: 'r-osu', metaId: 'm-1a' });
    const b1b = beatmap('b-1b', { onlineId: 1002, diff: 'Normal', rulesetId: 'r-osu', metaId: 'm-1b' });
    set('s-1', { onlineId: 5001, beatmaps: [b1a, b1b], files: [{ File: fA, Filename: 'track-a.mp3' }] });

    // Set 2: taiko, SAME audio A, filename in different case.
    const m2 = meta('m-2', {
      Title: 'Neon Skyline',
      Artist: 'DJ Nova',
      Author: 'Mapper Two',
      Tags: 'taiko',
      AudioFile: 'TRACK-A.MP3',
    });
    const b2 = beatmap('b-2', { onlineId: 2001, diff: 'Hard', rulesetId: 'r-taiko', metaId: 'm-2' });
    set('s-2', { onlineId: 5002, beatmaps: [b2], files: [{ File: fA, Filename: 'track-a.mp3' }] });

    // Set 3: unicode-only title/artist, ogg audio.
    const m3 = meta('m-3', {
      TitleUnicode: 'カゲロウ',
      ArtistUnicode: 'DECO*27',
      Author: 'Mapper Three',
      Tags: 'vocaloid',
      PreviewTime: 8000,
      AudioFile: 'audio-b.ogg',
    });
    const b3 = beatmap('b-3', { onlineId: 3001, diff: 'Expert', rulesetId: 'r-osu', metaId: 'm-3' });
    set('s-3', { onlineId: 5003, beatmaps: [b3], files: [{ File: fB, Filename: 'audio-b.ogg' }] });

    // Set 4: delete-pending → skipped even though the audio exists on disk.
    const m4 = meta('m-4', { Title: 'Deleted Song', Artist: 'Nobody', Author: 'X', AudioFile: 'track-c.mp3' });
    const b4 = beatmap('b-4', { onlineId: 4001, diff: 'Easy', rulesetId: 'r-osu', metaId: 'm-4' });
    set('s-4', { onlineId: 5004, deletePending: true, beatmaps: [b4], files: [{ File: fC, Filename: 'track-c.mp3' }] });

    // Set 5: AudioFile has no entry in the set's Files → unresolvable.
    const m5 = meta('m-5', { Title: 'Ghost Track', Artist: 'Phantom', Author: 'Y', AudioFile: 'missing-audio.mp3' });
    const b5 = beatmap('b-5', { onlineId: 6001, diff: 'Easy', rulesetId: 'r-osu', metaId: 'm-5' });
    set('s-5', { onlineId: 5005, beatmaps: [b5], files: [] });

    // Set 6: audio referenced but missing on disk.
    const m6 = meta('m-6', { Title: 'Half Downloaded', Artist: 'Z', Author: 'Z', AudioFile: 'track-e.mp3' });
    const b6 = beatmap('b-6', { onlineId: 7001, diff: 'Easy', rulesetId: 'r-osu', metaId: 'm-6' });
    set('s-6', { onlineId: 5006, beatmaps: [b6], files: [{ File: fE, Filename: 'track-e.mp3' }] });

    // Set 7: unknown ruleset → skipped (would otherwise double-count A).
    const m7 = meta('m-7', { Title: 'Future Mode', Artist: 'Q', Author: 'Q', AudioFile: 'track-a.mp3' });
    const b7 = beatmap('b-7', { onlineId: 8001, diff: 'Easy', rulesetId: 'r-3d', metaId: 'm-7' });
    set('s-7', { onlineId: 5007, beatmaps: [b7], files: [{ File: fA, Filename: 'track-a.mp3' }] });

    // Set 8: no beatmaps at all.
    set('s-8', { onlineId: 5008, beatmaps: [], files: [] });

    // Set 9: AudioFile reference with a directory prefix.
    const m9 = meta('m-9', {
      Title: 'Named Track',
      Artist: 'Local Artist',
      Author: 'Local Mapper',
      Tags: 'local',
      PreviewTime: 1234,
      AudioFile: 'audio/track-g.mp3',
    });
    const b9 = beatmap('b-9', { onlineId: 9001, diff: 'Normal', rulesetId: 'r-osu', metaId: 'm-9' });
    set('s-9', { onlineId: 5009, beatmaps: [b9], files: [{ File: fG, Filename: 'track-g.mp3' }] });
  });
  realm.close();
  return { dir, hashes: H, fileRel };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) {
    console.error('usage: node make_lazer_fixture.js <target-dir>');
    process.exit(1);
  }
  await buildLazerFixture(target);
  console.log(`lazer fixture written to ${target}`);
  // realm keeps native handles alive after close() — exit explicitly.
  process.exit(0);
}