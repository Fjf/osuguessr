import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pathFromHash,
  modeFromShortName,
  detectAudio,
  resolveAudio,
  authorName,
} from '../lib/lazer.js';

// NOTE: only the pure helpers are tested here. scanLazer imports the
// realm native module lazily, so this file runs fine even where realm
// cannot load.

const A = 'a'.repeat(40);

test('pathFromHash builds files/<h0>/<h0h1>/<hash>', () => {
  assert.equal(pathFromHash(A), `a/aa/${A}`);
  // sha-256 length hashes work the same way
  const g = 'g'.repeat(64);
  assert.equal(pathFromHash(g), `g/gg/${g}`);
  // input is normalised to lowercase
  assert.equal(pathFromHash('AB'.repeat(20)), `a/ab/${'ab'.repeat(20)}`);
  // too short to form the layout
  assert.equal(pathFromHash('ab'), null);
  assert.equal(pathFromHash(''), null);
  assert.equal(pathFromHash(null), null);
});

test('modeFromShortName maps lazer rulesets', () => {
  assert.equal(modeFromShortName('osu'), 'standard');
  assert.equal(modeFromShortName('taiko'), 'taiko');
  assert.equal(modeFromShortName('ctb'), 'catch');
  assert.equal(modeFromShortName('mania'), 'mania');
  assert.equal(modeFromShortName('OSU'), 'standard');
  assert.equal(modeFromShortName('3d'), null);
  assert.equal(modeFromShortName(''), null);
  assert.equal(modeFromShortName(undefined), null);
});

function buf(s, pad = 64) {
  const b = Buffer.alloc(pad);
  b.write(s, 0, 'latin1');
  return b;
}

test('detectAudio recognises the common formats', () => {
  const wav = buf('RIFF');
  wav.write('WAVE', 8, 'latin1');
  assert.deepEqual(detectAudio(wav), { ext: 'wav', mime: 'audio/wav' });

  assert.deepEqual(detectAudio(buf('fLaC')), { ext: 'flac', mime: 'audio/flac' });
  assert.deepEqual(detectAudio(buf('ID3')), { ext: 'mp3', mime: 'audio/mpeg' });

  const frame = buf('\u0000');
  frame[0] = 0xff;
  frame[1] = 0xf2;
  assert.deepEqual(detectAudio(frame), { ext: 'mp3', mime: 'audio/mpeg' });

  assert.deepEqual(detectAudio(buf('OggS')), { ext: 'ogg', mime: 'audio/ogg' });
  const opus = buf('OggS');
  opus.write('OpusHead', 28, 'latin1');
  assert.deepEqual(detectAudio(opus), { ext: 'opus', mime: 'audio/opus' });

  const m4a = buf('\u0000');
  m4a.write('ftyp', 4, 'latin1');
  assert.deepEqual(detectAudio(m4a), { ext: 'm4a', mime: 'audio/mp4' });
});

test('detectAudio rejects non-audio and tiny buffers', () => {
  assert.equal(detectAudio(buf('PK\x03\x04')), null); // zip
  assert.equal(detectAudio(Buffer.alloc(4)), null);
  assert.equal(detectAudio(Buffer.from('')), null);
});

test('resolveAudio matches case-insensitively on the basename', () => {
  const set = { Files: [{ File: { Hash: A }, Filename: 'track-a.mp3' }] };
  const hit = resolveAudio(set, 'track-a.mp3');
  assert.deepEqual(hit, { hash: A, rel: `a/aa/${A}` });
  assert.deepEqual(resolveAudio(set, 'TRACK-A.MP3'), hit);
  // a directory prefix in the reference is ignored
  assert.deepEqual(resolveAudio(set, 'audio/track-a.mp3'), hit);
  // old realm shape: Hash directly on the usage
  const oldSet = { Files: [{ Hash: A, Filename: 'track-a.mp3' }] };
  assert.deepEqual(resolveAudio(oldSet, 'track-a.mp3'), hit);
});

test('resolveAudio returns null when unresolvable', () => {
  const set = { Files: [{ File: { Hash: A }, Filename: 'other.mp3' }] };
  assert.equal(resolveAudio(set, 'track-a.mp3'), null);
  assert.equal(resolveAudio(set, ''), null);
  assert.equal(resolveAudio(set, null), null);
  assert.equal(resolveAudio({}, 'track-a.mp3'), null);
  assert.equal(resolveAudio({ Files: [{ Filename: 'x.mp3' }] }, 'x.mp3'), null);
  assert.equal(
    resolveAudio({ Files: [{ File: { Hash: 'ab' }, Filename: 'x' }] }, 'x'),
    null,
  );
});

test('authorName handles old (string) and new (object) shapes', () => {
  assert.equal(authorName('Mapper One'), 'Mapper One');
  assert.equal(authorName({ Username: 'Mapper One' }), 'Mapper One');
  assert.equal(authorName({ username: 'mapper' }), 'mapper');
  assert.equal(authorName(null), '');
  assert.equal(authorName(undefined), '');
  assert.equal(authorName({}), '');
});