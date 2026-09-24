# Plan: watch together in the browser

Status: proposal, not started. Revised after the stereo audio conversion (`src/convert.js`)
was built, which provides most of the media side.

## Goal

Several people watch the same torrent at the same moment, with play, pause and seek shared.
Stremio's player cannot be controlled by an addon, so playback moves to a player page that this
server hosts. People open a room link in a browser; the server keeps everyone in sync.

The estimated timestamps in both dashboards ("Watching" line) stay as the no-effort
alternative for people who prefer the Stremio player.

## What exists today

- **`/play/:infoHash/:fileIdx`**: the original file with Range support.
- **`/hls/:infoHash/:fileIdx/index.m3u8`** (with `AUDIO_CONVERSIONS` > 0): the same video as HLS.
  - Video: copied unchanged.
  - Audio: AAC stereo, mixed down with a limiter.
  - Segments: cut at the source's keyframes, carrying the source's original timestamps (`-copyts`).
  - Behaviour: every segment is the same whichever ffmpeg run produced it, seeking restarts
    ffmpeg at the target, idle conversions stop and restart on demand.
  - This solves the browser audio problem: AC3, E-AC3, DTS and TrueHD do not play in most
    browsers, and AAC does.
  - Its timeline is exact: `video.currentTime` in any member's browser means the same frame, which
    makes sync straightforward.
- **Users and limits:** tokens identify users, limits count per user and per torrent, and one
  download is shared by everyone reading the same torrent.
- **Deployment:** the reference server (BAS) runs behind Caddy on HTTPS, which is required for
  the browser page anyway.

## The remaining media problem: video codecs

| Video | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| H.264 | yes | yes | yes |
| HEVC (x265) | with hardware support (most Macs, many Windows PCs) | limited | yes |
| AV1 | yes | yes | recent Apple hardware |

A large share of releases is HEVC (the RARBG x265 files watched on BAS are). Those play for
some members and not for others. Options, in order of cost:

1. **Detect and explain:** the page checks `MediaSource.isTypeSupported()` for the file's
   codec before joining and says so ("this browser cannot play HEVC; use Safari or Edge, or pick
   an H.264 release"). Free, and part of phase 1.
2. **Prefer H.264 releases:** mark stream entries "Browser OK" when the name says x264/H.264/AVC.
3. **Transcode HEVC to H.264** (phase 5): the real fix, but heavy. See below.

## Design

### Player page

- Plain HTML and JavaScript served by the addon, no build step, like the dashboard.
- **HLS in the browser:**
  - Safari plays HLS natively.
  - Chrome, Edge and Firefox need **hls.js**. It is added as a dependency and served by this
    server (`/assets/hls.min.js`), because the Content-Security-Policy allows no outside
    scripts. About 400 KB.
- **Risk:** hls.js must turn MPEG-TS segments with HEVC into fragmented MP4 for the browser.
  Check this first. If it does not work, switch the conversion output to fragmented MP4 segments
  (`-hls_segment_type fmp4` style: an init segment plus `EXT-X-MAP`), which every browser path
  accepts. `convert.js` then gets an output format per request (`.ts` for Stremio, `.m4s` for
  browsers).
- **Source:** a `<video>` element pointed at the member's own `/hls` URL, so their token,
  limits and disk budgets apply.
- **Shown on the page:**
  - members, who is buffering, each member's drift, the room controls, and the share link;
  - playback errors (`MediaError`, missing audio) with a plain explanation.
- **Opening it from Stremio:** a "Watch together" entry with `externalUrl` for each result, only
  when the conversion is on.

### Rooms

- A room holds:
  - id (random, 10 characters);
  - torrent info hash and file index;
  - host user and members;
  - the shared playback state: `playing`, `position` (seconds), `updatedAt` (server time), `rate`.
- **Expected position** at time *t*: `position + (t - updatedAt) * rate` while playing.
- **One conversion per room, not per member.** The conversion session key becomes the room id,
  so three members cost one ffmpeg process and one set of segments. It counts once against
  `AUDIO_CONVERSIONS` and against the host's torrent limit.
- **Lifetime:**
  - Rooms live in memory, and a room with no members for 10 minutes is deleted.
  - A room keeps its torrent and its conversion alive while members are in it, even when
    everyone is paused.
  - The 2-minute idle stop in `convert.js` applies only after the room ends.

### Joining

- **Start:** the Stremio entry opens `/<token>/watch/new?h=<infoHash>&i=<fileIdx>&s=&e=`. That
  creates the room and redirects to `/<token>/watch/<roomId>`.
- **Invite:** the page shows `https://<server>/watch/<roomId>`. A member opens it and is asked to
  paste their own install link (or token) once. The browser stores the token in `localStorage`
  for the next rooms. No token, no access.
- **Guest links:** see open question 1.

### Sync protocol

- **Transport:** Server-Sent Events from server to clients, plain POST requests for actions.
  - No new dependency.
  - SSE passes through Caddy and Traefik unbuffered: Caddy already uses `flush_interval -1`,
    and Traefik does not buffer.
  - The server sends a comment line every 15 s so proxies keep the connection open.
- **Clock offset:** each client pings the server 5 times on join and keeps the median offset.
- **Actions:** `play`, `pause`, `seek(position)`, `rate(value)`. The server stamps each action
  with its time and broadcasts the new state. The last action wins.
- **Drift correction, every second on each client:**
  - under 0.3 s: nothing;
  - 0.3 to 2 s: play at 0.95x or 1.05x until caught up (inaudible);
  - over 2 s: seek to the expected position.

  Seeking is exact, because segment timestamps are the source's own.
- **Buffering:** a client reports `waiting` and `playing` events from its `<video>` element.
  - With "wait for everyone" on (the default), the server pauses the room while any member
    buffers, then resumes everyone together.
  - With it off, a stalled member falls behind and catches up.
- **Seeks restart ffmpeg:** a seek to an unconverted part restarts ffmpeg, and all members
  then wait for the same new segments. The "wait for everyone" pause covers this.
- **Control:** everyone by default; a "host only" setting for larger groups.

### Subtitles

- Fetch from Stremio's OpenSubtitles addon
  (`https://opensubtitles-v3.strem.io/subtitles/<type>/<id>.json`).
- Convert SRT to WebVTT on the server and offer the result as `<track>` elements. Each member
  picks a language.
- Subtitles embedded in the file are not carried by the conversion (it maps only video and one
  audio track). They could be extracted to WebVTT with an extra ffmpeg call per track; out of
  scope unless asked.

### Video transcoding (phase 5)

Makes HEVC releases play in every browser. `convert.js` gets a second mode: video transcoded to
H.264, audio as today.

- **Keyframes and segments:** transcoding sets the keyframes itself, with
  `-force_key_frames` at the existing segment starts. So segment boundaries and the rest of
  `convert.js` stay unchanged.
- **Hardware on BAS:**
  - CPU: Xeon E3-1275 v5, 4 cores / 8 threads. Software x264 at `veryfast` manages about one
    1080p stream in real time and would compete with Minecraft.
  - GPU: Intel HD P530 (Quick Sync). It decodes HEVC and encodes H.264 in hardware, which
    realistically allows 2–3 streams. `/dev/dri` is missing, so the i915 driver is not loaded.
    Enabling it needs `sudo` (module or kernel parameter, possibly a reboot).
  - The container then needs the device (`devices: /dev/dri`), and the image needs the VAAPI
    driver (`intel-media-va-driver` for Skylake).
- **Limits:** a separate `VIDEO_TRANSCODES` limit (default 0), and a request falls back to
  audio-only conversion when all transcodes are in use. Only rooms use transcoding by default;
  Stremio players decode HEVC themselves.

### Limits and dashboards

- A room's reads count like any other stream: the torrent limit (host), disk budgets and
  readahead apply unchanged, and members of one room share one conversion.
- A `MAX_ROOMS` limit (default 3) sits in the TUI next to the other limits.
- Both dashboards list rooms: torrent, members, playing or paused, position, and drift per
  member. The TUI gets a key to close a room.

## Phases

| Phase | Scope | Estimate |
|---|---|---|
| 1 | Player page for one user on `/hls` with hls.js; TS-vs-fMP4 check in Chrome, Firefox, Safari; codec detection and error texts; "Watch together" stream entry | 1 day |
| 2 | Rooms, join and invite flow, one conversion per room, SSE sync, clock offset, drift correction, buffering pause, host-only setting | 2–3 days |
| 3 | Subtitles from OpenSubtitles, per-member language | 0.5 day |
| 4 | Rooms in both dashboards and `/status`, `MAX_ROOMS`, close-room key | 0.5 day |
| 5 | Optional HEVC-to-H.264 transcoding (VAAPI/Quick Sync, CPU fallback), `VIDEO_TRANSCODES`; needs the GPU driver enabled on BAS | 2–3 days |

Phases 1 to 4 give a working feature for H.264 releases, and for HEVC releases in Safari and
Edge. Phase 5 makes HEVC work everywhere.

## Testing

- **Unit:** expected-position math, drift decisions, room lifecycle, SRT-to-WebVTT conversion.
- **Browsers:** Chrome, Firefox and Safari with an H.264 MP4, an H.264 MKV with E-AC3 audio, and
  an HEVC MP4 (the Reacher files), each through `/hls`.
- **Sync:** three browser tabs in one room, testing:
  - play, pause, seek, rate;
  - one tab throttled to force buffering;
  - one tab joining late;
  - a seek into an unconverted part.

  Measure drift over 30 minutes; target under 0.5 s.
- **Load on BAS:** two rooms of three members, checking CPU, memory (container limit 4 GB) and
  disk. With phase 5, one and then two transcodes.

## Open questions

1. **Guest links without a token:** yes or no? Proposed: no; every member uses their own token.
2. **Default control:** everyone, or host only? Proposed: everyone, with a host-only setting.
3. **GPU on BAS:** enable the Intel driver for phase 5, or skip transcoding?
4. **Chat on the room page**, or leave it to an existing messenger? Proposed: no chat.
