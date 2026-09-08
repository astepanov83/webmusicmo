# Stations: many radio stations in one player

Date: 2026-09-08

## Goal

webmusicmo plays one station, METAL ONLY, wired in through a PLS URL. Make a
station a first-class thing: a JSON description with name, playlists, logo and a
now-playing source. Load the 46 SomaFM channels from their official
`channels.json`, keep Metal Only as a hand-written entry, and let the user pick a
station in the player. Keep the player look and behaviour as they are.

The list lives in `public/stations.json` on the server, written by a refresh
script, the same pattern as `episodes.json` in webmusicfp. The app is deployed
as a Docker image on the NAS and served at `mo.gitpal.ru`.

## Decisions made

- Source for SomaFM: `https://somafm.com/channels.json`. No HTML scraping. The
  JSON already lists the 256 and 320 kbps mp3 playlists where a station has
  them.
- Picker: a station list panel, not a select.
- Recently played: per station, seeded from SomaFM's songs API when the browser
  has nothing yet.
- Refresh on the NAS: a loop in the container, as in webmusicfp. The image also
  ships a `stations.json` built at image build time.
- Metal Only is an entry in the same file. `PLS_URL` goes away.
- The server resolves streams and now-playing per station id, lazily, cached.
  The browser only knows station ids.

## Station model

`public/stations.json`:

```json
{
  "fetchedAt": 1788900000000,
  "stations": [ ... ]
}
```

One station:

```json
{
  "id": "groovesalad",
  "name": "Groove Salad",
  "description": "A nicely chilled plate of ambient/downtempo beats and grooves.",
  "genre": "ambient|electronic",
  "dj": "Rusty Hodge",
  "site": "https://somafm.com/groovesalad/",
  "logo": "https://api.somafm.com/logos/256/groovesalad256.png",
  "source": "somafm",
  "playlists": [
    { "url": "https://api.somafm.com/groovesalad256.pls", "format": "mp3",  "quality": "highest" },
    { "url": "https://api.somafm.com/groovesalad130.pls", "format": "aac",  "quality": "highest" },
    { "url": "https://api.somafm.com/groovesalad64.pls",  "format": "aacp", "quality": "high" },
    { "url": "https://api.somafm.com/groovesalad32.pls",  "format": "aacp", "quality": "low" }
  ],
  "nowPlaying": { "kind": "somafm", "url": "https://somafm.com/songs/groovesalad.json" }
}
```

Fields:

- `id`: unique, url-safe. SomaFM ids are used as they are. Local ids are chosen
  by hand.
- `name`, `description`, `genre`, `dj`: display text. `genre` keeps SomaFM's
  `a|b` form; the UI shows it with the bar replaced by a middle dot.
- `site`: the station's home page, shown in the footer.
- `logo`: absolute URL or a path on this server. Empty string when there is
  none.
- `source`: `"local"` or `"somafm"`. Only used for display and for the refresh
  script to know which entries it owns.
- `playlists`: PLS files, best first. `format` is `mp3`, `aac` or `aacp`.
  `quality` is `highest`, `high` or `low`. Bitrates are not stored. The server
  learns them by probing the stream, as it does today.
- `nowPlaying.kind`: `"icecast"` reads `status-json.xsl` on the resolved stream
  host. `"somafm"` reads `nowPlaying.url`.

Metal Only, hand-written in `stations/local.json` (a `stations` array, same
shape):

```json
{
  "id": "metal-only",
  "name": "Metal Only",
  "description": "Metal, 24/7, with live shows. metal-only.de",
  "genre": "metal",
  "dj": "",
  "site": "https://www.metal-only.de",
  "logo": "/icon-256.png",
  "source": "local",
  "playlists": [
    { "url": "https://metal-only.streampanel.cloud/listen.pls", "format": "mp3", "quality": "highest" }
  ],
  "nowPlaying": { "kind": "icecast" }
}
```

Local entries come first in the output file, so Metal Only stays the default.

## Refresh script

`scripts/refresh.js`:

1. Reads `stations/local.json`.
2. Fetches `SOMAFM_URL` (default `https://somafm.com/channels.json`).
3. Maps it with `parseChannels` from `lib/somafm.js`.
4. Writes `STATIONS_FILE` (default `public/stations.json`) with local entries
   first, then SomaFM entries in the order the site gives.

If the fetch or the parse fails and a previous file exists, the script keeps
the old file, prints the error and exits with code 1. If there is no previous
file it writes local entries only and exits with code 1. The server keeps
running on the old file either way.

`parseChannels(json)` is pure. It takes the channels.json object and returns
the stations array. It maps:

| channels.json      | station          |
| ------------------ | ---------------- |
| `id`               | `id`             |
| `title`            | `name`           |
| `description`      | `description`    |
| `genre`            | `genre`          |
| `dj`               | `dj`             |
| `largeimage`       | `logo` (query string stripped) |
| `https://somafm.com/<id>/` | `site`   |
| `playlists[]`      | `playlists[]` with `url`, `format`, `quality` |
| `https://somafm.com/songs/<id>.json` | `nowPlaying.url`, kind `somafm` |

Channels with no playlists are skipped.

## Server

`createApp({ stationsFile, fetchImpl, cacheMs, preferHttps })` replaces
`createApp({ plsUrl })`. The file is read at start and re-read when its mtime
changes, checked at most once a minute, so the refresh loop takes effect
without a restart.

Endpoints:

- `GET /api/stations`: `{ fetchedAt, stations: [{ id, name, description, genre,
  dj, site, logo, source }] }`. No playlists.
- `GET /api/streams?station=<id>`: the same body as today:
  `{ station, description, stationUrl, plsUrl, streams, fallbacks }`.
  `station` is the station name. `plsUrl` is the first playlist. `streams` is
  built by reading every playlist, HEAD-probing the first entry of each for
  `icy-br` and content type, and dropping any stream with the same bitrate and
  codec as one already listed. The first playlist's stream is `primary`. For
  `icecast` stations the status JSON mounts are merged in as today.
  `fallbacks` are the other entries of the primary playlist.
- `GET /api/now?station=<id>`: `{ artist, song, album, dj, show, raw,
  listeners, history, fetchedAt }`. `history` is a list of
  `{ artist, song, album, at }` newest first. The Icecast reader returns an
  empty list. The SomaFM reader returns what the songs file has, newest first,
  and its first entry is the current track.
- `GET /api/health`: unchanged.

A missing `station` parameter means the first station in the file. An unknown
id answers 404 `{ error: "unknown station" }`.

Caches stay in one `Map`, keyed by `<id>:pls`, `<id>:primary`, `<id>:status`,
with the same lifetimes as today.

New file `lib/somafm.js` holds `parseChannels` and `parseSongs`. `parseSongs`
turns the songs file into `{ now, listeners: null, history }` where `now` has
the same fields as `parseTitle` returns plus `album`. `lib/nowplaying.js` keeps
the Icecast reader. `lib/stations.js` loads and validates the file and picks a
station by id.

## Player UI

Desktop: three columns. Stations on the left, the player in the middle
unchanged, recently played on the right.

Station row: logo (a coloured initial when there is none), name, genre in small
text, description as the tooltip. The current station is highlighted. A filter
box at the top matches name, genre and description, case-insensitive. Metal
Only is first, then SomaFM in file order.

Phone: one column as today. The list is not on the page. Tapping the station
name in the header opens the list as a full-height overlay with the same rows
and filter. Picking a station closes it. Order stays player, then history.

Switching station:

1. Save `station` in localStorage. Set `?station=<id>` in the URL with
   `history.replaceState`, so a bookmark or a shared link opens that station.
   On load, `?station=` wins over localStorage, which wins over the first
   station.
2. Fetch `/api/streams?station=`, rebuild the Quality select. The chosen
   quality is remembered per station under `mount:<id>`.
3. Swap the history to that station's list, kept under `history:<id>`. When the
   list is empty and `/api/now` returns `history`, use it as the seed.
4. If audio was playing, call `play()` on the new stream. Otherwise stay
   stopped.

The header name, page title, media session `album`, the footer site link, the
PLS link and Copy stream URL all follow the station. For stations with a logo
URL the media session artwork is the logo. `manifest.webmanifest` name becomes
"webmusicmo".

Keys: `[` and `]` step to the previous and next station in the list. `/`
focuses the filter box. Existing keys unchanged.

## Deploy

- `docker-entrypoint.sh` as in webmusicfp: refresh every `REFRESH_HOURS`
  (default 24, `0` turns it off) in the background, then `node server.js`.
- Dockerfile copies `scripts/` and `stations/`, runs `node scripts/refresh.js`
  at build so the image ships a full file, and uses the entrypoint.
- `docker_build.sh` unchanged. Bump `package.json` version to 2.0.0.
- systemd: `webmusicmo.service` drops `PLS_URL`. Add
  `webmusicmo-refresh.service` and `webmusicmo-refresh.timer` as in webmusicfp.
  `install-service.sh` installs both and runs the refresh once first.
- Environment: `PORT`, `HOST`, `STATIONS_FILE`, `SOMAFM_URL`. `PLS_URL` is
  removed.
- README updated: what a station is, how to add a local one, the refresh
  script, the new endpoints and keys.

## Errors

- No stations file at start: the server logs it and `/api/stations` answers
  503 `{ error }`. The page shows "No station list" in the song line.
- A station whose playlists all fail: `/api/streams` answers 502. The page
  shows a toast "Station unreachable" and stays on the previous station.
- Now-playing failures are silent, as today.
- The refresh script never removes a working file.

## Testing

`node --test`, no network:

- `test/somafm.test.js`: `parseChannels` on a saved copy of channels.json
  (`test/fixture-channels.json`, trimmed to three channels) and `parseSongs` on
  a saved songs file. Skipped channels, logo query string, playlist order.
- `test/stations.test.js`: load, validate, pick by id, reload on mtime change.
- `test/app.test.js`: fake fetch with two stations (one icecast, one somafm).
  `/api/stations` shape, `?station=` routing, default station, 404 on unknown
  id, per-station caches, `history` in `/api/now`, 502 when every playlist
  fails.
- `test/refresh.test.js`: writes the merged file with local entries first,
  keeps the old file when the fetch fails, exit codes.

The front-end has no automated tests. Check by hand in the browser: switch
stations while playing, quality remembered per station, phone overlay, keys.

## Out of scope

- Favourites, station search across sources other than SomaFM.
- Album art in the now-playing pane.
- Any change to the visualizer, volume, sleep timer or theme code.
