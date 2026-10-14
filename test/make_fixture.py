#!/usr/bin/env python3
"""Generate a synthetic osu! library for testing.

Layout mirrors a real install:
  <root>/Songs/<md5>.<ext>      audio files named by content MD5
  <root>/<Set Folder>/<Mapper>.mine/<Title> (<Version>).osu[.mode]
"""
import hashlib
import math
import os
import shutil
import struct
import sys
import wave


def make_wav(path, freq, seconds=16):
    with wave.open(path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(44100)
        n = int(44100 * seconds)
        data = b"".join(
            struct.pack("<h", int(20000 * math.sin(2 * math.pi * freq * i / 44100)))
            for i in range(n)
        )
        w.writeframes(data)


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


OSU_TEMPLATE = """osu file format v14

[General]
AudioFilename: {audio}
AudioFilenameOriginal: {orig}
AudioLeadIn: 1
PreviewOffset: 100000
CountCircle: 10

[Metadata]
Title: {title}
Artist: {artist}
Source: {source}
Creator: {creator}
Version: {version}
BeatmapID: {bid}
BeatmapSetID: {sid}
Tags: {tags}

[Difficulty]
HPDrainRate: 5
CircleSize: 4
OverallDifficulty: 5
ApproachRate: 5

[TimingPoints]
500,180,4,0,0,50,1

[Events]

[HitObjects]
100,200,0,1,0,
"""


def make_osu(path, audio, title, artist, creator, version, bid, sid, source="", tags="", orig=None):
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            OSU_TEMPLATE.format(
                audio=audio,
                orig=orig or (title + ".mp3"),
                title=title,
                artist=artist,
                source=source,
                creator=creator,
                version=version,
                bid=bid,
                sid=sid,
                tags=tags,
            )
        )


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "/tmp/opencode/osu-test"
    shutil.rmtree(root, ignore_errors=True)
    songs = os.path.join(root, "Songs")
    os.makedirs(songs)

    # --- audio files -------------------------------------------------------
    # 1: standard set with two difficulties
    p1 = os.path.join(songs, "song1.wav")
    make_wav(p1, 440)
    a1 = md5_of(p1) + ".wav"
    os.rename(p1, os.path.join(songs, a1))

    # 2: catch
    p2 = os.path.join(songs, "song2.wav")
    make_wav(p2, 660)
    a2 = md5_of(p2) + ".wav"
    os.rename(p2, os.path.join(songs, a2))

    # 3: mania
    p3 = os.path.join(songs, "song3.wav")
    make_wav(p3, 880)
    a3 = md5_of(p3) + ".wav"
    os.rename(p3, os.path.join(songs, a3))

    # 4: no beatmaps at all -> file-name fallback
    p4 = os.path.join(songs, "song4.wav")
    make_wav(p4, 220)
    a4 = md5_of(p4) + ".wav"
    os.rename(p4, os.path.join(songs, a4))

    # 5: fake mp3 (not a real audio stream; API-level only)
    fake = os.path.join(songs, "song5.mp3")
    with open(fake, "wb") as f:
        f.write(b"\xff\xf3" + b"\x00" * 4096)
    a5 = md5_of(fake) + ".mp3"
    os.rename(fake, os.path.join(songs, a5))

    # 6+7: duplicate titles (free-text guess must accept either copy)
    p6 = os.path.join(songs, "song6.wav")
    make_wav(p6, 330)
    a6 = md5_of(p6) + ".wav"
    os.rename(p6, os.path.join(songs, a6))

    p7 = os.path.join(songs, "song7.wav")
    make_wav(p7, 550)
    a7 = md5_of(p7) + ".wav"
    os.rename(p7, os.path.join(songs, a7))

    # 8: stored under its original name (non-MD5 library); the beatmap only
    #    links back via AudioFilenameOriginal
    p8 = os.path.join(songs, "My Great Song.wav")
    make_wav(p8, 1000)

    # 9: per-set library layout — the set folder lives INSIDE Songs/, the
    #    audio sits next to the .osu file, and AudioFilename is a plain
    #    "audio.mp3" (no MD5, no AudioFilenameOriginal). Matching must use
    #    the same folder.
    set9 = os.path.join(songs, "999999 Per Set - Demo Song")
    os.makedirs(set9)
    make_wav(os.path.join(set9, "audio.mp3"), 770)  # wav bytes, .mp3 name: API-level only
    # an osu! hit sound that must NOT be indexed as a song
    make_wav(os.path.join(set9, "drum-hitnormal.wav"), 220, seconds=0.01)
    with open(os.path.join(set9, "Per Set - Demo Song (Medium).osu"), "w", encoding="utf-8") as f:
        f.write(
            """osu file format v14

[General]
AudioFilename: audio.mp3
AudioLeadIn: 1
PreviewOffset: 100000
CountCircle: 10

[Metadata]
Title: Demo Song
Artist: Per Set
Source: PerSet
Creator: Set Mapper
Version: Medium
BeatmapID: 700001
BeatmapSetID: 900001
Tags: per set demo

[Difficulty]
HPDrainRate: 5
CircleSize: 4
OverallDifficulty: 5
ApproachRate: 5

[TimingPoints]
500,180,4,0,0,50,1

[Events]

[HitObjects]
100,200,0,1,0,
"""
        )

    # junk that must be ignored by the scanner
    with open(os.path.join(songs, "readme.txt"), "w") as f:
        f.write("not audio\n")

    # symlink escaping the Songs dir: must NOT be indexed or servable
    secret = os.path.join(root, "..", "osuguessr-secret.txt")
    secret = os.path.realpath(secret)
    with open(secret, "w") as f:
        f.write("TOP-SECRET-CONTENT-12345\n")
    os.symlink(secret, os.path.join(songs, "0123456789abcdef0123456789abcdef.mp3"))

    # --- beatmaps ----------------------------------------------------------
    set1 = os.path.join(root, "DJ Nova - Neon Skyline", "Mapper One.mine")
    os.makedirs(set1)
    make_osu(os.path.join(set1, "DJ Nova - Neon Skyline (Normal).osu"),
             a1, "Neon Skyline", "DJ Nova", "Mapper One", "Normal", 111111, 333333,
             source="Synthwave", tags="synthwave neon night")
    make_osu(os.path.join(set1, "DJ Nova - Neon Skyline (Insane).osu"),
             a1, "Neon Skyline", "DJ Nova", "Mapper One", "Insane", 111112, 333333,
             source="Synthwave", tags="synthwave neon night")

    set2 = os.path.join(root, "Mapper Two - Catchy Beat", "Mapper Two.mine")
    os.makedirs(set2)
    make_osu(os.path.join(set2, "Mapper Two - Catchy Beat (Hard).osu.ctb"),
             a2, "Catchy Beat", "Mapper Two", "Mapper Two", "Hard", 222222, 444444,
             source="Party", tags="catch")

    set3 = os.path.join(root, "Mapper Three - Key Chaos", "Mapper Three.mine")
    os.makedirs(set3)
    make_osu(os.path.join(set3, "Mapper Three - Key Chaos (Expert).osu.mania"),
             a3, "Key Chaos", "Mapper Three", "Mapper Three", "Expert", 333333, 555555,
             source="Keyboard", tags="mania fast")

    # 5: fake mp3 has a standard beatmap too (API-level audio only)
    set5 = os.path.join(root, "DJ MP3 - Fake Track", "DJ MP3.mine")
    os.makedirs(set5)
    make_osu(os.path.join(set5, "DJ MP3 - Fake Track (Easy).osu"),
             a5, "Fake Track", "DJ MP3", "DJ MP3", "Easy", 444444, 666666,
             source="Broken", tags="mp3")

    set6 = os.path.join(root, "Alpha - Circles", "Alpha.mine")
    os.makedirs(set6)
    make_osu(os.path.join(set6, "Alpha - Circles (Normal).osu"),
             a6, "Circles", "Alpha", "Alpha", "Normal", 611111, 600001,
             source="Vocals", tags="circles")

    set7 = os.path.join(root, "Beta - Circles", "Beta.mine")
    os.makedirs(set7)
    make_osu(os.path.join(set7, "Beta - Circles (Hard).osu"),
             a7, "Circles", "Beta", "Beta", "Hard", 622222, 600002,
             source="Vocals", tags="circles")

    # 8: original-name fallback (AudioFilename is an MD5 that is NOT in Songs/)
    set8 = os.path.join(root, "Local Artist - Named Track", "Local Mapper.mine")
    os.makedirs(set8)
    make_osu(os.path.join(set8, "Local Artist - Named Track (Normal).osu"),
             "f" * 31 + "e", "Named Track", "Local Artist", "Local Mapper", "Normal",
             555555, 777777, source="Local", tags="local", orig="My Great Song.wav")

    # orphan beatmap -> references audio that does not exist in Songs/
    set4 = os.path.join(root, "Nobody - Ghost Song", "Nobody.mine")
    os.makedirs(set4)
    make_osu(os.path.join(set4, "Nobody - Ghost Song (Easy).osu"),
             "0" * 32, "Ghost Song", "Nobody", "Nobody", "Easy", 999999, 888888)

    print(f"fixture ready at {root}")
    print(f"  a1={a1}")
    print(f"  a2={a2}")
    print(f"  a3={a3}")
    print(f"  a4={a4}")
    print(f"  a5={a5}")


if __name__ == "__main__":
    main()