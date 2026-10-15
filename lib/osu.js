// Minimal osu! beatmap (.osu) parser.
// Extracts only the metadata the game needs: audio reference (MD5 filename),
// title, artist, source, creator (mapper), difficulty name, online IDs.
//
// File format reference: the "osu file format" text files found in any osu!
// install. Mode is derived from the file extension:
//   .osu          -> standard
//   .osu.taiko    -> taiko
//   .osu.ctb      -> catch
//   .osu.mania    -> mania

export const MODE_LABELS = {
  standard: 'osu!',
  taiko: 'osu!taiko',
  catch: 'osu!catch',
  mania: 'osu!mania',
};

export function modeFromOsuPath(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.osu.taiko')) return 'taiko';
  if (lower.endsWith('.osu.ctb')) return 'catch';
  if (lower.endsWith('.osu.mania')) return 'mania';
  if (lower.endsWith('.osu')) return 'standard';
  return null;
}

/**
 * osu! stores audio in the Songs folder named after the MD5 of the file,
 * e.g. "d41d8cd98f00b204e9800998ecf8427e.mp3". The General section of a
 * beatmap references it via "AudioFilename". Some beatmaps prefix it with a
 * directory ("Songs/..."). We strip any directory and extension and verify
 * the remainder is a 32-char hex MD5.
 */
export function md5FromAudioFilename(value) {
  if (!value) return null;
  const base = value.split(/[\\/]/).pop();
  // osu! stores FLAC files as "<md5>.ogg.flac" and references them that way.
  let noExt;
  if (/\.ogg\.flac$/i.test(base)) noExt = base.slice(0, -'.ogg.flac'.length);
  else noExt = base.replace(/\.[a-z0-9]+$/i, '');
  if (/^[0-9a-f]{32}$/i.test(noExt)) return noExt.toLowerCase();
  return null;
}

/**
 * Parse an .osu file's text content.
 *
 * Title/artist are kept in both their romanised (`Title`, `Artist`) and
 * unicode (`TitleUnicode`, `ArtistUnicode`) forms — the caller decides
 * which to display (unicode preferred) and stores both for matching.
 *
 * @param {string} text
 * @returns {{
 *   audio: string|null, audioRaw: string|null, audioOriginal: string|null,
 *   title: string, titleUnicode: string, artist: string, artistUnicode: string,
 *   source: string, creator: string, version: string,
 *   previewTime: number|null, beatmapId: number|null, beatmapSetId: number|null
 * }}
 */
export function parseOsuFile(text) {
  const result = {
    audio: null,
    audioRaw: null,
    audioOriginal: null,
    title: '',
    titleUnicode: '',
    artist: '',
    artistUnicode: '',
    source: '',
    creator: '',
    version: '',
    tags: '',
    previewTime: null,
    beatmapId: null,
    beatmapSetId: null,
    beatmapMd5: null,
  };
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).toLowerCase();
      continue;
    }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (section === 'general') {
      if (key === 'AudioFilename') {
        result.audio = md5FromAudioFilename(value);
        result.audioRaw = value || null;
      } else if (key === 'AudioFilenameOriginal') {
        result.audioOriginal = value;
      } else if (key === 'PreviewOffset') {
        result.previewTime = parseInt(value, 10) || null;
      }
    } else if (section === 'metadata') {
      switch (key) {
        case 'Title':
          if (value) result.title = value;
          break;
        case 'TitleUnicode':
          if (value) result.titleUnicode = value;
          break;
        case 'Artist':
          if (value) result.artist = value;
          break;
        case 'ArtistUnicode':
          if (value) result.artistUnicode = value;
          break;
        case 'Source':
          result.source = value;
          break;
        case 'Creator':
          result.creator = value;
          break;
        case 'Version':
          result.version = value;
          break;
        case 'BeatmapID':
          result.beatmapId = parseInt(value, 10) || null;
          break;
        case 'BeatmapSetID':
          result.beatmapSetId = parseInt(value, 10) || null;
          break;
        case 'BeatmapMD5':
          result.beatmapMd5 = value || null;
          break;
        case 'Tags':
          result.tags = value;
          break;
        default:
          break;
      }
    }
  }
  return result;
}