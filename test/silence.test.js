// Unit tests for the leading-silence detector (public/silence.js), which the
// client uses to start clips at the first audible moment of a song.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leadingSilenceOffset, audioBufferSilenceOffset } from '../public/silence.js';

const SR = 1000;

/** `silent` leading zeros, then a constant-amplitude tone for the rest. */
function toneAfter(silent, total, amp = 0.5) {
  const ch = new Float32Array(total);
  for (let i = silent; i < total; i++) ch[i] = amp * (i % 2 === 0 ? 1 : -1); // square-ish tone
  return ch;
}

test('buffer that opens with content -> offset 0', () => {
  const ch = new Float32Array([0.5, -0.4, 0.3, 0.2]);
  assert.equal(leadingSilenceOffset([ch], SR), 0);
});

test('leading digital silence is skipped to the first tone sample', () => {
  const off = leadingSilenceOffset([toneAfter(500, 1000)], SR);
  assert.equal(off, 500 / SR);
});

test('stereo: the earliest audible channel wins', () => {
  const a = toneAfter(300, 1000); // right-of-centre start
  const b = toneAfter(200, 1000); // earlier start
  assert.equal(leadingSilenceOffset([a, b], SR), 200 / SR);
});

test('a silent channel cannot mask an audible one', () => {
  const silent = new Float32Array(1000); // all zeros
  const audible = toneAfter(0, 1000);
  assert.equal(leadingSilenceOffset([silent, audible], SR), 0);
});

test('a low noise floor below the threshold counts as silence', () => {
  const ch = new Float32Array(1000);
  for (let i = 0; i < 400; i++) ch[i] = 0.0001; // ≈ -80 dBFS hiss
  for (let i = 400; i < 1000; i++) ch[i] = 0.5;
  assert.equal(leadingSilenceOffset([ch], SR), 400 / SR);
});

test('entirely silent buffer -> 0 (still plays from the start)', () => {
  assert.equal(leadingSilenceOffset([new Float32Array(1000).fill(0)], SR), 0);
});

test('very quiet but non-silent buffer is not treated as all-silence', () => {
  // Peak 0.002 is above the all-silent cutoff, so its onset is detected.
  const ch = toneAfter(250, 1000, 0.002);
  assert.equal(leadingSilenceOffset([ch], SR), 250 / SR);
});

test('empty / malformed input -> 0', () => {
  assert.equal(leadingSilenceOffset([], SR), 0);
  assert.equal(leadingSilenceOffset([new Float32Array(0)], SR), 0);
  assert.equal(leadingSilenceOffset(null, SR), 0);
  assert.equal(leadingSilenceOffset([new Float32Array(10)], 0), 0);
});

test('audioBufferSilenceOffset wraps an AudioBuffer-shaped object', () => {
  const data = toneAfter(250, 1000);
  const fake = {
    numberOfChannels: 1,
    sampleRate: SR,
    getChannelData: () => data,
  };
  assert.equal(audioBufferSilenceOffset(fake), 250 / SR);
  assert.equal(audioBufferSilenceOffset(null), 0);
  assert.equal(audioBufferSilenceOffset({}), 0);
});

test('offset scales with the sample rate', () => {
  // Same 500-sample silence, half the rate -> half the seconds.
  assert.equal(leadingSilenceOffset([toneAfter(500, 1000)], 2000), 500 / 2000);
});