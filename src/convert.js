import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { config } from './config.js'
import { oneLine } from './logbuffer.js'
import { readKeyframeIndex } from './media-index.js'
import { isRemoved, keepTorrent, LimitError, openStream, readRange, resolveFile } from './torrent.js'

// Audio conversion: the same video with its audio mixed down to stereo, served as HLS.
//
// Players mix 5.1/7.1 audio down to stereo themselves, and many do it without headroom: loud
// scenes go past full scale and clip, which sounds like pops and crackling. Here ffmpeg does
// the downmix with a limiter in front of the encoder, so the result never clips. The video
// is copied unchanged, so this needs little CPU and no GPU. The output is also plain AAC,
// which helps players that cannot decode AC3, E-AC3, DTS or TrueHD.
//
// Seeking needs HLS: a converted stream has no fixed byte size, so HTTP ranges cannot work.
// Segments are cut at the source's keyframes (read from the MP4 or MKV index, see
// media-index.js), which makes segment n the same no matter where ffmpeg starts. A seek to an
// unconverted segment restarts ffmpeg there. ffmpeg reads the torrent through a local HTTP
// server with range support, like a player would, so downloads follow the conversion.
//
// AUDIO_CONVERSIONS (or the TUI) sets how many conversions may run at once; 0 turns it off.

const SEGMENT_SECONDS = 6
// Convert at most this many segments ahead of the player, then pause ffmpeg.
const AHEAD_SEGMENTS = 15
// Segments behind the player that stay on disk (short rewinds).
const KEEP_BEHIND_SEGMENTS = 5
// A request for a segment at most this far past the converted ones waits instead of restarting.
const WAIT_SEGMENTS = 3
// A conversion nobody requested a segment from for this long is stopped and its files deleted.
// A later request (the player resumes after a long pause) starts it again.
const IDLE_MS = 2 * 60 * 1000

const VIDEO_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'V_MPEG4/ISO/AVC', 'V_MPEGH/ISO/HEVC'])

// Stereo downmix without normalisation (same loudness as the player's own downmix), then a
// limiter at -1 dBFS so peaks never reach full scale.
const AUDIO_FILTER = 'aresample=ochl=stereo,alimiter=limit=0.891:level=0:attack=5:release=50,aformat=sample_fmts=fltp'

export const ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
if (config.audioConversions && !ffmpegAvailable) {
  console.warn('[convert] AUDIO_CONVERSIONS is set, but ffmpeg is not installed: audio conversion is off. Install ffmpeg or use the Docker image.')
}

export const conversionAvailable = () => ffmpegAvailable && config.audioConversions > 0

export class UnsupportedError extends Error {
  constructor (message) {
    super(message)
    this.status = 415
  }
}

const root = path.join(config.downloadPath, 'conversions')
const sessions = new Map() // key -> session

// ---- Local input for ffmpeg: the torrent file over HTTP with range support.

const inputSecret = crypto.randomBytes(16).toString('hex')
const input = http.createServer((req, res) => {
  const [, secret, id] = req.url.split('/')
  const session = secret === inputSecret && [...sessions.values()].find(s => s.id === id)
  if (!session?.file || isRemoved(session.entry)) return res.writeHead(404).end()
  const total = session.file.length
  let start = 0
  let end = total - 1
  const m = req.headers.range?.match(/bytes=(\d*)-(\d*)/)
  if (m) {
    start = Number(m[1] || 0)
    if (m[2] !== '') end = Math.min(Number(m[2]), total - 1)
    if (start > end) return res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
  }
  res.writeHead(m ? 206 : 200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(m ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {})
  })
  if (req.method === 'HEAD') return res.end()
  const stream = openStream(session.entry, session.file, start, end, session.user)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
})
const inputReady = new Promise(resolve => input.listen(0, '127.0.0.1', resolve))
input.unref()

// ---- Sessions

const keyOf = (user, infoHash, fileIdx, season, episode) => [user, infoHash.toLowerCase(), fileIdx, season ?? '', episode ?? ''].join('\n')

// Segment start times: the first keyframe at least SEGMENT_SECONDS after the previous start.
function segmentStarts (keyframes) {
  const starts = [0]
  for (const k of keyframes) if (k - starts[starts.length - 1] >= SEGMENT_SECONDS) starts.push(k)
  return starts
}

export function activeConversions () {
  return sessions.size
}

// The conversion of one file for one user, created on the first playlist or segment request.
// Throws LimitError when AUDIO_CONVERSIONS are all in use.
export function getSession (user, infoHash, fileIdx, season, episode) {
  const key = keyOf(user, infoHash, fileIdx, season, episode)
  let session = sessions.get(key)
  if (!session) {
    if (!conversionAvailable()) throw new LimitError('Audio conversion is turned off on this server.', 503)
    if (sessions.size >= config.audioConversions) {
      throw new LimitError(`All ${config.audioConversions} audio conversions are in use. Try again later, or play the original stream.`, 503)
    }
    session = {
      key,
      id: crypto.randomBytes(8).toString('hex'),
      user,
      infoHash: infoHash.toLowerCase(),
      dir: null,
      entry: null,
      file: null,
      release: null,
      starts: null,
      duration: 0,
      done: new Set(),
      run: null,
      lastRequested: 0,
      lastUsed: Date.now(),
      idleTimer: null,
      waiters: new Set(),
      createdAt: Date.now()
    }
    sessions.set(key, session)
    session.ready = prepare(session, fileIdx, season, episode)
    session.ready.catch(err => {
      console.warn(`[convert] ${user} ${session.infoHash.slice(0, 8)}: ${oneLine(err.message)}`)
      endSession(session)
    })
  }
  touch(session)
  return session
}

async function prepare (session, fileIdx, season, episode) {
  const { entry, file } = await resolveFile(session.infoHash, fileIdx, season, episode, session.user)
  session.entry = entry
  session.file = file
  session.release = keepTorrent(entry)
  const index = await readKeyframeIndex((s, e) => readRange(entry, file, s, e, session.user), file.length)
  if (!index) throw new UnsupportedError(`${file.name}: no keyframe index (only MP4 and MKV files with an index can be converted)`)
  if (!VIDEO_CODECS.has(index.videoCodec)) throw new UnsupportedError(`${file.name}: video codec ${index.videoCodec} is not supported for conversion (H.264 and HEVC are)`)
  session.starts = segmentStarts(index.keyframes)
  session.duration = index.duration
  session.dir = path.join(root, session.id)
  fs.mkdirSync(session.dir, { recursive: true })
  await inputReady
  console.log(`[convert] ${session.user} ${oneLine(file.name)}: ${session.starts.length} segments, ${(index.duration / 60).toFixed(1)} min, ${index.container} ${index.videoCodec}`)
  return session
}

function touch (session) {
  session.lastUsed = Date.now()
  clearTimeout(session.idleTimer)
  session.idleTimer = setTimeout(() => {
    console.log(`[convert] ${session.user} ${session.file ? oneLine(session.file.name) : session.infoHash.slice(0, 8)}: idle, stopped`)
    endSession(session)
  }, IDLE_MS)
  session.idleTimer.unref()
}

function endSession (session) {
  if (sessions.get(session.key) !== session) return
  sessions.delete(session.key)
  clearTimeout(session.idleTimer)
  stopRun(session)
  for (const w of session.waiters) w(false)
  session.release?.()
  if (session.dir) fs.rm(session.dir, { recursive: true, force: true }, () => {})
}

export function stopAllConversions () {
  for (const s of [...sessions.values()]) endSession(s)
}

// ---- ffmpeg runs

// Stop the current ffmpeg run and delete its unfinished segment.
function stopRun (session) {
  const run = session.run
  if (!run) return
  session.run = null
  clearInterval(run.poll)
  if (!run.exited) {
    try { run.proc.kill('SIGCONT') } catch {}
    run.proc.kill('SIGKILL')
  }
  const cleanup = () => {
    for (const f of fs.readdirSync(session.dir, { withFileTypes: true })) {
      if (f.name.startsWith(`${run.id}-`) || f.name === `${run.id}.csv`) fs.rmSync(path.join(session.dir, f.name), { force: true })
    }
  }
  if (run.exited) cleanup()
  else run.proc.once('exit', () => { try { cleanup() } catch {} })
}

// Synchronous on purpose: two segment requests at the same moment must not both start ffmpeg.
function startRun (session, n) {
  stopRun(session)
  const { starts } = session
  const runId = crypto.randomBytes(4).toString('hex')
  const list = path.join(session.dir, `${runId}.csv`)
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error']
  // Just past the keyframe, so the input seek lands on it.
  if (n > 0) args.push('-ss', (starts[n] + 0.02).toFixed(3))
  args.push(
    '-i', `http://127.0.0.1:${input.address().port}/${inputSecret}/${session.id}`,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', '192k', '-af', AUDIO_FILTER,
    // Original timestamps, never shifted, so segments from different runs fit together.
    // (Without the second option a run from the start shifts B-frame files by a few frames.)
    '-copyts', '-avoid_negative_ts', 'disabled',
    '-max_muxing_queue_size', '4096',
    '-f', 'segment', '-segment_format', 'mpegts',
    '-segment_start_number', String(n),
    '-segment_list', list, '-segment_list_type', 'csv'
  )
  // Cut at the first keyframe at or after each start (the small margin absorbs rounding).
  if (n + 1 < starts.length) args.push('-segment_times', starts.slice(n + 1).map(t => (t - 0.05).toFixed(3)).join(','))
  args.push(path.join(session.dir, `${runId}-%d.ts`))

  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  const run = { proc, id: runId, start: n, produced: n - 1, paused: false, exited: false, stderr: '', poll: null, listed: 0 }
  session.run = run
  proc.stderr.on('data', d => { run.stderr = (run.stderr + d).slice(-2000) })
  proc.on('error', err => { run.stderr += err.message })
  proc.on('exit', code => {
    run.exited = true
    collect(session, run, list)
    clearInterval(run.poll)
    if (code && session.run === run) {
      console.warn(`[convert] ffmpeg exited with code ${code} at segment ${run.produced + 1}: ${oneLine(run.stderr).slice(-300)}`)
    }
    if (session.run === run) {
      session.run = null
      for (const w of session.waiters) w(null)
    }
  })
  // Finished segments appear in the CSV list; move them to their final name.
  run.poll = setInterval(() => collect(session, run, list), 250)
  run.poll.unref()
}

function collect (session, run, list) {
  let text
  try { text = fs.readFileSync(list, 'utf8') } catch { return }
  const lines = text.split('\n').filter(Boolean)
  for (const line of lines.slice(run.listed)) {
    const m = line.match(/^[0-9a-f]+-(\d+)\.ts,/)
    if (!m) continue
    const n = Number(m[1])
    try {
      fs.renameSync(path.join(session.dir, `${run.id}-${n}.ts`), path.join(session.dir, `${n}.ts`))
      session.done.add(n)
      run.produced = Math.max(run.produced, n)
    } catch {}
  }
  run.listed = lines.length
  for (const w of session.waiters) w(true)
  throttle(session)
}

// Pause ffmpeg when it is far enough ahead of the player, resume it when the player catches up.
function throttle (session) {
  const run = session.run
  if (!run || run.exited) return
  const ahead = run.produced - session.lastRequested
  if (!run.paused && ahead >= AHEAD_SEGMENTS) {
    run.paused = true
    run.proc.kill('SIGSTOP')
  } else if (run.paused && ahead < AHEAD_SEGMENTS) {
    run.paused = false
    run.proc.kill('SIGCONT')
  }
}

// Delete segments far from the player: behind it, and leftovers of abandoned runs ahead.
function prune (session) {
  for (const n of [...session.done]) {
    if (n < session.lastRequested - KEEP_BEHIND_SEGMENTS || n > session.lastRequested + AHEAD_SEGMENTS * 2) {
      session.done.delete(n)
      fs.rm(path.join(session.dir, `${n}.ts`), { force: true }, () => {})
    }
  }
}

// ---- Requests

export function playlist (session, query = '') {
  const { starts, duration } = session
  const lengths = starts.map((t, i) => (i + 1 < starts.length ? starts[i + 1] : duration) - t)
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...lengths))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS'
  ]
  lengths.forEach((len, i) => lines.push(`#EXTINF:${Math.max(len, 0.001).toFixed(3)},`, `${i}.ts${query}`))
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

// Path of segment n once it is converted, or null after `ms` (the caller redirects the player
// so it waits with a fresh timeout). Starts or restarts ffmpeg as needed.
export async function segment (session, n, ms, signal) {
  if (!Number.isInteger(n) || n < 0 || n >= session.starts.length) return undefined
  touch(session)
  session.lastRequested = n
  prune(session)
  const file = path.join(session.dir, `${n}.ts`)
  if (session.done.has(n)) {
    throttle(session)
    return file
  }
  const run = session.run
  const coming = run && !run.exited && n >= run.start && n <= run.produced + 1 + WAIT_SEGMENTS
  if (!coming) startRun(session, n)
  throttle(session)

  const deadline = Date.now() + ms
  let retried = false
  while (!session.done.has(n)) {
    if (signal?.aborted || !sessions.has(session.key)) return null
    const left = deadline - Date.now()
    if (left <= 0) return null
    touch(session)
    const result = await new Promise(resolve => {
      const timer = setTimeout(() => done(true), left)
      const done = v => { clearTimeout(timer); session.waiters.delete(done); resolve(v) }
      session.waiters.add(done)
    })
    // ffmpeg ended without this segment: try once more, starting at it.
    if (result === null && !session.done.has(n)) {
      if (retried || !sessions.has(session.key)) throw new Error(`Conversion failed at segment ${n}`)
      retried = true
      startRun(session, n)
    }
  }
  return file
}

export const conversionInfo = () => ({ limit: conversionAvailable() ? config.audioConversions : 0, ffmpeg: ffmpegAvailable, active: conversionStatus() })

export function conversionStatus () {
  return [...sessions.values()].map(s => ({
    user: s.user,
    infoHash: s.infoHash,
    file: s.file?.name || null,
    ready: Boolean(s.starts),
    segment: s.lastRequested,
    segments: s.starts?.length || 0,
    converted: s.run ? s.run.produced + 1 : null,
    paused: Boolean(s.run?.paused),
    running: Boolean(s.run && !s.run.exited)
  }))
}

// Conversion folders of a previous run are removed with the rest of DOWNLOAD_PATH at startup.
fs.mkdirSync(root, { recursive: true })
