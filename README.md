# Stremio WebTorrent Scraper Addon

A Stremio addon that scrapes public torrent indexes for a movie or episode and streams the
result over HTTP through a built-in [WebTorrent](https://github.com/webtorrent/webtorrent) client.

## How it works

1. Stremio asks for streams for an IMDb id (`tt0133093`, or `tt0903747:1:1` for episodes).
2. The addon looks up the title and year on Cinemeta.
3. The addon queries all enabled scrapers in parallel. A blocked or broken site drops only its own results.
4. Results are filtered by title, year, and episode, deduplicated by info hash, and sorted by
   peer count (seeders + leechers), highest first.
5. Each result becomes a stream URL: `http://<server>/<token>/play/<infoHash>/auto?s=1&e=1`.
6. When Stremio opens that URL, WebTorrent fetches the torrent metadata and picks the right file.
   For a season pack, it picks the matching episode. For a movie, it picks the largest video.
   WebTorrent then downloads pieces on demand for the requested byte range, so seeking works.
7. When no connection reads from a torrent for `TORRENT_IDLE_MS`, the addon destroys the torrent
   and deletes its data.

## Scrapers

| Key     | Site              | Content          | Method                    |
|---------|-------------------|------------------|---------------------------|
| `yts`   | YTS / YIFY        | Movies           | JSON API (by IMDb id)     |
| `tpb`   | The Pirate Bay    | Movies, TV       | apibay JSON API           |
| `eztv`  | EZTV              | TV               | JSON API (by IMDb id)     |
| `nyaa`  | Nyaa              | Anime            | RSS feed                  |
| `1337x` | 1337x             | Movies, TV       | HTML scraping (Cloudflare may block it) |

Each scraper has a list of mirror domains in its file under `src/scrapers/`. Torrent sites
change domains often, so update the mirror lists when a site moves. To add a site, create a
module that exports `{ name, types, search(query) }` and register it in `src/scrapers/index.js`.

## Run

```sh
npm install
npm start
npm stop    # stops the server and deletes downloaded torrent data
```

See [TUI dashboard](#tui-dashboard) for running in the background.

Then paste `http://127.0.0.1:7000/manifest.json` into the Stremio addon search bar.

### One-click install (HTTPS)

Stremio opens `stremio://` links over HTTPS. Over plain HTTP, the link fails with a TLS error.
To use one-click install, create a locally trusted certificate with
[mkcert](https://github.com/FiloSottile/mkcert):

```sh
brew install mkcert
mkcert -install    # adds a local CA to the system trust store (asks for your password)
npm run certs      # writes certs/cert.pem and certs/key.pem
npm start
```

When `certs/` exists, the server also listens for HTTPS on port 7443. The manifest and install
links use HTTPS. Stream links stay on plain HTTP, because Stremio's player may not trust the
local certificate.
Then install the addon in one of these ways:

- Open `https://127.0.0.1:7443/` in a browser and click **Install in Stremio**.
- Open `stremio://127.0.0.1:7443/manifest.json` directly. `GET /install` redirects to this URL.

## TUI dashboard

```sh
npm start                # server in the foreground (plain log output)
npm start background     # server in the background, log in state/server.log
npm start dashboard      # dashboard for the running server; starts one in the background if none runs
npm stop                 # stop the server, wherever it was started
```

`npm run background` and `npm run dashboard` do the same. The dashboard is a separate program
that connects to the server over a local admin socket (`state/admin.sock`, readable by the owner
only, never on the network). Close it and reopen it as often as you like; the server keeps
running.

The dashboard shows:

- Torrents: speed, peers, disk use, state, and for every connection the read position and how
  much is downloaded ahead.

Both dashboards also show a **Watching** line per torrent for watching together: each user's
estimated timestamp and how far behind the leader they are, e.g.
`bob ≈ 41:40 / 2:16:00 ahead   alice ≈ 1:17 / 2:16:00 40:23 behind`. The estimate is the read
position scaled by the runtime from Cinemeta. It assumes a constant bitrate and runs ahead of the
real playback by what the player has buffered, so treat it as accurate to about a minute. Short
connections that read less than 8 MB (players probing a file) are left out. A plan for real
synchronized playback in the browser is in [docs/watch-together-plan.md](docs/watch-together-plan.md).

Both dashboards count *connections*, not viewers. A player often opens two or three connections
to a file at the start (for example to read the index at the end of an MKV or MP4), and closes
the extra ones after a few seconds. `/status` reports the count as `connections`.
- Users with their install links. Tokens are hidden until you press **t**.
- Limits, and the server log.

Keys:

| Key | Action |
|-----|--------|
| `a` | Add a user. The dashboard generates a token and shows the install link. |
| `d` | Delete a user added in the dashboard. Their install links stop working at once. |
| `t` | Show or hide tokens. |
| `1`-`6` | Change a limit: torrents total, torrents per user, disk total (GB), disk per stream (MB), readahead (MB), idle timeout (minutes). |
| `x` | Remove a torrent, even while people watch it. |
| `b`, `q`, Ctrl+C | Close the dashboard. The server keeps running in the background. |
| `s` | Stop the server (asks first). Streams end and torrent data is deleted. |

Changes apply immediately and are saved to `STATE_FILE` (default `state/state.json`, readable by
the owner only because it holds tokens). On the next start, saved limits override the
environment, and saved users are loaded next to the ones in `ACCESS_TOKENS`. Users from
`ACCESS_TOKENS` cannot be deleted in the dashboard; remove them from the environment instead.

With at least one user, every route needs a token. Deleting the last user makes the addon open
again. Both take effect without a restart.

In Docker, open the dashboard inside the running container:

```sh
docker compose exec addon node src/index.js dashboard
```

## Access tokens (multiple users)

Without `ACCESS_TOKENS`, anyone who can reach the server can use it. Set one token per user
before exposing the server to other devices or the internet:

```sh
npm run token        # prints a random token
ACCESS_TOKENS="alice:<token1>,bob:<token2>" npm start
```

Each user then gets a personal base URL, `<PUBLIC_URL>/<token>/`. The startup log prints one
per user. Every route below lives under that prefix, and stream links include the token, so a
link works only for its user. Requests with a missing or wrong token get `404`. The server
refuses to start with tokens shorter than 16 characters.

## Limits

Limits are hard: when one is reached, the server refuses to add a torrent.

- `MAX_TORRENTS_PER_USER` (default 2): torrents one user can stream at the same time. Above the
  limit, `/play` answers `429`. Joining a torrent the user already streams always works.
- `MAX_ACTIVE_TORRENTS` (default 5): torrents on the whole server. When it is full, the server
  first removes idle torrents. If none are idle, `/play` answers `503 Server busy`.
- `MAX_DISK_GB` (default unlimited): disk budget for all torrent data. See [Disk cache](#disk-cache).
- `MAX_DISK_PER_STREAM_MB` (default unlimited, minimum 128): disk budget for one torrent, shared
  by everyone watching it.
- Several users can watch the same torrent. It counts once toward the server limit.

## Prefetch

Opening a torrent means fetching its metadata from peers, and players then read the file's
header and often its index at the end before playing. On a network with few peers each step can
take 10 to 60 seconds, and the player gives up with "operation timed out".

So when Stremio loads a stream list, the server starts the top `PREFETCH_COUNT` (default 2)
results in the background: it fetches their metadata, then downloads the first
`PREFETCH_HEAD_MB` (8) and last `PREFETCH_TAIL_MB` (4) of the file that would play. Clicking a
prefetched result starts at once; in a test, the first byte took 0.001 s instead of 19.6 s.

- Prefetched torrents do not take a torrent slot (`MAX_ACTIVE_TORRENTS`) and are the first
  thing removed when disk space is needed.
- Unused ones are removed after `PREFETCH_TTL_MS` (2 minutes). At most `PREFETCH_MAX` (6) are
  kept.
- Both dashboards mark them as *prefetched*.
- Not done in `native` mode, where Stremio loads torrents itself. `PREFETCH_COUNT=0` turns it off.

## Disk cache

- Torrent data lives in `DOWNLOAD_PATH`, one folder per info hash, one file per piece.
- A stream downloads only `READAHEAD_MB` (default 256) ahead of the playback position, not the
  rest of the file.
- There are two limits. Set either or both:
  - `MAX_DISK_GB`: all torrent data together.
  - `MAX_DISK_PER_STREAM_MB`: one torrent's data. Two people watching the same torrent share it.
- With a limit set, the cache rolls: it stops growing at the limit, and streams keep playing.
  Every second the server checks the sizes:
  1. A torrent over `MAX_DISK_PER_STREAM_MB` deletes its own pieces that are far from the
     playback position.
  2. When the total is over `MAX_DISK_GB`, the server removes idle torrents, least recently used
     first, then deletes far-away pieces of active streams.
  Already watched pieces are deleted first, then pieces left over from seeking.
- Each viewer keeps a window on disk: 32 MB behind the playback position plus the readahead.
  The server shrinks the readahead automatically so all windows fit in 80% of each limit.
  Example: `MAX_DISK_PER_STREAM_MB=150` gives a readahead of 72 MB.
- Seeking back to deleted pieces works. The server downloads them again, so it takes a moment.
- The cache can go over the limit for about a second, by the amount downloaded in that time.
- When the limit is too small for one more viewer's minimum window (64 MB), new torrents get
  `507 Disk cache full`.
- A torrent and its folder are deleted 2 minutes (`TORRENT_IDLE_MS`) after its last connection
  closes, on **Remove**, on eviction, and on a normal shutdown.
- At startup, the server deletes data left behind by a crash. It only does this in a folder that
  contains its `.stremio-webtorrent` marker file, or in an empty folder, so a wrong
  `DOWNLOAD_PATH` never deletes unrelated files.

## Settings (Configure button)

The addon supports Stremio's **Configure** button (`/<token>/configure`). The page sets:

- **Server URL for stream links**: the address this device uses to reach the server, for example
  `http://192.168.1.20:7000`. Useful when the server is known under another address on a TV or phone.
- **Torrent sites**: which scrapers run.
- **Stream mode**: `webtorrent`, `native`, or `both`.

The page builds a new manifest URL that holds the settings,
`<PUBLIC_URL>/<token>/c/<settings>/manifest.json`, and installs it. To change settings, click
**Configure** again and reinstall.

## Endpoints

All of these are under `/<token>` when access tokens are set.

- `GET /`: install page with a `stremio://` button.
- `GET /install`: redirect to the `stremio://` install link.
- `GET /configure`: settings page.
- `GET /dashboard`: live stats page. Open it in a browser next to Stremio. For each torrent it shows
  download and upload speed with a 90-second graph, connected seeders and leechers, progress,
  the file being played, which users are watching, how much each viewer has downloaded ahead of
  the playback position, and the seeders and leechers reported at scrape
  time. It refreshes every 1.5 seconds. **Remove** stops a torrent and deletes its data, unless
  another user is streaming it.
- `GET /status`: the same stats as JSON.
- `DELETE /api/torrents/:infoHash`: stop a torrent and delete its data. `409` if another user streams it.
- `GET /play/:infoHash/:fileIdx`: raw HTTP stream with Range support. `fileIdx` is a number or `auto`.
- `GET /health`: always public, for health checks.

## Docker (Linux server)

```sh
cp .env.example .env
docker compose run --rm addon node scripts/token.js   # once per user, paste into ACCESS_TOKENS
# edit .env: PUBLIC_URL, ACCESS_TOKENS, limits
docker compose up -d --build
docker compose logs addon                             # prints each user's install page
```

Open ports 7000/tcp (addon) and 6881/tcp+udp (BitTorrent peers and DHT) in the server firewall.
Torrent data lives in the `torrent-data` volume and is deleted when a torrent goes idle.

### HTTPS with a domain

One-click `stremio://` install and Stremio Web need HTTPS. The compose file includes an optional
[Caddy](https://caddyserver.com) proxy that gets a Let's Encrypt certificate automatically:

1. Point a DNS record for your domain at the server and open ports 80 and 443.
2. In `.env`, set `DOMAIN=addon.example.com` and `PUBLIC_URL=https://addon.example.com`.
3. Run `docker compose --profile https up -d --build`.

With Caddy in front, you can close port 7000 to the outside.

## Configuration

| Variable              | Default                          | Description |
|-----------------------|----------------------------------|-------------|
| `PORT`                | `7000`                           | HTTP port. |
| `HTTPS_PORT`          | `7443`                           | HTTPS port. Used only when a certificate exists. |
| `TLS_CERT`, `TLS_KEY` | `certs/cert.pem`, `certs/key.pem`| Certificate and key for HTTPS. |
| `PUBLIC_URL`          | `https://127.0.0.1:$HTTPS_PORT` with a certificate, else `http://127.0.0.1:$PORT` | Base URL in stream and install links. Set this when Stremio runs on another device (TV, phone). |
| `STREAM_URL`          | `PUBLIC_URL` if set, else `http://127.0.0.1:$PORT` | Base URL of `/play` stream links. |
| `STREAM_MODE`         | `webtorrent`                     | `webtorrent`: stream through this server. `native`: return info hashes for Stremio's own engine. `both`: return both. |
| `SCRAPERS`            | `yts,tpb,eztv,nyaa,1337x`        | Enabled scrapers, comma-separated. |
| `DOWNLOAD_PATH`       | `$TMPDIR/stremio-webtorrent`     | Temporary torrent data. |
| `TORRENT_IDLE_MS`     | `120000` (2 minutes)             | Delay before an unused torrent is destroyed. |
| `ACCESS_TOKENS`       | (empty)                          | Users and tokens, `name:token,name:token`. Empty (and no users in the state file) means open access. |
| `STATE_FILE`          | `state/state.json`               | Users and limits saved by the TUI dashboard. The admin socket and background log live in the same folder. |
| `ADMIN_SOCKET`        | `state/admin.sock`               | Unix socket the dashboard uses to talk to the server. |
| `MAX_ACTIVE_TORRENTS` | `5`                              | Hard limit of torrents on the server. Idle torrents are evicted first. |
| `MAX_TORRENTS_PER_USER` | `2`                            | Hard limit of torrents one user streams at the same time. |
| `MAX_DISK_GB`         | unlimited                        | Disk budget for all torrent data. |
| `MAX_DISK_PER_STREAM_MB` | unlimited (minimum 128)       | Disk budget for one torrent's data. |
| `READAHEAD_MB`        | `256`                            | How far ahead of the playback position a stream downloads. |
| `TORRENT_PORT`        | random (`6881` in Docker)        | Port for incoming BitTorrent peers and DHT. |
| `MAX_CONNS`           | `55`                             | Maximum peer connections per torrent. |
| `MAX_RESULTS`         | `30`                             | Maximum torrents returned per request. |
| `SCRAPER_TIMEOUT_MS`  | `10000`                          | Timeout for each scraper. |
| `CACHE_TTL_MS`        | `1800000`                        | Cache duration for scrape results. |
| `PREFETCH_COUNT`      | `2`                              | Top results to load in the background when a stream list loads. `0` turns it off. |
| `PREFETCH_HEAD_MB`, `PREFETCH_TAIL_MB` | `8`, `4`        | Start and end of the file downloaded for prefetched torrents. |
| `PREFETCH_TTL_MS`     | `120000`                         | Unused prefetched torrents are removed after this delay. |
| `PREFETCH_MAX`        | `6`                              | Most prefetched torrents kept at once. |
| `EXTRA_TRACKERS`      | (empty)                          | Extra announce URLs, comma-separated. |

## Notes

- Many corporate and mobile networks block outbound UDP. With UDP blocked, DHT and UDP trackers
  do not work. The default tracker list starts with HTTP trackers, so peer discovery still works.
- In `native` mode, season packs are omitted. Without a `fileIdx`, Stremio's engine plays the
  largest file, which is often the wrong episode.
- `notWebReady` is set on HTTP streams, so Stremio Web transcodes MKV/HEVC through its streaming
  server. Desktop and Android apps play the streams directly.

## Legal

This software only indexes public torrent metadata and streams peer-to-peer data. You are
responsible for complying with copyright law where you live. Use it only for content you have
the right to access.
