# webtorrentio

A [Stremio](https://www.stremio.com) addon that searches public torrent indexes for a movie or
episode and streams the result over HTTP through a built-in
[WebTorrent](https://github.com/webtorrent/webtorrent) client.

> **Read [Legal and safety](#legal-and-safety) before using this.** This project hosts no media
> and links to none. It is a tool: what you search for and stream, and whether that is legal
> where you live, is your responsibility. BitTorrent shares data with other peers and shows
> them your IP address.

## Features

- Stream results from torrent indexes you enable (none are enabled by default), sorted by peer count, with seeders, leechers,
  size and a health rating in Stremio's stream list.
- HTTP streaming with seeking; only the part being watched plus a readahead window is downloaded.
- Disk limits for the whole cache and per stream; the cache rolls instead of growing.
- Several users with personal access tokens, and hard limits per user and per server.
- Web dashboard and a terminal (TUI) dashboard: speeds, peers, disk use, buffer ahead, users,
  limits, and an estimated timestamp per viewer for watching together.
- Background server mode; the TUI can attach to and detach from a running server.
- Fast starts: the top results are prefetched, and for all others the player waits (with
  redirects) until data is there instead of timing out.
- Binge-watching: near the end of an episode, the next one is prepared so it starts at once.
- Re-opening something watched before starts at once: headers and indexes are kept (up to 500 MB).
- Optional stereo audio conversion (ffmpeg): 5.1/7.1 audio mixed down without clipping, for
  players whose own downmix pops and crackles.
- Docker and docker-compose setup with optional automatic HTTPS (Caddy).
- Kubernetes manifests (Kustomize) with a Traefik ingress and Let's Encrypt.

## Requirements

- Node.js 22 or newer (WebTorrent 3 needs it), and npm.
- macOS or Linux. The dashboard's admin connection uses a Unix socket, and `npm stop` uses
  `lsof`. Windows is untested.
- Outbound UDP helps a lot (DHT and UDP trackers). See [Troubleshooting](#troubleshooting).
- Optional: Docker with Compose, or a Kubernetes cluster, for server installs, [mkcert](https://github.com/FiloSottile/mkcert)
  for local HTTPS.

## Quick start

```sh
git clone https://github.com/Slendog/webtorrentio.git
cd webtorrentio
npm install
npm start
```

In Stremio, open the addon search bar, paste `http://127.0.0.1:7000/manifest.json` and install.
Stop the server with Ctrl+C or `npm stop`.

**No indexes are searched by default.** Until you enable some, Stremio shows a single
"No torrent indexes enabled" entry that opens the Configure page. Enable indexes in one of two
ways:

- For the whole server: `SCRAPERS=yts,eztv npm start` (or `SCRAPERS=all`). See [Indexes](#indexes).
- Per install: Stremio's **Configure** button, then tick the indexes and install again.

## Running the server

```sh
npm start                # foreground, log in the terminal
npm start background     # background, log in state/server.log
npm start dashboard      # TUI for the running server; starts one in the background if needed
npm stop                 # stop the server, however it was started
```

`npm run background` and `npm run dashboard` do the same as the `npm start` variants.
Stopping always removes the downloaded torrent data. The log records why a server stopped
(`npm stop`, dashboard, `SIGINT`, `SIGTERM`).

## Installing in Stremio

### Same computer

Paste `http://127.0.0.1:7000/manifest.json` into the Stremio addon search bar. With access
tokens enabled, use your personal link instead (see [Users and access tokens](#users-and-access-tokens)).

### One-click install (`stremio://` links)

Stremio opens `stremio://` links over HTTPS, so over plain HTTP the link fails with a TLS
error. For one-click install on your own computer, create a locally trusted certificate:

```sh
brew install mkcert      # or your package manager
mkcert -install          # adds a local certificate authority (asks for your password)
npm run certs            # writes certs/cert.pem and certs/key.pem
npm start
```

`HTTPS` switches the built-in HTTPS: `auto` (default) uses HTTPS when a working certificate
exists, `on` requires one and refuses to start without it, `off` never uses HTTPS (for example
behind a proxy that does HTTPS). A broken certificate in `auto` mode is logged and the server
runs on HTTP only. The startup log shows the result, e.g. `HTTPS (HTTPS=auto): on, port 7443`.

With a working certificate, the server also listens on HTTPS port 7443. Open
`https://127.0.0.1:7443/` and click **Install in Stremio**. Stream links stay on plain HTTP,
because Stremio's player may not trust the local certificate.

The server watches the certificate and key files (`TLS_CERT`, `TLS_KEY`) and switches to a
replaced certificate within about 12 seconds, without a restart; `kill -HUP <pid>` reloads at
once. A pair that does not load (half written, key and certificate not matching) is ignored and
the old certificate stays in use, logged as `[tls] new certificate files do not load`.

With your own certificate manager (for example certbot) instead of Caddy, mount its output into
the addon container read-only and point `TLS_CERT`/`TLS_KEY` at it, e.g.
`/etc/letsencrypt/live/<domain>/fullchain.pem` and `privkey.pem` (symlinks are followed, so
renewals are picked up), and publish `HTTPS_PORT` (7443).

### Other devices (TV, phone)

The server listens only on this computer (`127.0.0.1`) unless told otherwise. Set `PUBLIC_URL`
to an address the device can reach, for example `PUBLIC_URL=http://192.168.1.20:7000 npm start`;
the server then listens on all interfaces (or set `HOST` yourself). Add a user first (see below),
and install from that address. On a public
server, use HTTPS with a domain (see [Docker](#docker-linux-server)). Each install can also
override the stream link address with Stremio's **Configure** button.

## Users and access tokens

Without users, anyone who can reach the server can use it. Add users before making the server
reachable from other devices or the internet.

- In the TUI dashboard: press `a`. The token and install link are shown once; press `t` to see
  tokens later.
- Or in the environment: `npm run token` prints a random token, then
  `ACCESS_TOKENS="alice:<token1>,bob:<token2>" npm start`.

Each user gets a personal base URL, `<PUBLIC_URL>/<token>/`, with an install page. Every route
lives under that prefix, and stream links include the token, so links work only for their user.
Wrong or missing tokens get `404`; the bare root page only says a personal link is needed.
Tokens in `ACCESS_TOKENS` must be at least 16 characters (dashboard tokens are 32).

Users added in the dashboard, and limits changed there, are saved to `state/state.json`
(readable by the owner only). Saved limits override the environment on the next start. Users
from `ACCESS_TOKENS` can only be removed from the environment. Adding the first user switches
token checks on, and deleting the last one switches them off, without a restart.

## Limits

Hard limits; when one is reached, the server refuses a new torrent:

| Limit | Default | When reached |
|---|---|---|
| `MAX_TORRENTS_PER_USER` | 2 | `/play` answers `429`. Joining a torrent already in use always works. |
| `MAX_ACTIVE_TORRENTS` | 5 | Idle torrents are removed first; if none are idle, `503 Server busy`. |
| `MAX_DISK_GB` | unlimited | The cache rolls (below). `507` only if not even one more viewer fits. |
| `MAX_DISK_PER_STREAM_MB` | unlimited (minimum 128) | Per torrent, shared by everyone watching it. |

Several users watching the same torrent share one download and count once toward
`MAX_ACTIVE_TORRENTS`.

### Next episode

While an episode plays past `NEXT_EPISODE_AT` (90%) of its file, the server prepares the next
one, so Stremio's binge-watching starts it at once:

1. It finds the next episode in Cinemeta's episode list (after a season finale, the next
   season's first episode; nothing after the last episode).
2. It runs that episode's search with the same indexes, so the stream list Stremio asks for
   next is already cached.
3. It prefetches the torrent Stremio will pick: the first result with the same quality (the
   same `bingeGroup`). If that is the season pack being watched, it only warms up the next
   episode's file.

The prefetch is kept for `NEXT_EPISODE_TTL_MS` (30 minutes), does not count against
`PREFETCH_MAX`, works even with `PREFETCH_COUNT=0`, and is labelled *next episode* in the
dashboards. It is logged as, for example,
`[next] alice: prefetching S02E01 (1080p, 6eff9eb3) at 94% of S01E08`. `NEXT_EPISODE_AT=0`
turns it off. Not done in `native` mode.

### Header and index cache

Players read a file's header and often its index at the end before they start. When a torrent
that was played is removed (idle, eviction, **Remove**, shutdown), the server keeps the first
`PREFETCH_HEAD_MB` and last `PREFETCH_TAIL_MB` of every played file, plus the torrent's
metadata, in `state/edge-cache/`. Opening it again, even after a restart, then needs no
metadata lookup and serves those parts at once (a test: first byte in 0.02 s).

- Capped at `EDGE_CACHE_MB` (500 MB, which is also the maximum); least recently used torrents
  are dropped first. It is separate from `MAX_DISK_GB`.
- Restored pieces are checked against the torrent's hashes; a damaged one is downloaded again.
- The rolling disk cache never deletes these pieces of a played file while it plays, so they
  are still there to be saved.
- Stream lists carry Stremio's `filename` and `videoSize` hints for torrents whose file list is
  known (running or cached), which helps Stremio match subtitles.

## Disk cache

- Data lives in `DOWNLOAD_PATH`, one folder per torrent, one file per piece.
- A stream downloads only `READAHEAD_MB` (default 256) ahead of the playback position.
- With a disk limit, the cache stops growing at the limit and playback continues. Every second
  the server checks the sizes and deletes, in this order: pieces of a torrent that is over its
  per-stream limit, idle torrents, then pieces of active streams that are far from anyone's
  playback position (already watched pieces first).
- Each viewer keeps a protected window: 32 MB behind the playback position plus the readahead.
  The readahead shrinks automatically so all windows fit in 80% of each limit; for example
  `MAX_DISK_PER_STREAM_MB=150` gives 72 MB.
- Seeking back into deleted pieces works; they are downloaded again.
- The cache can exceed the limit for about a second, by what was downloaded in that time.
- A torrent is deleted `TORRENT_IDLE_MS` (2 minutes) after its last connection closes, on
  **Remove**, on eviction, and on shutdown.
- At startup, data left by a crash is deleted, but only in a folder that contains the
  `.stremio-webtorrent` marker file or is empty. A wrong `DOWNLOAD_PATH` never deletes your files.

## Stereo audio conversion

Players mix 5.1 and 7.1 audio down to stereo themselves, and many do it without headroom: in
loud scenes the sum goes past full scale and clips, which sounds like pops, crackling or
distortion. With the conversion on, every result in Stremio gets a second entry, **Stereo**,
where the server mixes the audio down with a limiter, so it never clips. The loudness stays
like the player's own downmix. It also turns AC3, E-AC3, DTS and TrueHD into AAC, which every
player can decode.

Turn it on with `AUDIO_CONVERSIONS=2` (conversions that may run at once; `on` means 2, `0` or
`off` turns it off), or change **Audio conversions** in the TUI while the server runs (key
`7`). With it off, the Stereo entries disappear from the stream list.

- Needs `ffmpeg`. The Docker image includes it; for `npm start`, install it (`brew install
  ffmpeg`, `apt install ffmpeg`). Without it the TUI shows the conversion as unavailable.
- The video is copied unchanged and only the audio is encoded (AAC, 192 kb/s stereo), so one
  conversion needs about 2–5% of one CPU core while playing (it runs 40–50x faster than real
  time) and about 55 MB of memory, and no GPU.
- The output is HLS (6-second or longer segments cut at the file's keyframes), so seeking
  works. Seeking to a part that is not converted yet restarts ffmpeg there; it catches up
  within seconds when the torrent data is there.
- Works for MP4 and MKV files with H.264 or HEVC video and an index (nearly all releases).
  Other files answer with an error; play the normal entry instead.
- Only the first audio track is kept, and embedded subtitles are dropped. Stremio's own
  subtitles (OpenSubtitles) still work.
- ffmpeg converts at most about 90 seconds ahead of the player, then pauses. Converted segments
  live in `DOWNLOAD_PATH/conversions`, about 20 segments (2–3 minutes of video) per
  conversion, outside `MAX_DISK_GB`. They are deleted 2 minutes after the player stops;
  resuming later starts the conversion again.
- A conversion reads the torrent like a player does, so the torrent limits, disk budgets and
  readahead apply unchanged.

## Slow starts: waiting instead of timing out

Opening a torrent means fetching its metadata from peers, then the first piece of the file.
With few peers each can take 10 to 60 seconds. Players give up after about 15 seconds without
data ("operation timed out").

So a `/play` request waits at most `PLAY_WAIT_MS` (12 s) for the metadata and the first piece,
which is downloaded with top priority. If it is still missing, the server answers with a
redirect to the same URL (`?w=1`, `?w=2`, ...). The player follows it with a fresh timeout while
the download continues. After `PLAY_MAX_WAITS` (8, the most ffmpeg follows) redirects, the
request streams as usual. In total a player can wait about 110 seconds instead of 15. Each
redirect is logged, e.g. `[play] ... first piece not ready after 12.0s, redirect 3/8`.
`PLAY_MAX_WAITS=0` turns this off.

### Prefetch

On top of waiting, loading a stream list starts the top `PREFETCH_COUNT` (2) results in the
background: metadata first, then the first `PREFETCH_HEAD_MB` (8) and last `PREFETCH_TAIL_MB`
(4) of the file that would play. Clicking a prefetched result then starts at once (in a test,
0.001 s instead of 19.6 s), at the cost of downloading a few megabytes of torrents you may not
watch. Results further down the list still start through waiting. `PREFETCH_COUNT=0` turns
prefetch off.

Prefetched torrents take no torrent slot, are removed first when space is needed, expire after
`PREFETCH_TTL_MS` (2 minutes) if unused, and at most `PREFETCH_MAX` (6) are kept. Prefetch is
skipped in `native` mode.

## Dashboards

### Web dashboard

`<PUBLIC_URL>/<token>/dashboard` (or `/dashboard` without users). Per torrent: download and
upload speed with a 90-second graph, connected peers, progress, disk use, the file being
played, who is watching, and for each connection how much is downloaded ahead. **Remove** stops
a torrent unless another user is streaming it.

### TUI dashboard

`npm start dashboard` opens a full-screen terminal dashboard. It needs an interactive terminal.
It connects to the server over a local Unix socket (`state/admin.sock`, owner only, never on
the network), so you can close and reopen it while the server keeps running.

| Key | Action |
|-----|--------|
| `a` | Add a user; shows the install link once. |
| `d` | Delete a user added in the dashboard; their links stop working at once. |
| `t` | Show or hide tokens. |
| `1`–`7` | Change a limit: torrents total, per user, disk total (GB), disk per stream (MB), readahead (MB), idle timeout (minutes), audio conversions at once (`0` = off). |
| `x` | Remove a torrent, even while people watch it. |
| `b`, `q`, Ctrl+C | Close the dashboard; the server keeps running. |
| `s` | Stop the server (asks first). |

### Reading the numbers

- **Connections, not viewers.** Players often open two or three connections at the start, for
  example to read the index at the end of an MKV or MP4, and close the extra ones after a few
  seconds.
- **Watching** shows each user's estimated timestamp and the gap to the user furthest ahead,
  for watching together, e.g. `bob ≈ 41:40 / 2:16:00 ahead   alice ≈ 1:17 / 2:16:00 40:23 behind`.
  It is the read position scaled by the runtime from Cinemeta, so it assumes a constant bitrate
  and runs ahead of the screen by what the player buffered: accurate to about a minute.
  Connections that read less than 8 MB are ignored. A plan for synchronized playback in the
  browser is in [docs/watch-together-plan.md](docs/watch-together-plan.md).

## Configure button (per-install settings)

Stremio's **Configure** button opens `<PUBLIC_URL>/<token>/configure`, which sets:

- **Server URL for stream links**: the address this device uses to reach the server.
- **Torrent indexes**: which indexes are searched. None are ticked unless the server enables
  some with `SCRAPERS`; unticking all switches searching off for this install.
- **Stream mode**: `webtorrent` (through this server), `native` (Stremio's own torrent engine),
  or `both`.

The settings are stored in the install URL (`/<token>/c/<settings>/manifest.json`), so each
device keeps its own; change them by configuring and installing again. Without settings, the
server defaults apply.

## Docker (Linux server)

Two compose files:

| File | Use |
|---|---|
| `docker-compose.yml` | The addon alone, plain HTTP on port 7000 (home network, or behind your own proxy). |
| `docker-compose.https.yml` | The addon behind [Caddy](https://caddyserver.com), which obtains and renews **Let's Encrypt** certificates by itself. Needed for one-click install from other devices and for Stremio Web. |

**Plain HTTP:**

```sh
cp .env.example .env
docker compose run --rm addon node scripts/token.js    # once per user, paste into ACCESS_TOKENS
# edit .env: PUBLIC_URL=http://<server-ip>:7000, ACCESS_TOKENS, SCRAPERS, limits
docker compose up -d --build
docker compose exec addon node src/index.js dashboard  # TUI; press t for install links, b to leave
```

**HTTPS with Let's Encrypt:**

1. Point a DNS record for your domain at the server; open ports 80 and 443 (TCP, and UDP 443
   for HTTP/3).
2. In `.env`: `DOMAIN=addon.example.com`, `PUBLIC_URL=https://addon.example.com`, and optionally
   `ACME_EMAIL=you@example.com` for expiry notices.
3. `docker compose -f docker-compose.https.yml up -d --build`

Caddy answers the Let's Encrypt challenge on ports 80/443, redirects HTTP to HTTPS and renews
certificates before they expire. Caddy is also the HTTPS endpoint: it serves the certificate
itself and talks plain HTTP to the addon on the internal network, so the addon container never
needs the certificate files.

- Certificates live in the `caddy-data` volume, at
  `/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/<DOMAIN>/<DOMAIN>.crt` and
  `.key`. Keep the volume: a re-created container reuses the stored certificate instead of
  requesting a new one (repeated requests can hit Let's Encrypt rate limits).
- Renewed certificates are served at once, without a restart (tested with Caddy's local CA and
  a 90 s lifetime: six renewals in two minutes, each served immediately). The addon's port 7000 is not published in
this setup, the addon runs with `HTTPS=off`, and Caddy receives only `DOMAIN` and `ACME_EMAIL`,
not the addon's tokens. Use
`-f docker-compose.https.yml` with every `docker compose` command for this setup.

**Both setups:**

- Open 6881/tcp+udp (BitTorrent peers, uTP) and 6882/udp (DHT) in the firewall.
- Volumes: `torrent-data` (temporary torrent data), `addon-state` (users, saved limits,
  header/index cache, admin socket).
- The image builds native modules for the server's CPU (x64 and arm64), so uTP works on both.
- The image includes ffmpeg for the stereo audio conversion (off by default, `AUDIO_CONVERSIONS`).
- `docker compose stop` gives the addon 30 s to finish and save its header/index cache. Logs
  rotate at 10 MB (3 files).
- A configuration error (for example the placeholder tokens from `.env.example`) is logged,
  then the container waits 30 s before exiting, so the restart policy does not flood the log.
- Local peer discovery does not reach into a container network. On Linux,
  `network_mode: host` for the addon service lets it find peers on your LAN (then remove its
  `ports:` section).
- Podman: build with `podman build --format docker`; the default OCI format drops the health
  check.

## Kubernetes

Plain manifests in `k8s/`, combined with Kustomize (built into `kubectl`, no Helm needed):

| Folder | Contents |
|---|---|
| `k8s/base` | Namespace `webtorrentio`, Deployment, Service, two volumes, Ingress, settings (`config.env`). No ingress controller specifics. |
| `k8s/overlays/traefik` | Traefik ingress, HTTPS with Traefik's own Let's Encrypt certificate. Tested on k3s. |
| `k8s/components/domain` | Copies `DOMAIN` into the Ingress and `PUBLIC_URL`. |
| `k8s/components/hostport` | Optional: opens the BitTorrent ports on the node, for incoming peers. |
| `k8s/local-example` | Starting point for your own deployment. |

The image is `ghcr.io/slendog/webtorrentio` (amd64 and arm64), built by
`.github/workflows/image.yml` from `main` (`latest`) and from version tags.

**Requirements:** Traefik as the ingress controller, with a certificate resolver named
`letsencrypt` (for another name, change `router.tls.certresolver` in
`k8s/overlays/traefik/kustomization.yaml`). With the Traefik Helm chart:

```yaml
certificatesResolvers:
  letsencrypt:
    acme:
      email: you@example.com
      storage: /data/acme.json
      tlsChallenge: {}
persistence:
  enabled: true   # keeps acme.json, so certificates survive a Traefik restart
```

A DNS record for the domain must point at Traefik, and ports 80/443 must reach it.

**Deploy:**

```sh
cp -r k8s/local-example k8s/local        # k8s/local is ignored by git
# edit k8s/local/kustomization.yaml: DOMAIN, optional settings, optional hostport
kubectl create namespace webtorrentio
kubectl -n webtorrentio create secret generic webtorrentio-secrets \
  --from-literal=ACCESS_TOKENS="alice:$(openssl rand -hex 24),bob:$(openssl rand -hex 24)"
kubectl apply -k k8s/local
kubectl -n webtorrentio exec -it deploy/webtorrentio -- node src/index.js dashboard   # press t for install links
```

Settings go into `literals` in your `kustomization.yaml` (any variable from
[Configuration](#configuration)); `kubectl apply -k k8s/local` again restarts the pod with the
new values. Token changes in the secret need `kubectl -n webtorrentio rollout restart
deploy/webtorrentio`. Without the secret the addon is open to everyone who can reach the domain.

Notes:

- **Exactly one pod.** Torrents, connections and limits live in the process memory, so the
  Deployment has `replicas: 1` and the `Recreate` strategy. Do not scale it up.
- **Volumes:** `webtorrentio-data` (50 Gi, torrent data; keep `MAX_DISK_GB` below its size) and
  `webtorrentio-state` (1 Gi: users, saved limits, header/index cache). Both use the cluster's
  default storage class; `ReadWriteOnce` is enough.
- **HTTPS:** Traefik terminates HTTPS and talks plain HTTP to the pod (`HTTPS=off`). The Ingress
  uses only the `websecure` entry point, so plain HTTP requests are not routed to the addon.
  Traefik passes streams through without buffering, so no timeout settings are needed.
- **Incoming peers:** an Ingress carries only HTTP. Without `components/hostport` the pod
  still streams, but only over connections it opens itself. With it, the node's ports 6881
  (TCP and UDP) and 6882 (UDP) go to the pod; open them in the node's firewall. A LoadBalancer
  or NodePort Service for those ports works too.
- **Stop and start:** `kubectl -n webtorrentio scale deploy/webtorrentio --replicas=0` (or `=1`).
  The pod gets 30 s to close streams and save its header/index cache.
- The pod runs as the image's `node` user with a read-only root filesystem and no capabilities.
- **Other ingress controllers:** make an overlay like `k8s/overlays/traefik` that sets
  `ingressClassName`, your controller's HTTPS annotations, and turns off response buffering
  and short read timeouts (video responses last as long as the playback).

## Configuration

All settings are environment variables. Limits changed in the TUI are saved and override these.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | HTTP port. |
| `HOST` | `127.0.0.1`, or `0.0.0.0` when `PUBLIC_URL` is not a loopback address; `0.0.0.0` in Docker | Interface to listen on. |
| `ALLOWED_HOSTS` | empty | Extra host names accepted in the `Host` header (IP addresses, `localhost`, and the hosts of `PUBLIC_URL`/`STREAM_URL` always are). |
| `HTTPS` | `auto` | Built-in HTTPS: `auto` (when a working certificate exists), `on` (required), `off`. |
| `HTTPS_PORT` | `7443` | HTTPS port, used when HTTPS is on. |
| `TLS_CERT`, `TLS_KEY` | `certs/cert.pem`, `certs/key.pem` | Certificate and key for HTTPS. |
| `PUBLIC_URL` | `https://127.0.0.1:$HTTPS_PORT` with a certificate, else `http://127.0.0.1:$PORT` | Base URL for install and stream links. |
| `STREAM_URL` | `PUBLIC_URL` if set, else `http://127.0.0.1:$PORT` | Base URL for `/play` stream links only. |
| `STREAM_MODE` | `webtorrent` | `webtorrent`, `native` or `both`. |
| `SCRAPERS` | empty (none) | Indexes to search, comma-separated (`yts,tpb,eztv,nyaa,1337x`), or `all`. |
| `ACCESS_TOKENS` | empty | `name:token,name:token`. Empty and no saved users means open access. |
| `STATE_FILE` | `state/state.json` | Saved users and limits. The admin socket and background log live next to it. |
| `ADMIN_SOCKET` | `state/admin.sock` | Unix socket between the TUI and the server. |
| `DOWNLOAD_PATH` | `$TMPDIR/stremio-webtorrent` | Torrent cache. |
| `MAX_ACTIVE_TORRENTS` | `5` | Torrents on the server. |
| `MAX_TORRENTS_PER_USER` | `2` | Torrents one user streams at once. |
| `MAX_CONNECTIONS_PER_USER` | `20` | Open HTTP connections per user; above it `/play` answers `429`. |
| `STREAM_RATE_PER_MIN` | `60` | Stream list requests per user and minute; above it `429` with an empty list. |
| `MAX_DISK_GB` | unlimited | Disk budget for all torrent data. |
| `MAX_DISK_PER_STREAM_MB` | unlimited, minimum `128` | Disk budget per torrent. |
| `READAHEAD_MB` | `256` | Download ahead of the playback position. |
| `TORRENT_IDLE_MS` | `120000` | Delay before an unused torrent is removed. |
| `PLAY_WAIT_MS` | `12000` | How long one `/play` request waits for metadata and the first piece before redirecting. |
| `PLAY_MAX_WAITS` | `8` | Redirects per request before it streams as usual; `0` turns waiting off. |
| `PREFETCH_COUNT` | `2` | Top results prefetched per stream list; `0` turns prefetch off. |
| `PREFETCH_HEAD_MB`, `PREFETCH_TAIL_MB` | `8`, `4` | Start and end of the file prefetched. |
| `PREFETCH_TTL_MS` | `120000` | Unused prefetched torrents are removed after this. |
| `PREFETCH_MAX` | `6` | Most prefetched torrents kept at once. |
| `NEXT_EPISODE_AT` | `0.9` | Share of an episode after which the next episode is prefetched; `0` turns it off. |
| `NEXT_EPISODE_TTL_MS` | `1800000` | How long a next-episode prefetch is kept if unused. |
| `EDGE_CACHE_MB` | `500` (maximum `500`) | Header and index cache of played files; `0` turns it off. |
| `AUDIO_CONVERSIONS` | `0` (off) | [Stereo audio conversions](#stereo-audio-conversion) that may run at once; `on` means `2`. Needs ffmpeg. |
| `TORRENT_PORT` | random (`6881` in Docker) | Port for incoming peers (TCP, and uTP over UDP). |
| `DHT_PORT` | `TORRENT_PORT + 1`, or random | UDP port for the DHT. Must differ from `TORRENT_PORT`. |
| `MAX_CONNS` | `55` | Peer connections per torrent. |
| `EXTRA_TRACKERS` | empty | Extra tracker announce URLs, comma-separated. |
| `MAX_RESULTS` | `30` | Torrents returned per stream list. |
| `SCRAPER_TIMEOUT_MS` | `10000` | Timeout per index. |
| `CACHE_TTL_MS` | `1800000` | How long search results are cached. |
| `USER_AGENT` | a desktop Chrome user agent | User agent for requests to the indexes. |

## HTTP endpoints

Under `/<token>` when users exist.

| Endpoint | Description |
|---|---|
| `GET /` | Install page. |
| `GET /install` | Redirect to the `stremio://` install link. |
| `GET /manifest.json` | Stremio manifest. |
| `GET /configure` | Settings page. |
| `GET /stream/:type/:id.json` | Stremio stream list. |
| `GET /play/:infoHash/:fileIdx` | Video over HTTP with Range support; `fileIdx` is a number or `auto`. |
| `GET /hls/:infoHash/:fileIdx/index.m3u8` | The same video as HLS with stereo audio (when the conversion is on); segments are `<n>.ts` next to it. |
| `GET /dashboard` | Web dashboard. |
| `GET /status` | Dashboard data as JSON (torrents, `connections`, `viewers`, `watchers`, disk). |
| `DELETE /api/torrents/:infoHash` | Stop a torrent; `409` if another user is streaming it. |
| `GET /health` | Always public; for health checks. |

## Troubleshooting

- **"Operation timed out" in Stremio, or slow start.** Usually too few peers. Networks that
  block outbound UDP (common in offices and on mobile) disable DHT and UDP trackers, leaving a
  handful of peers. The server already prefetches the top results and makes the player wait up
  to about 110 s (see [Slow starts](#slow-starts-waiting-instead-of-timing-out)); pick one of
  the top two results, raise `PLAY_WAIT_MS` or `PREFETCH_COUNT`, pick a result with more
  seeders, or run the server on a network with UDP.
  Each request is logged as a `[play]` line with its wait, redirects and time to first byte.
- **TLS error when clicking Install.** `stremio://` links need HTTPS; see
  [One-click install](#one-click-install-stremio-links), or paste the `http://` manifest URL.
- **Stremio cannot connect / connection refused.** The server is not running. Check
  `state/server.log` for why it stopped.
- **The server stopped by itself.** The end of `state/server.log` says why: `Shutting down
  (...)` for a normal stop, `Crashed (...)` or `[webtorrent] fatal: ...` otherwise.
- **"Port 7000 is already in use".** Another server is running: `npm stop`, or open it with
  `npm start dashboard`.
- **"The dashboard needs an interactive terminal".** Run it in a real terminal, not from a
  script or a non-interactive shell.
- **Stream list shows old information.** Stremio caches stream lists for up to 5 minutes;
  reopen the title later or restart Stremio.
- **"Unknown torrent. Open it from the stream list".** Without users, the server only plays
  torrents it listed itself (see [Security](#security)). After a restart, Stremio may still show
  an old list: reopen the title so the list is loaded again.
- **"Host ... is not allowed".** The server was reached through a host name it does not know.
  Add the name to `ALLOWED_HOSTS`, or use `PUBLIC_URL` with that name.
- **Pops, crackling or distorted sound, mostly in loud scenes.** The player's downmix of 5.1 or
  7.1 audio clips. Turn on the [stereo audio conversion](#stereo-audio-conversion) and pick the
  **Stereo** entry.
- **Wrong episode from a season pack.** Pack detection relies on `S01E02`-style file names.
  Choose a single-episode result.

## Security

- **Add users before exposing the server.** Without users, anyone who can reach it can use it
  and stream through your connection. By default the server listens only on `127.0.0.1`; it
  warns at startup when it listens on the network without users.
- **Protection against web pages.** A page open in your browser can send requests to
  `127.0.0.1`. To limit what it can do:
  - the dashboard, `/status` and the API send no CORS headers, so other sites cannot read them;
  - `Host` headers with unknown names are rejected (`403`), which blocks DNS rebinding;
  - without users, `/play` only accepts torrents that this server returned in a stream list, so
    a page cannot make your server download and seed an arbitrary torrent.
- **Tokens are secrets.** Install links and stream links contain them, and `state/state.json`
  stores them. Tokens are printed only to an interactive terminal, not to log files or
  `docker logs`. The `state/` folder is owner-only (`0700`), the state file, log and admin
  socket are `0600`. Do not commit `state/`, `certs/` or `.env` (they are in `.gitignore`).
- **Untrusted names.** Torrent and file names come from other peers and from index sites.
  Control characters in them are replaced before they reach a terminal (log output, TUI), line
  breaks cannot start fake log lines, and HTML is escaped in the web pages.
- **Browser headers.** Every response has `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. HTML pages add a
  Content-Security-Policy that allows only their own inline code, connections to this server,
  and no framing (no clickjacking of **Remove** or **Install**). Pages and data other than the
  Stremio routes are sent with `Cache-Control: no-store`, so tokens are not cached.
- **Hostile peers.** Other BitTorrent peers are untrusted. Data that makes the protocol code
  throw (for example an encryption handshake with an invalid key, which used to crash the
  server) now closes only that peer's connection, logged as `[peer] closed a connection that
  sent invalid data`. The guard wraps `bittorrent-protocol`; the server warns if WebTorrent
  ever uses a different copy of it.
- **Crashes are explained.** Any unexpected error is logged with a timestamp (`Crashed (...)`)
  before the server exits, and a WebTorrent failure such as a busy port stops the server at once
  with the reason instead of leaving it half working.
- **Resource limits.** Per-user limits for torrents, connections and stream list requests
  (each one searches every enabled index), disk budgets, and a 5 MB cap on responses from index
  sites.
- **The admin socket** gives full control over the server. Only its owner can open it.
- **`npm stop`** only signals processes that are this addon, never another program on the port.
- **`ip` package replaced.** WebTorrent's tracker library depends on `ip@2.0.1`, which has an
  unfixed advisory in `isPublic()` ([GHSA-2p57-rm9w-gvfp](https://github.com/advisories/GHSA-2p57-rm9w-gvfp)).
  The only code that uses `ip` is `bittorrent-tracker/lib/server/parse-udp.js`, and it only calls
  `toString()`. `package.json` therefore overrides `ip` with a local stand-in, `vendor/ip`, that
  contains just that function (copied from `ip`, MIT). The vulnerable code is not installed, and
  `npm audit` reports no vulnerabilities. If a future dependency needs another `ip` function, the
  server fails at startup with "... is not a function"; check with `npm ls ip` after upgrades.
  The upstream fix is [bittorrent-tracker#550](https://github.com/webtorrent/bittorrent-tracker/pull/550).
- **Reporting.** Please report vulnerabilities privately through GitHub's
  [security advisories](https://github.com/Slendog/webtorrentio/security/advisories/new) rather
  than in public issues.

## How it works

1. Stremio asks for streams for an IMDb id, e.g. `tt1234567`, or `tt1234567:1:2` for season 1
   episode 2.
2. The addon looks up title, year and runtime on Cinemeta and queries the enabled indexes in
   parallel. A blocked or broken index only drops its own results.
3. Results are filtered by title, year and episode, deduplicated by info hash, sorted by peer
   count, and returned as links to `/play/<infoHash>/auto`.
4. On `/play`, WebTorrent fetches the torrent metadata, picks the file (matching episode in a
   pack, else the largest video) and downloads the requested byte range plus the readahead.

### Indexes

| Key | Content | Method |
|---|---|---|
| `yts` | Movies | JSON API, by IMDb id |
| `tpb` | Movies, TV | JSON API |
| `eztv` | TV | JSON API, by IMDb id |
| `nyaa` | Anime | RSS feed |
| `1337x` | Movies, TV | HTML (often blocked by Cloudflare) |

None is enabled by default; enable them with `SCRAPERS` or the Configure page. Unknown keys
are ignored. Each index module in `src/scrapers/` lists mirror domains, which change often. To add an index,
export `{ name, types, search(query) }` from a module and register it in `src/scrapers/index.js`.

## Legal and safety

- **No content here.** This repository contains source code only. It hosts, stores and links to
  no media and no torrent files. Search results come live from third-party sites that this
  project does not operate or control, and is not affiliated with.
- **You are responsible.** Downloading or sharing copyrighted material without permission is
  illegal in many countries. Use this software only for content you have the right to access,
  such as public-domain works, Creative Commons releases, or your own files. No index is searched
  until you enable it with `SCRAPERS` or the Configure page.
- **BitTorrent uploads.** While a torrent is active, WebTorrent also uploads pieces to other
  peers, so you distribute what you stream. Peers and trackers see your IP address.
- **Not affiliated** with Stremio, WebTorrent, or any index listed above. Names are used only to
  describe what the code connects to.
- **No warranty.** The software is provided as is.

## License

Released into the public domain under [The Unlicense](LICENSE), except `vendor/ip`, which contains
code from the `ip` package under its MIT license ([vendor/ip/LICENSE](vendor/ip/LICENSE)). Anyone may use, copy, modify
and distribute the code for any purpose, without conditions. The legal notes above still apply
to how the software is used.
