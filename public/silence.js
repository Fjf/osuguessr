// Leading-silence detection for decoded audio buffers.
//
// osu! tracks frequently open with dead air (intro padding, encoder
// pre-roll, a count-in with no music). The game plays short clips from the
// start of the file, so that silence would waste the clip. This module finds
// the first genuinely audible sample so playback can begin there instead.
//
// Kept free of any DOM/browser globals beyond an optional AudioBuffer so the
// core logic is unit-testable in Node.

// A sample counts as "content" once it reaches this fraction of the buffer's
// peak. 0.5% sits comfortably above the noise floor of real recordings while
// still below any real musical content.
const RELATIVE_THRESHOLD = 0.005;
// Never treat a level below this absolute value (≈ -66 dBFS) as content, even
// if the peak-relative threshold would be lower for a quiet file.
const ABSOLUTE_FLOOR = 0.0005;
// If the entire buffer peaks below this it is (for our purposes) all silence;
// there is nothing to start at, so we begin at 0.
const ALL_SILENT_PEAK = 0.0005;

/**
 * Find the offset, in seconds, of the first non-silent sample.
 *
 * A sample is "silent" while its magnitude is below
 * `max(absoluteFloor, peak * relativeThreshold)`, where `peak` is the maximum
 * magnitude across the whole buffer. Any channel reaching the threshold
 * starts the clip (stereo content in one channel still counts).
 *
 * @param {Float32Array[]} channels one sample array per channel (equal length)
 * @param {number} sampleRate
 * @param {{relativeThreshold?: number, absoluteFloor?: number}} [opts]
 * @returns {number} seconds from the start to the first audible sample (0 if
 *   the buffer opens with content or is entirely silent)
 */
export function leadingSilenceOffset(
  channels,
  sampleRate,
  { relativeThreshold = RELATIVE_THRESHOLD, absoluteFloor = ABSOLUTE_FLOOR } = {},
) {
  if (!channels || channels.length === 0 || !sampleRate) return 0;
  const n = channels[0] ? channels[0].length : 0;
  if (!n) return 0;

  // 1) Peak magnitude across the whole buffer (any channel).
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const v = ch[i];
      const m = v < 0 ? -v : v;
      if (m > peak) peak = m;
    }
  }
  if (peak < ALL_SILENT_PEAK) return 0; // effectively silent: start at 0

  const threshold = Math.max(absoluteFloor, peak * relativeThreshold);

  // 2) First sample at or above the threshold (any channel).
  for (let i = 0; i < n; i++) {
    for (const ch of channels) {
      const v = ch[i];
      if (v >= threshold || v <= -threshold) return i / sampleRate;
    }
  }
  return 0; // unreachable (peak >= threshold), but stay safe
}

/**
 * Convenience wrapper for a Web Audio `AudioBuffer`.
 * @param {AudioBuffer} buffer
 * @returns {number} leading-silence offset in seconds
 */
export function audioBufferSilenceOffset(buffer) {
  if (!buffer || typeof buffer.getChannelData !== 'function') return 0;
  const channels = [];
  for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
  return leadingSilenceOffset(channels, buffer.sampleRate);
}