// osuguessr — client game logic (vanilla JS, no build step).

import { audioBufferSilenceOffset } from './silence.js';

const CLIPS = [0.1, 0.5, 2, 8, 15]; // seconds, per successive play press
const POINTS = [100, 80, 60, 40, 20];

const fmtInt = (n) => Number(n || 0).toLocaleString();

const $ = (sel) => document.querySelector(sel);

const views = {
  indexing: $('#view-indexing'),
  empty: $('#view-empty'),
  game: $('#view-game'),
  result: $('#view-result'),
};

const state = {
  songId: null,
  tier: 0, // clip length currently selected — what "play" plays
  maxReached: 0, // highest tier unlocked via "next clip"
  maxPlayed: -1, // longest clip actually played this round (-1 = none yet)
  resolved: false,
  playing: false,
  roundNum: 0,
  score: load('score', 0),
  best: load('best', 0),
  streak: load('streak', 0),
  recent: load('recent', []),
  volume: load('volume', 50), // percent
  tag: load('tag', ''), // active tag filter ('' = all songs)
};

let audioCtx = null;
const bufferCache = new Map(); // songId -> { buffer: AudioBuffer, offset: number } | { fallback: true, bytes }

// ---------- persistence ----------

function load(key, fallback) {
  try {
    const v = localStorage.getItem(`osuguessr:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save() {
  try {
    localStorage.setItem('osuguessr:score', JSON.stringify(state.score));
    localStorage.setItem('osuguessr:best', JSON.stringify(state.best));
    localStorage.setItem('osuguessr:streak', JSON.stringify(state.streak));
    localStorage.setItem('osuguessr:recent', JSON.stringify(state.recent));
    localStorage.setItem('osuguessr:volume', JSON.stringify(state.volume));
    localStorage.setItem('osuguessr:tag', JSON.stringify(state.tag));
  } catch {}
}
function pushRecent(id) {
  state.recent = [id, ...state.recent.filter((x) => x !== id)].slice(0, 12);
  save();
}

// ---------- view switching ----------

function show(name) {
  for (const [k, el] of Object.entries(views)) el.classList.toggle('hidden', k !== name);
  if (name !== 'result') {
    // Left the result screen: stop the background music, and bump the token so
    // a still-loading full-song fetch cannot start playing in the new view.
    playToken++;
    stopPlayback();
  }
  const heading = views[name].querySelector('h2');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
}

function updateScoreboard(songCount) {
  $('#stat-score').textContent = state.score;
  $('#stat-streak').textContent = state.streak;
  $('#stat-best').textContent = state.best;
  if (songCount != null) $('#stat-songs').textContent = songCount;
}

/**
 * Populate the tag-filter dropdown with the library's top 25 tags and keep
 * the Songs stat in sync (filtered pool size while a tag is active). Called
 * on boot and after every (re)index, since the tag set can change.
 */
async function loadTags() {
  const sel = $('#tag-filter');
  let data;
  try {
    const res = await fetch('/api/tags');
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  sel.innerHTML =
    '<option value="">All songs</option>' +
    data.tags
      .map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`)
      .join('');
  // A saved tag can go stale after a reindex — reset it if it no longer exists.
  if (state.tag && !data.tags.some((t) => t.tag === state.tag)) {
    state.tag = '';
    save();
  }
  sel.value = state.tag;
  const active = data.tags.find((t) => t.tag === state.tag);
  $('#stat-songs').textContent = active ? active.count : data.all;
}

// ---------- indexing state ----------

let pollTimer = null;
let pollInFlight = false;
let lastSeenIndexed = null;

async function pollIndex() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollIndexInner();
  } finally {
    pollInFlight = false;
  }
}

async function pollIndexInner() {
  let st;
  try {
    st = await (await fetch('/api/status')).json();
  } catch {
    return; // server restarting; retry next tick
  }
  if (st.lastIndexed !== lastSeenIndexed) {
    // A (re)index happened: song ids are reassigned, so drop cached decoded
    // audio — an id can now belong to a different song.
    if (lastSeenIndexed !== null) bufferCache.clear();
    lastSeenIndexed = st.lastIndexed;
  }
  if (st.indexing) {
    show('indexing');
    $('#indexing-title').textContent = 'Building song index…';
    const phases = {
      start: 'Starting…',
      realm: 'Opening beatmap database…',
      songs: 'Scanning audio files…',
      beatmaps: 'Parsing beatmaps…',
      tags: 'Reading embedded tags for unmatched songs…',
      write: 'Writing index…',
      done: 'Finalizing…',
    };
    let detail = phases[st.phase] || 'Working…';
    $('#indexing-dir').textContent = `Songs: ${st.songsDir}${st.beatmapsDir ? ` · Beatmaps: ${st.beatmapsDir}` : ''}`;
    const bar = $('#indexing-bar');
    const pr = st.progress;
    if (pr && pr.total > 0) {
      bar.style.width = `${Math.max(5, Math.round((pr.done / pr.total) * 100))}%`;
      detail += ` — ${fmtInt(pr.done)}/${fmtInt(pr.total)}`;
    } else if (pr && pr.done > 0) {
      bar.style.width = '5%';
      detail += ` — ${fmtInt(pr.done)} files so far`;
    } else {
      bar.style.width = '5%';
    }
    $('#indexing-detail').textContent = detail;
    return;
  }
  clearInterval(pollTimer);
  updateScoreboard(st.songCount);
  loadTags(); // refresh top tags (they change on every (re)index)
  if (st.songCount === 0) {
    show('empty');
    return;
  }
  await newRound();
}

function watchIndex() {
  clearInterval(pollTimer);
  pollTimer = setInterval(pollIndex, 1500);
  pollIndex();
}

// ---------- audio ----------

async function getCtx() {
  audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') await audioCtx.resume();
  return audioCtx;
}

async function loadBuffer(id) {
  if (bufferCache.has(id)) return bufferCache.get(id);
  const res = await fetch(`/audio/${id}`);
  if (!res.ok) throw new Error(`audio HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  try {
    const ctx = await getCtx();
    const ab = await ctx.decodeAudioData(bytes);
    // osu! tracks often open with dead air — remember where the audio
    // actually starts so clips can skip straight to it.
    const entry = { buffer: ab, offset: audioBufferSilenceOffset(ab) };
    cacheSet(id, entry);
    return entry;
  } catch {
    // Undecodable by this browser: no samples to analyse, offset stays 0.
    const entry = { fallback: true, bytes };
    cacheSet(id, entry);
    return entry;
  }
}

/** Clip start offset (s) for a cached buffer — leading silence skipped. */
function startOffsetOf(cached) {
  if (!cached || cached.fallback || !cached.buffer) return 0;
  const d = cached.buffer.duration;
  const o = cached.offset || 0;
  return o > 0 && o < d ? o : 0;
}

function cacheSet(id, value) {
  bufferCache.set(id, value);
  if (bufferCache.size > 8) bufferCache.delete(bufferCache.keys().next().value);
}

let activeStop = null;
let activeVolumeSetter = null; // fn(0..1) — applies volume to whatever is audible right now
let playToken = 0;
function stopPlayback() {
  if (activeStop) {
    try { activeStop(); } catch {}
    activeStop = null;
  }
  activeVolumeSetter = null;
}

/** Apply a 0..1 volume to the active source, if any. */
function setLiveVolume(v) {
  if (activeVolumeSetter) {
    try { activeVolumeSetter(v); } catch {}
  }
}

/** Play `seconds` of the song, starting at its first audible sample. `volume` is 0..1. */
async function playClip(id, seconds, volume) {
  const token = ++playToken; // supersede any in-flight clip
  stopPlayback();
  state.playing = true;
  renderPlayButton();
  const vol = Math.max(0, Math.min(1, volume));
  try {
    const cached = await loadBuffer(id);
    if (cached.fallback) {
      // Browser couldn't decode natively — stream via <audio> and cut with a timer.
      const url = URL.createObjectURL(new Blob([cached.bytes]));
      const el = new Audio(url);
      el.volume = vol;
      activeVolumeSetter = (v) => { el.volume = v; };
      activeStop = () => {
        try { el.pause(); } catch {}
        try { URL.revokeObjectURL(url); } catch {}
      };
      await el.play();
      await sleep(seconds * 1000);
    } else {
      const ctx = await getCtx();
      const gain = ctx.createGain();
      gain.gain.value = vol;
      activeVolumeSetter = (v) => { gain.gain.value = v; };
      const src = ctx.createBufferSource();
      src.buffer = cached.buffer;
      src.connect(gain);
      gain.connect(ctx.destination);
      const startAt = startOffsetOf(cached);
      src.start(0, startAt, Math.min(seconds, cached.buffer.duration - startAt));
      activeStop = () => {
        try { src.stop(); } catch {}
      };
      await sleep(seconds * 1000);
    }
  } finally {
    if (token === playToken) {
      stopPlayback(); // pause the source once the clip window is over
      state.playing = false;
      renderPlayButton();
    }
  }
}

/**
 * Play the whole song (result-screen background music). Unlike playClip there
 * is no cut-off: the song plays to the end. Best-effort — a failure (e.g.
 * autoplay policy) must never block the result screen.
 */
async function playWhole(id, volume) {
  const token = ++playToken;
  stopPlayback();
  try {
    const cached = await loadBuffer(id);
    if (token !== playToken) return; // user already left the screen
    const vol = Math.max(0, Math.min(1, volume));
    if (cached.fallback) {
      const url = URL.createObjectURL(new Blob([cached.bytes]));
      const el = new Audio(url);
      el.volume = vol;
      activeVolumeSetter = (v) => { el.volume = v; };
      const stop = () => {
        try { el.pause(); } catch {}
        try { URL.revokeObjectURL(url); } catch {}
      };
      el.onended = () => { if (activeStop === stop) { activeStop = null; activeVolumeSetter = null; } stop(); };
      await el.play();
      activeStop = stop;
    } else {
      const ctx = await getCtx();
      const gain = ctx.createGain();
      gain.gain.value = vol;
      activeVolumeSetter = (v) => { gain.gain.value = v; };
      const src = ctx.createBufferSource();
      src.buffer = cached.buffer;
      src.connect(gain);
      gain.connect(ctx.destination);
      const stop = () => {
        try { src.stop(); } catch {}
      };
      src.onended = () => { if (activeStop === stop) { activeStop = null; activeVolumeSetter = null; } };
      src.start(0, startOffsetOf(cached));
      activeStop = stop;
    }
  } catch {
    // ignore — background music is a nice-to-have
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- game flow ----------

function resetRoundState() {
  state.tier = 0;
  state.maxReached = 0;
  state.maxPlayed = -1;
  state.resolved = false;
  // A clip interrupted by the round ending keeps state.playing true until its
  // (superseded) sleep finishes — clear it so the new round's play button works.
  state.playing = false;
}

async function newRound() {
  resetRoundState();
  state.roundNum++;
  const tag = state.tag ? `&tag=${encodeURIComponent(state.tag)}` : '';
  const res = await fetch(`/api/round?exclude=${state.recent.join(',')}${tag}`);
  if (res.status === 503) {
    show('indexing');
    $('#indexing-title').textContent = 'Rebuilding index…';
    $('#indexing-detail').textContent = 'Please wait, a new index is being built.';
    watchIndex();
    return;
  }
  if (res.status === 404 && state.tag) {
    // Filtered pool is empty (can only happen right after a reindex drops
    // the tag) — stay on the game view and say so.
    state.songId = null; // no active round — play/guess stay inert
    show('game');
    $('#round-num').textContent = state.roundNum;
    renderLadder();
    renderPlayButton();
    renderNextButton();
    setClipStatus(`No songs with tag "${state.tag}" — set the tag filter back to All songs.`, 'bad');
    return;
  }
  if (!res.ok) {
    show('empty');
    return;
  }
  const { songId } = await res.json();
  state.songId = songId;
  hideSuggest();
  $('#round-num').textContent = state.roundNum;
  renderLadder();
  renderPlayButton();
  renderNextButton();
  setClipStatus('');
  show('game');
  $('#guess-input').focus();
}

async function onPlay() {
  if (state.playing || state.resolved || state.songId == null) return;
  try {
    await playClip(state.songId, CLIPS[state.tier], state.volume / 100);
  } catch (err) {
    setClipStatus(`Could not play the audio (${err.message}). Try another song.`, 'bad');
    return;
  }
  // Replay: playing never advances the tier — "Next clip" does that.
  state.maxPlayed = Math.max(state.maxPlayed, state.tier);
  renderLadder();
  renderPlayButton();
  renderNextButton();
  const maxed = state.maxPlayed >= CLIPS.length - 1;
  setClipStatus(
    maxed
      ? 'That was the full 15s clip. A wrong guess from here ends the round — make it count.'
      : `Played the ${fmtSec(CLIPS[state.tier])} clip. Press play to hear it again, or Next clip for a longer one.`,
    '',
  );
}

/** Unlock the next, longer clip and play it. */
async function onNextClip() {
  if (state.playing || state.resolved || state.songId == null) return;
  if (state.tier >= CLIPS.length - 1) return;
  state.tier++;
  state.maxReached = Math.max(state.maxReached, state.tier);
  await onPlay();
}

/** Select a previously unlocked clip length (clickable ladder rung). */
function selectTier(i) {
  if (state.playing || state.resolved || i < 0 || i > state.maxReached) return;
  state.tier = i;
  renderLadder();
  renderPlayButton();
  renderNextButton();
  setClipStatus(`Selected the ${fmtSec(CLIPS[i])} clip — press play to hear it.`, '');
}

let submitting = false;
async function submitGuess(guessId, text) {
  if (state.resolved || submitting || state.songId == null) return;
  submitting = true;
  try {
    hideSuggest();
    const res = await fetch('/api/guess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songId: state.songId, guessId: guessId ?? null, text: text ?? null }),
    });
    const out = await res.json();
    if (out.correct) {
      finishRound(true);
      return;
    }
flashWrong();
    if (state.maxPlayed >= CLIPS.length - 1) {
      setClipStatus('Not that one… and you already heard the full 15s. Round over!', 'bad');
      finishRound(false);
    } else {
      setClipStatus('Not that one. Replay it, or unlock a longer clip with Next clip.', 'bad');
    }
  } finally {
    submitting = false;
  }
}

async function finishRound(won) {
  if (state.resolved) return; // double-submit guard
  state.resolved = true;
  stopPlayback();
  let song = null;
  try {
    const res = await fetch(`/api/song/${state.songId}`);
    if (res.ok) song = await res.json();
  } catch {}
  let points = 0;
  let clipUsed = null;
  if (won) {
    // Points reflect the longest clip actually heard this round — replaying
    // a short clip after unlocking a longer one does not raise the score.
    const tier = Math.max(0, Math.min(state.maxPlayed, CLIPS.length - 1));
    clipUsed = CLIPS[tier];
    points = POINTS[tier] + state.streak * 5;
    state.streak++;
    state.score += points;
    state.best = Math.max(state.best, state.score);
  } else {
    state.streak = 0;
  }
  save();
  updateScoreboard(null);
  renderResult(song, won, points, clipUsed);
  pushRecent(state.songId);
}

function flashWrong() {
  const input = $('#guess-input');
  input.classList.remove('wrong');
  void input.offsetWidth; // restart animation
  input.classList.add('wrong');
  setTimeout(() => input.classList.remove('wrong'), 600);
}

function setClipStatus(text, cls) {
  const el = $('#clip-status');
  el.textContent = text;
  el.classList.remove('good', 'bad');
  if (cls) el.classList.add(cls);
}

// ---------- rendering ----------

function renderLadder() {
  const ladder = $('#ladder');
  ladder.innerHTML = '';
  CLIPS.forEach((sec, i) => {
    const unlocked = i <= state.maxReached;
    const current = i === state.tier;
    let cls = 'rung';
    let tag = 'locked';
    if (current) {
      cls += ' next';
      tag = i === CLIPS.length - 1 && state.maxPlayed >= i ? 'max' : 'current';
    } else if (i < state.tier) {
      cls += ' done';
      tag = 'heard';
    } else if (unlocked) {
      cls += ' reachable';
      tag = 'unlocked';
    }
    const div = document.createElement('div');
    div.className = cls;
    if (unlocked && !state.resolved && !state.playing) {
      div.classList.add('clickable');
      div.title = `Play the ${fmtSec(sec)} clip`;
      div.addEventListener('click', () => selectTier(i));
    }
    div.innerHTML = `${fmtSec(sec)}<small>${tag}</small>`;
    ladder.appendChild(div);
  });
}

function fmtSec(s) {
  return `${s}s`;
}

function renderPlayButton() {
  const btn = $('#btn-play');
  const label = $('#play-label');
  if (state.playing) {
    label.innerHTML = '<span class="spinner-ring"></span> Playing…';
    btn.disabled = true;
    return;
  }
  btn.disabled = state.resolved;
  label.textContent = `Play ${fmtSec(CLIPS[state.tier])}`;
}

function renderNextButton() {
  const btn = $('#btn-nextclip');
  const maxed = state.tier >= CLIPS.length - 1;
  btn.textContent = maxed ? 'Max clip' : `Next clip ▸ ${fmtSec(CLIPS[state.tier + 1])}`;
  btn.disabled = maxed || state.resolved;
}

// The database stores romanised and unicode forms separately; the unicode
// form is the prettier one, so prefer it for display.
function displayTitle(song) {
  return song.title_unicode || song.title;
}
function displayArtist(song) {
  return song.artist_unicode || song.artist;
}

function renderResult(song, won, points, clipUsed) {
  const banner = $('#result-banner');
  banner.className = 'banner ' + (won ? 'won' : 'lost');
  if (won) {
    banner.textContent = `✓ Guessed it! +${points} points (from a ${clipUsed}s clip${state.streak > 1 ? `, streak ×${state.streak}` : ''})`;
  } else {
    banner.textContent = '✗ Failed — here is what you were listening to:';
  }

  if (!song) {
    $('#result-title').textContent = 'Unknown song';
    $('#result-artist').textContent = '';
    $('#result-mappers').innerHTML = '';
    $('#result-diffs').innerHTML = '<div class="diffs none">no metadata</div>';
    $('#result-meta').innerHTML = '';
    show('result');
    playWhole(state.songId, state.volume / 100);
    return;
  }

  const beatmaps = song.beatmaps || [];
  $('#result-title').textContent = displayTitle(song);
  $('#result-artist').textContent = displayArtist(song);

  const mappers = new Set(
    [song.creator, ...beatmaps.map((b) => b.creator)].filter(Boolean),
  );
  $('#result-mappers').innerHTML = [
    ...mappers,
  ]
    .slice(0, 6)
    .map((m) => `<span class="chip mapper">${esc(m)}</span>`)
    .join('');

  const diffs = $('#result-diffs');
  if (beatmaps.length === 0) {
    diffs.innerHTML = '<div class="diffs none">No beatmaps found for this song.</div>';
  } else {
    diffs.innerHTML = beatmaps
      .map((b) => {
        const link = b.beatmap_id
          ? `<a href="https://osu.ppy.sh/b/${b.beatmap_id}" target="_blank" rel="noopener">osu.ppy.sh ↗</a>`
          : b.set_id
            ? `<a href="https://osu.ppy.sh/s/${b.set_id}" target="_blank" rel="noopener">osu.ppy.sh ↗</a>`
            : '';
        const by = b.creator ? `<span class="by">by ${esc(b.creator)}</span>` : '';
        return `<div class="diff"><span class="mode">${esc(modeLabel(b.mode))}</span><span class="name">${esc(b.difficulty)}</span>${by}${link}</div>`;
      })
      .join('');
  }

  const meta = [
    ['Set source', beatmaps[0]?.set_source || song.source || ''],
    ['Tags', beatmaps[0]?.set_tags || song.tags || ''],
    ['Audio file', `${song.name} (${song.ext.toUpperCase()}, ${fmtSize(song.size)})`],
    ['Index origin', originLabel(song.origin)],
    ['Beatmaps', `${song.beatmap_count} difficulties across all modes`],
  ];
  $('#result-meta').innerHTML = meta
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`)
    .join('');

  show('result');
  // Background music: play the whole song while the user reads the overview.
  // Stopped automatically in show() when this screen is left.
  playWhole(state.songId, state.volume / 100);
}

function modeLabel(mode) {
  return { standard: 'osu!', taiko: 'osu!taiko', catch: 'osu!catch', mania: 'osu!mania' }[mode] || mode;
}
function originLabel(o) {
  return { beatmap: 'beatmap metadata', tags: 'embedded audio tags', file: 'file name only' }[o] || o;
}
function fmtSize(bytes) {
  if (bytes == null) return '?';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- autocomplete ----------

let suggestItems = [];
let suggestSel = -1;
let suggestTimer = null;

function renderSuggest() {
  const list = $('#suggest-list');
  if (suggestItems.length === 0) {
    list.innerHTML = '<li class="empty">No matches in your library</li>';
  } else {
    list.innerHTML = suggestItems
      .map(
        (s, i) =>
          `<li data-id="${s.id}" class="${i === suggestSel ? 'sel' : ''}" role="option">
             <span class="s-title">${esc(displayTitle(s))}</span>
             <span class="s-sub">${esc(displayArtist(s))}${s.creator ? ` · ${esc(s.creator)}` : ''}</span>
           </li>`,
      )
      .join('');
  }
  list.classList.remove('hidden');
  const selEl = list.querySelector('li.sel');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
}

function hideSuggest() {
  suggestItems = [];
  suggestSel = -1;
  $('#suggest-list').classList.add('hidden');
}

let suggestSeq = 0;
async function fetchSuggest(q) {
  const seq = ++suggestSeq;
  const res = await fetch(`/api/suggest?q=${encodeURIComponent(q)}`);
  if (seq !== suggestSeq) return; // a newer query superseded this one
  if (!res.ok) return hideSuggest();
  suggestItems = await res.json();
  suggestSel = -1;
  renderSuggest();
}

function wireGuessInput() {
  const input = $('#guess-input');
  const list = $('#suggest-list');

  input.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const q = input.value.trim();
    if (!q) return hideSuggest();
    suggestTimer = setTimeout(() => fetchSuggest(q), 120);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && suggestItems.length) {
      e.preventDefault();
      suggestSel = Math.min(suggestSel + 1, suggestItems.length - 1);
      renderSuggest();
    } else if (e.key === 'ArrowUp' && suggestItems.length) {
      e.preventDefault();
      suggestSel = Math.max(suggestSel - 1, 0);
      renderSuggest();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (suggestSel >= 0 && suggestItems[suggestSel]) {
        const item = suggestItems[suggestSel];
        input.value = `${displayTitle(item)} — ${displayArtist(item)}`;
        submitGuess(item.id);
      } else if (input.value.trim()) {
        submitGuess(null, input.value.trim());
      }
    } else if (e.key === 'Escape') {
      hideSuggest();
    }
  });

  list.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    e.preventDefault(); // keep focus in the input
    submitGuess(Number(li.dataset.id));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.guess-box')) hideSuggest();
  });

  $('#guess-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (suggestSel >= 0 && suggestItems[suggestSel]) submitGuess(suggestItems[suggestSel].id);
    else if (input.value.trim()) submitGuess(null, input.value.trim());
  });
}

// ---------- buttons ----------

function wireButtons() {
  $('#btn-play').addEventListener('click', onPlay);
  $('#btn-nextclip').addEventListener('click', onNextClip);
  $('#btn-giveup').addEventListener('click', () => {
    if (!state.resolved && state.songId != null) finishRound(false);
  });
  $('#btn-next').addEventListener('click', newRound);
  $('#btn-again').addEventListener('click', () => {
    const id = state.songId;
    state.songId = null;
    newRoundFor(id);
  });
  $('#tag-filter').addEventListener('change', (e) => {
  state.tag = e.target.value;
  save();
  loadTags(); // keep the Songs stat in sync with the new pool size
  newRound(); // switch immediately to a song from the filtered pool
});
  $('#btn-reindex').addEventListener('click', async () => {
    if (!confirm('Rebuild the entire song index? This rescans your osu! folders.')) return;
    const res = await fetch('/api/reindex', { method: 'POST' });
    if (res.ok || res.status === 202) watchIndex();
    else alert((await res.json().catch(() => ({}))).error || 'Reindex failed to start');
  });
}

/** Replay a specific song (used by "Same song again"). */
async function newRoundFor(id) {
  state.songId = id;
  resetRoundState();
  state.roundNum++;
  hideSuggest();
  $('#round-num').textContent = state.roundNum;
  renderLadder();
  renderPlayButton();
  renderNextButton();
  setClipStatus('');
  show('game');
  $('#guess-input').focus();
}

// ---------- boot ----------

function initVolume() {
  const input = $('#volume');
  const label = $('#volume-label');
  input.value = String(state.volume);
  label.textContent = `${state.volume}%`;
  input.addEventListener('input', () => {
    state.volume = Number(input.value);
    label.textContent = `${state.volume}%`;
    setLiveVolume(state.volume / 100); // affect whatever is playing right now
    save();
  });
}

function boot() {
  wireGuessInput();
  wireButtons();
  initVolume();
  updateScoreboard(null);
  watchIndex();
}

boot();