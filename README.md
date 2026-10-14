# osu!guessr

A party game for your osu! library: the server picks a random song, you hear a
**0.1 second** clip, and you have to type what it is before it gets easier.
Each time you need more, the clip grows: **0.1s → 0.5s → 2s → 8s → 15s**.
Miss it after the 15s clip and the round is over.

- **No Spotify** — everything comes from your local osu! install.
- **Pre-indexed**: on first start the app scans your `Songs` folder plus your
  beatmap files and builds a SQLite index (persisted, so restarts are instant
  and random selection is O(1)).
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
| `OSU_SONGS_DIR` | `G:\Program Files\osu!\Songs` | Folder with the audio files |
| `OSU_ROOT_DIR` | `G:\Program Files\osu!` | osu! root, scanned for `.osu` beatmaps |
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

## Reindexing

The index is rebuilt automatically the first time it's empty. After that:

- click **↻ Reindex** in the top bar (rescans everything, ~seconds for a large library), or
- start the container with `REINDEX=1`.

Add/remove songs → reindex. The game refuses to hand out songs while an index
build is running.

## How metadata is found

1. Every `.osu` beatmap is parsed (`Title`, `Artist`, `Source`, `Creator`,
   `Version`, `Tags`, online IDs). The `AudioFilename` (MD5) links it to the
   matching file in `Songs/`.
2. A song is the union of all sets that use the same audio file, so the result
   card lists **all difficulties from all modes** (`.osu`, `.osu.taiko`,
   `.osu.ctb`, `.osu.mania`).
3. Songs without any beatmap fall back to embedded audio tags (mp3/ogg/flac/m4a),
   then to the file name.

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
lib/osu.js         .osu beatmap parser
lib/db.js          SQLite schema + queries (random, suggest, exact match)
lib/index.js       library scanner / index builder
public/            static game UI (vanilla JS, no build step)
data/              created at runtime: persisted SQLite index
```