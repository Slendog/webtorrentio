# Plan: watch together in the browser

Status: proposal, not started.

## Goal

Several people watch the same torrent at the same moment, with play, pause and seek shared.
Stremio's player cannot be controlled by an addon, so playback moves to a player page that this
server hosts. People open a room link in a browser; the server keeps everyone in sync.

## What exists today

- `/play/:infoHash/:fileIdx` serves any file with HTTP Range support. A browser `<video>`
  element can play from it directly.
- Tokens identify users, limits count per user and per torrent, and one download is shared by
  everyone reading the same torrent. A room fits this model without changes to downloading.
- Both dashboards show an estimated timestamp per user ("Watching" line). This is the manual
  alternative and stays available.

## Constraints

**Browser codec support decides what can play.** This is the biggest risk.

| Content | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| H.264 + AAC in MP4 | yes | yes | yes |
| H.264 + AAC in MKV | usually | varies by version | no |
| HEVC / x265 | only with hardware support | no | yes |
| AV1 | yes | yes | recent Apple hardware only |
| AC3 / E-AC3 audio | Edge only | no | yes |
| DTS / TrueHD audio | no | no | no |

Many 1080p and 4K releases use x265 and DTS or TrueHD audio, so they will not play without
conversion. The plan handles this in three ways: flag compatible releases in the stream list,
let the page detect a failure and explain it, and offer optional server-side conversion
(phase 4).

**No Stremio integration beyond links.** Stremio can show a stream entry that opens a URL in the
browser (`externalUrl`). That is how a room is started from Stremio.

## Design

### Rooms

- A room holds: id (random, 10 characters), torrent info hash and file index, host user,
  members, and the shared playback state.
- Playback state: `playing` (bool), `position` (seconds), `updatedAt` (server time), `rate`.
  The expected position at time *t* is `position + (t - updatedAt) * rate` when playing.
- Rooms live in memory. A room with no members for 10 minutes is deleted.
- A room keeps its torrent busy, so the idle timeout does not remove the torrent while people
  are in the room, even if everyone is paused.

### Joining

- Start: a "Watch together" entry in Stremio's stream list for each compatible torrent. It opens
  `/<token>/watch/new?h=<infoHash>&s=<season>&e=<episode>`, which creates a room and redirects to
  `/<token>/watch/<roomId>`.
- Invite: the room page shows a share link. Other users open
  `/<their token>/watch/<roomId>`. Their install page gets a "Join a room" field for the room id.
- Open question: allow guests without a token through a one-room invite link? Convenient, but
  anyone with the link could stream through the server until the room ends.

### Sync protocol

- Transport: Server-Sent Events for server-to-client updates, plain POST requests for actions.
  No new dependency, and it works through the Caddy proxy. WebSockets (the `ws` package) are the
  alternative if latency turns out to matter.
- Clock offset: each client pings the server a few times on join and keeps the median offset, so
  everyone computes the expected position against the same clock.
- Actions: `play`, `pause`, `seek(position)`, `rate(value)`. The server applies one, stamps it
  with its time, and broadcasts the new state. The last action wins.
- Drift correction, every second on each client:
  - under 0.3 s: nothing;
  - 0.3 to 2 s: play at 0.95x or 1.05x until caught up (inaudible);
  - over 2 s: seek to the expected position.
- Buffering: when a member's video stalls, the client reports it. Room setting "wait for
  everyone" (default on): the server pauses the room until all members can play again, then
  resumes everyone together. With it off, only the stalled member falls behind and catches up.
- Control: default "everyone can control". Room setting "host only" for larger groups.

### Player page

- Plain HTML and JavaScript served by the addon, no build step, like the existing dashboard.
- `<video>` pointed at the user's own `/play` URL (`/<token>/play/<infoHash>/<fileIdx>`), so
  per-user limits and disk budgets apply as today.
- Shows members, who is buffering, each member's drift, and the room controls. A short chat is
  optional.
- Detects playback errors (`MediaError`, missing audio track) and explains them: "This release
  uses HEVC video, which this browser cannot play. Pick an H.264 release or ask the host to
  enable conversion."

### Subtitles

- Fetch subtitles from Stremio's OpenSubtitles addon
  (`https://opensubtitles-v3.strem.io/subtitles/<type>/<id>.json`), convert SRT to WebVTT on the
  server, and offer them as `<track>` elements. Each member picks a language independently.
- Embedded subtitle tracks in MKV files are not available to browsers; out of scope unless phase
  4 extracts them.

### Compatibility hints

- Guess from the release name before playing: `x264`/`H.264`/`AVC` with AAC → likely fine; `x265`,
  `HEVC`, `DTS`, `TrueHD`, `Atmos`, `REMUX` → likely not. Show "Browser OK" or "Browser: unlikely"
  on stream entries and in the room.
- After the torrent is loaded, check the real file extension and, with ffprobe available, the
  real codecs.

### Optional conversion (phase 4)

- With `ffmpeg` installed (or in the Docker image), the server can prepare a browser-safe stream:
  - remux MKV to fragmented MP4, and convert only the audio to AAC: cheap, covers H.264 files
    with AC3, DTS or TrueHD audio;
  - full video transcoding of HEVC to H.264: heavy. One 1080p stream needs several CPU cores or a
    GPU encoder (VAAPI, NVENC, VideoToolbox). Off by default, with its own limit such as
    `MAX_TRANSCODES=1`.
- Seeking in a live conversion needs restarting ffmpeg at the new position. HLS output (short
  segments) makes seeking and sync simpler than a single MP4 stream.

### Limits and dashboards

- A room member's reads count like any other connection: per-user torrent limit, disk budgets
  and readahead apply unchanged. Because members stay close together, their readahead windows
  overlap and the disk use is close to that of one viewer.
- Both dashboards list rooms: torrent, members, playing or paused, position, drift per member.
  The TUI gets a key to close a room.

## Phases

| Phase | Scope | Estimate |
|---|---|---|
| 1 | Player page for one user, error explanations, compatibility hints in the stream list | 1 day |
| 2 | Rooms, join flow, SSE sync, clock offset, drift correction, buffering pause, host setting | 2 to 3 days |
| 3 | Subtitles from OpenSubtitles, per-member language | 0.5 day |
| 4 | Optional ffmpeg remux / audio conversion; full transcoding behind a flag; HLS output | 3 to 5 days |
| 5 | Rooms in both dashboards and in `/status`; room limits | 0.5 day |

Phases 1 to 3 give a usable feature for H.264 releases. Phase 4 decides whether x265 releases
work, and it is the one that affects server hardware.

## Testing

- Unit: expected-position math, drift decisions, room lifecycle, SRT-to-VTT conversion.
- Two or three browser tabs in one room: play, pause, seek, rate, one tab throttled to force
  buffering, one tab joining late. Measure drift over 30 minutes; target under 0.5 s.
- Browser matrix: Chrome, Firefox, Safari with an H.264 MP4, an H.264 MKV, and an x265 MKV.
- Load: two rooms of three members on the Linux server, checking disk budgets and CPU (with
  conversion on).

## Open questions

1. Guest invite links without a token: yes or no?
2. Default control: everyone, or host only?
3. Is ffmpeg acceptable in the Docker image (about 80 MB), and is there a GPU on the server for
   transcoding?
4. Chat in the room page, or leave that to an existing messenger?
