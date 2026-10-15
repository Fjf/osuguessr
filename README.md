# osu!guessr

A party game for your osu! library: the server picks a random song, you hear a
**0.1 second** clip, and you have to type what it is before it gets easier.
Each time you need more, the clip grows: **0.1s → 0.5s → 2s → 8s → 15s**.
Miss it after the 15s clip and the round is over.

- **No Spotify** — everything comes from your local osu! install,
  **osu!stable** (your `Songs` folder + `.osu` beatmap files) or
  **osu!lazer** (its `client.realm` database + `files/` store, read-only).
- **Pre-indexed**: on first start the app scans your library and builds a
  SQLite index (persisted, so restarts are instant and random selection is
  O(1)).
- **Autocomplete** while guessing is filtered against your whole library
  (title, artist and mapper all count).
- After a round you see the **song, artist, mapper, every difficulty**
  (with links to osu.ppy.sh) plus source/tags and file info.
- Ships as a **docker compose** app to share with friends: `docker compose up`.

## Quick start (Windows + Docker Desktop)

1. Put the folder somewhere, e.g. `G:\Program Files\osu guessr\`.
2. Copy the config and adjust the paths if yours differ:

   ```powershell
   copy .env.example .env
   ```

   Defaults already point at the standard install:

   ```
   OSU_SONGS_DIR=G:\Program Files\osu!\Songs
   OSU_ROOT_DIR=G:\Program Files\osu!
   ```

3. Build and start:

   ```powershell
   docker compose up -d --build
   ```

4. Open <http://localhost:8090> (or `http://YOUR_IP:8090` for friends on your LAN).

The first start indexes your library — with a few thousand songs this takes a
few seconds. You'll see the progress in the UI, then the game starts.

### WSL2 note

If you run Docker via WSL you can use Linux-style paths instead:

```
OSU_SONGS_DIR=/mnt/g/Program Files/osu!/Songs
OSU_ROOT_DIR=/mnt/g/Program Files/osu!
```

## Using osu!lazer

The game can read your library straight from osu!lazer instead of osu!stable.
Point it at your **lazer data folder** — the one containing `client.realm`
and the `files/` directory:

| OS | Default location |
|---|---|
| Windows | `%AppData%\osu` (e.g. `C:\Users\you\AppData\Roaming\osu`) |
| Linux | `~/.local/share/osu` |
| macOS | `~/Library/Application Support/osu` |

lazer can move its data folder (Settings → *Storage*); if you did, use that
location instead. Then:

1. In `.env`:

   ```
   OSU_SOURCE=lazer
   OSU_LAZER_DIR=C:\Users\you\AppData\Roaming\osu
   ```

2. In `docker-compose.yml`, uncomment the lazer volume:

   ```yaml
   - '${OSU_LAZER_DIR:-C:\Users\you\AppData\Roaming\osu}:/data/osu-lazer:ro'
   ```

3. `docker compose up -d --build` — the first start copies `client.realm`
   to a temp location (a few seconds for a large library) and indexes from
   it. Your install is never written to: the realm is opened **read-only**,
   the audio is streamed straight from the read-only `files/` mount, and sets
   marked for deletion in lazer are skipped.

In lazer mode `OSU_SONGS_DIR`/`OSU_ROOT_DIR` are ignored; the audio comes
from `<OSU_LAZER_DIR>/files`. Song metadata (title, artist, mapper, every
difficulty) comes from the realm; title/artist can be guessed in either the
romanised or the unicode spelling.

> **Note on the Realm package.** The `realm` npm package (which MongoDB
> deprecated in 2024) is used here in read-only mode to open `client.realm`.
> It is pinned and only loaded when `OSU_SOURCE=lazer`. If a future osu!lazer
> ships a realm file format newer than what this package supports, the index
> build will fail with "Unsupported Realm file format version" — see
> Troubleshooting.

## How the game works

| Press of play | clip length | points if you guess next |
|---|---|---|
| 1 | 0.1 s | 100 |
| 2 | 0.5 s | 80 |
| 3 | 2 s | 60 |
| 4 | 8 s | 40 |
| 5+ | 15 s | 20 |

- Type while the clip plays — suggestions come from your whole library.
- Wrong guess after the 15s clip (or **Give up**) = fail.
- Streak bonus: +5 per previous correct round. Best score is stored per browser.

## Configuration

Everything is set via `.env` next to `docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `OSU_SOURCE` | `stable` | `stable` (osu!stable) or `lazer` (osu!lazer) |
| `OSU_SONGS_DIR` | `G:\Program Files\osu!\Songs` | Folder with the audio files (stable) |
| `OSU_ROOT_DIR` | `G:\Program Files\osu!` | osu! root, scanned for `.osu` beatmaps (stable) |
| `OSU_LAZER_DIR` | – | lazer data folder with `client.realm` + `files/` (lazer) |
| `PORT` | `8090` | Host port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` to keep it local-only) |

Inside the container (already wired up by compose):

| Env | Value | Meaning |
|---|---|---|
| `SONGS_DIR` | `/data/songs` | mounted songs folder |
| `BEATMAPS_DIR` | `/data/osu` | mounted osu! root |
| `DB_PATH` | `/data/app/osuguessr.db` | persisted index |
| `REINDEX` | – | set to `1` to force a full rebuild at startup |
| `USE_AUDIO_TAGS` | `1` | read embedded ID3 tags for songs without beatmaps (`0` to disable) |
| `OSU_DIR` | `/data/osu-lazer` | mounted lazer data folder (lazer mode only) |

## Reindexing

The index is rebuilt automatically the first time it's empty. After that:

- click **↻ Reindex** in the top bar (rescans everything, ~seconds for a large library), or
- start the container with `REINDEX=1`.

Add/remove songs → reindex. The game refuses to hand out songs while an index
build is running.

## How metadata is found

**osu!stable:**

1. Every `.osu` beatmap is parsed (`Title`, `Artist`, `Source`, `Creator`,
   `Version`, `Tags`, online IDs). The `AudioFilename` (MD5) links it to the
   matching file in `Songs/`.
2. A song is the union of all sets that use the same audio file, so the result
   card lists **all difficulties from all modes** (`.osu`, `.osu.taiko`,
   `.osu.ctb`, `.osu.mania`).
3. Songs without any beatmap fall back to embedded audio tags (mp3/ogg/flac/m4a),
   then to the file name.

**osu!lazer:** the `client.realm` database already links every difficulty to
its audio: each beatmap stores its metadata (title, artist, unicode variants,
mapper, source, tags, preview time) and references the audio by file name; the
set's file list maps that name to a content hash, and the hash to the stored
file under `files/`. A song is again the union of all difficulties sharing the
same audio hash. Stored files have no extension, so the audio format is
detected from the file's magic bytes.

## Troubleshooting

- **"No songs found"** — the mount didn't take. `docker compose logs` shows the
  resolved `Songs dir`; `docker compose exec osuguessr ls /data/songs | head`
  should list audio files. Check the path in `.env` (spaces and `!` are fine,
  keep the backslashes).
- **Songs play but have no artist/title/difficulties** — you pointed
  `OSU_ROOT_DIR` at the `Songs` folder instead of the osu! root, or you deleted
  your beatmaps. Set it to the folder that contains your beatmap folders.
- **A clip doesn't play** — some formats (e.g. `.opus`, `.wma`) can't be decoded
  by every browser; the server still serves them and other songs work fine.
- **Lazer: index build fails with "Unsupported Realm file format version"** —
  your osu!lazer is newer than the bundled Realm reader supports (lazer bumped
  its file format). Update osuguessr (the `realm` package is pinned per
  release); as a stopgap, export your sets as `.osz` and use an osu!stable
  layout, or fall back to `OSU_SOURCE=stable` if you also run stable.
- **Lazer: "client.realm not found"** — you moved lazer's storage location
  (Settings → *Storage*). Point `OSU_LAZER_DIR` at the folder that now
  contains `client.realm`.
- **Lazer: some songs missing after index** — the index log lists sets that
  were skipped (marked for deletion, missing audio file on disk, unknown
  mode). Sets you deleted inside lazer are skipped on purpose.
- **Friends can't connect** — make sure `HOST=0.0.0.0`, your firewall allows
  the port, and you're on the same network. Use the machine's LAN IP, not
  `localhost`.

## Run without Docker

```bash
npm install
SONGS_DIR="/path/to/Songs" BEATMAPS_DIR="/path/to/osu!" PORT=8090 npm start
```

## Project layout

```
server.js          Express app: game API + audio streaming
lib/osu.js         .osu beatmap parser (stable)
lib/lazer.js       osu!lazer reader: client.realm + files/ store
lib/db.js          SQLite schema + queries (random, suggest, exact match)
lib/index.js       library scanner / index builder (both sources)
public/            static game UI (vanilla JS, no build step)
data/              created at runtime: persisted SQLite index
```