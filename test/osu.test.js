import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOsuFile, md5FromAudioFilename, modeFromOsuPath } from '../lib/osu.js';

const SAMPLE = `osu file format v14

[General]
AudioFilename: d41d8cd98f00b204e9800998ecf8427e.mp3
AudioFilenameOriginal: Neon Skyline.mp3
AudioLeadIn: 1
PreviewOffset: 384340
CountCount: 1
CountSlide: 2
CountCircle: 3

[Metadata]
Title: Neon Skyline
TitleUnicode: Néo Skÿline
Artist: DJ Nova
ArtistUnicode: DJ Noïa
Source: Synthwave
Creator: Mapper One
Version: Insane
BeatmapID: 1234567
BeatmapSetID: 7654321
Tags: synthwave neon night

[Difficulty]
HPDrainRate: 8
CircleSize: 3
OverallDifficulty: 9
ApproachRate: 9

[TimingPoints]
500,180,4,0,0,50,1

[Colours]
Combo1 : 255,102,170,255

[Events]
0,0,"\\1\\h3\\fn25\\ff1\\fs50\\cHFF66AA" , , , , Title,
2,0,0,0,0

[HitObjects]
100,200,500,1,0,l:0|h:1|
`;

test('parseOsuFile extracts core metadata', () => {
  const m = parseOsuFile(SAMPLE);
  assert.equal(m.audio, 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(m.audioOriginal, 'Neon Skyline.mp3');
  assert.equal(m.title, 'Néo Skÿline'); // unicode wins
  assert.equal(m.artist, 'DJ Noïa');
  assert.equal(m.source, 'Synthwave');
  assert.equal(m.creator, 'Mapper One');
  assert.equal(m.version, 'Insane');
  assert.equal(m.beatmapId, 1234567);
  assert.equal(m.beatmapSetId, 7654321);
  assert.equal(m.tags, 'synthwave neon night');
});

test('parseOsuFile tolerates missing sections and CRLF', () => {
  const m = parseOsuFile('osu file format v14\r\n\r\n[General]\r\nAudioFilename: abc.mp3\r\n\r\n[HitObjects]\r\n');
  assert.equal(m.audio, null); // abc.mp3 is not an md5 name
  assert.equal(m.title, '');
  assert.equal(m.version, '');
});

test('md5FromAudioFilename handles prefixes and extensions', () => {
  assert.equal(
    md5FromAudioFilename('D41D8CD98F00B204E9800998ECF8427E.MP3'),
    'd41d8cd98f00b204e9800998ecf8427e',
  );
  assert.equal(
    md5FromAudioFilename('Songs/9f86d081884c7d659a2feaa0c55ad015.ogg.flac'),
    '9f86d081884c7d659a2feaa0c55ad015',
  );
  assert.equal(
    md5FromAudioFilename('G:\\Songs\\9f86d081884c7d659a2feaa0c55ad015.flac'),
    '9f86d081884c7d659a2feaa0c55ad015',
  );
  assert.equal(md5FromAudioFilename('not a hash.mp3'), null);
  assert.equal(md5FromAudioFilename(''), null);
});

test('modeFromOsuPath maps extensions', () => {
  assert.equal(modeFromOsuPath('a - b (Hard).osu'), 'standard');
  assert.equal(modeFromOsuPath('a - b (Hard).osu.taiko'), 'taiko');
  assert.equal(modeFromOsuPath('a - b (Hard).osu.ctb'), 'catch');
  assert.equal(modeFromOsuPath('a - b (Hard).osu.MANIA'), 'mania');
  assert.equal(modeFromOsuPath('song.mp3'), null);
});