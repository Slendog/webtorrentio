import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import WebTorrent from 'webtorrent'
import { config } from './config.js'
import { edgeCacheFiles, edgeCacheRestore, edgeCacheSave, edgeCacheUsage, edgePieces } from './edge-cache.js'
import { magnetUri, pickFile } from './parse.js'
import { installPeerGuard, isGuarded } from './peer-guard.js'
import { PieceStore } from './piece-store.js'
import { oneLine } from './logbuffer.js'
import { getScraped } from './registry.js'
import { fatal } from './runtime.js'
import { onChange } from './settings.js'

const READY_TIMEOUT_MS = 60_000

installPeerGuard()

const client = new WebTorrent({
  maxConns: config.maxConns,
  torrentPort: config.torrentPort,
  dhtPort: config.dhtPort
})
// WebTorrent destroys its client on any error it emits (for example a port that is already in
// use). A server without a client can only fail later, so stop now with the reason.
client.on('error', err => {
  const hint = err.code === 'EADDRINUSE' ? ' Another program uses the port: change TORRENT_PORT / DHT_PORT, or stop the other program.' : ''
  fatal(`[webtorrent] fatal: ${err.message || err}.${hint} Stopping.`)
})
let unguardedWarned = false
client.on('torrent', torrent => torrent.on('wire', wire => {
  if (!unguardedWarned && !isGuarded(wire)) {
    unguardedWarned = true
    console.warn('[peer] WebTorrent uses another copy of bittorrent-protocol than the guarded one; hostile peers may crash the server. Run `npm ls bittorrent-protocol`.')
  }
}))
fs.mkdirSync(config.downloadPath, { recursive: true })
cleanDownloadPath()

// Delete data left behind by a crash. Only runs on a folder this addon created (marker file)
// or an empty one, so a misconfigured DOWNLOAD_PATH never wipes unrelated files.
function cleanDownloadPath () {
  const marker = path.join(config.downloadPath, '.stremio-webtorrent')
  const items = fs.readdirSync(config.downloadPath)
  if (items.length && !items.includes('.stremio-webtorrent')) {
    console.warn(`[webtorrent] ${config.downloadPath} is not empty and has no marker file; leftover data is not cleaned`)
    return
  }
  for (const item of items) {
    if (item === '.stremio-webtorrent') continue
    fs.rmSync(path.join(config.downloadPath, item), { recursive: true, force: true })
  }
  if (items.length > 1) console.log(`[webtorrent] removed ${items.length - 1} leftover item(s) from ${config.downloadPath}`)
  fs.writeFileSync(marker, 'Torrent cache of stremio-webtorrent-addon. Contents are deleted automatically.\n')
}

// Thrown when a hard limit refuses a new torrent. `status` is the HTTP status to answer with.
export class LimitError extends Error {
  constructor (message, status = 503) {
    super(message)
    this.status = status
  }
}

// infoHash -> {
//   torrent, ready: Promise, connections: open HTTP connections reading the torrent (players
//   often open several at once to probe a file, so not every connection is someone watching),
//   files: path -> open connections, users: user -> open connections, pending: user -> requests waiting for metadata,
//   readers: Set of { file, pos } (playback position of each open stream),
//   prefetch: true while nobody has asked to play it yet (see prefetch()),
//   warmup: [{ from, to }] piece ranges downloaded ahead of the first request,
//   idleTimer, addedAt, lastUsed
// }
const entries = new Map()

const bump = (map, key, by) => {
  const n = (map.get(key) || 0) + by
  if (n > 0) map.set(key, n)
  else map.delete(key)
}

const isIdle = entry => entry.connections === 0 && entry.pending.size === 0 && entry.kept === 0
const usedBy = (entry, user) => entry.users.has(user) || entry.pending.has(user)

function scheduleIdle (entry) {
  clearTimeout(entry.idleTimer)
  if (!isIdle(entry)) return
  const timeout = entry.prefetch ? (entry.prefetchTtlMs || config.prefetchTtlMs) : config.idleTimeoutMs
  const wait = Math.max(0, entry.lastUsed + timeout - Date.now())
  entry.idleTimer = setTimeout(() => removeTorrent(entry.infoHash), wait)
}

// One folder per info hash: torrents often share a name, and WebTorrent names folders after it.
// A new folder every time a torrent is added: removing a torrent deletes its folder in the
// background, which must not hit a newer copy of the same torrent (restored from the edge cache).
let addSeq = 0
const newTorrentDir = infoHash => path.join(config.downloadPath, `${infoHash}-${Date.now().toString(36)}${++addSeq}`)

// Keep the header and index pieces of played files for next time (see edge-cache.js).
function saveEdges (entry) {
  try {
    edgeCacheSave(entry.torrent, PieceStore.byInfoHash.get(entry.infoHash), entry.played)
  } catch (err) {
    console.warn(`[edge-cache] cannot save ${entry.infoHash.slice(0, 8)}: ${err.message}`)
  }
}

// Limits changed at runtime: restart idle timers (new timeout) and resize readahead windows.
onChange(() => {
  for (const e of entries.values()) {
    scheduleIdle(e)
    updateReadahead(e)
  }
})

function removeTorrent (infoHash) {
  const entry = entries.get(infoHash)
  if (!entry) return
  clearTimeout(entry.idleTimer)
  entries.delete(infoHash)
  console.log(`[webtorrent] removing ${infoHash}`)
  saveEdges(entry)
  client.remove(infoHash, { destroyStore: true }, err => {
    if (err) console.warn(`[webtorrent] remove ${infoHash}: ${err.message}`)
    fs.rm(entry.dir, { recursive: true, force: true }, () => {})
  })
}

const CHUNK_BYTES = 16 * 1024 ** 2
// Data just behind the playback position is kept, so short rewinds do not re-download.
const KEEP_BEHIND_BYTES = 32 * 1024 ** 2
// Smallest window a viewer needs: kept data behind, the slice being read, and one slice ahead.
const MIN_WINDOW_BYTES = KEEP_BEHIND_BYTES + 2 * CHUNK_BYTES
// Share of the budget handed out as viewer windows; the rest absorbs pieces in flight.
const BUDGET_SHARE = 0.8

const allReaders = () => [...entries.values()].reduce((n, e) => n + e.readers.size, 0)

// Bytes of torrent data on disk.
export function diskUsage () {
  let total = 0
  for (const infoHash of entries.keys()) total += PieceStore.byInfoHash.get(infoHash)?.bytes || 0
  return total
}

// Room per viewer inside a budget, after the kept data behind and the slice being read.
const windowRoom = (budget, viewers) => budget * BUDGET_SHARE / Math.max(1, viewers) - KEEP_BEHIND_BYTES - CHUNK_BYTES

// READAHEAD_MB for a torrent's viewers, shrunk so every window fits in both the total budget
// (MAX_DISK_GB, split across all viewers) and the torrent's own budget (MAX_DISK_PER_STREAM_MB).
function effectiveReadahead (entry) {
  let readahead = config.readaheadBytes
  if (config.maxDiskBytes) readahead = Math.min(readahead, windowRoom(config.maxDiskBytes, allReaders()))
  if (config.maxDiskPerStreamBytes && entry) {
    readahead = Math.min(readahead, windowRoom(config.maxDiskPerStreamBytes, entry.readers.size))
  }
  return Math.max(CHUNK_BYTES, readahead)
}

// Piece ranges of a torrent that must stay on disk: around each viewer's playback position.
function protectedWindows (entry, readahead) {
  const pl = entry.torrent.pieceLength
  return [...entry.readers].map(r => {
    const at = r.file.offset + r.pos
    return {
      from: Math.max(0, Math.floor((at - KEEP_BEHIND_BYTES) / pl)),
      to: Math.floor(Math.max(r.file.offset + r.sliceEnd, at + readahead) / pl),
      at: Math.floor(at / pl)
    }
  })
}

// Delete pieces of the given torrents outside their viewers' windows until `over` bytes are
// freed. Already watched pieces go first, then pieces far ahead (left over from seeks).
// Deleted pieces are downloaded again if a viewer seeks back to them.
function evictPieces (list, over) {
  const candidates = []
  for (const entry of list) {
    const store = PieceStore.byInfoHash.get(entry.infoHash)
    if (!store || !entry.torrent.ready || entry.torrent.destroyed) continue
    const windows = protectedWindows(entry, effectiveReadahead(entry))
    // Header and index pieces of played files stay, so the edge cache can keep them.
    const edges = new Set()
    if (config.edgeCacheBytes) {
      for (const f of entry.torrent.files) if (entry.played.has(f.path)) for (const i of edgePieces(f, entry.torrent.pieceLength)) edges.add(i)
    }
    for (const [index, size] of store.pieces) {
      if (edges.has(index) || windows.some(w => index >= w.from && index <= w.to)) continue
      // Distance to the nearest viewer; pieces behind a viewer count double, so they go first.
      const distance = windows.length
        ? Math.min(...windows.map(w => index < w.at ? (w.at - index) * 2 : index - w.at))
        : Infinity
      candidates.push({ entry, store, index, size, distance })
    }
  }
  candidates.sort((a, b) => b.distance - a.distance)
  for (const c of candidates) {
    if (over <= 0) break
    c.store.del(c.index)
    // Private WebTorrent API: marks the piece as missing so it is fetched again when needed.
    c.entry.torrent._markUnverified(c.index)
    over -= c.size
  }
}

// Keep torrent data within the disk budgets:
// 1. each torrent within MAX_DISK_PER_STREAM_MB, by deleting its own far-away pieces;
// 2. the total within MAX_DISK_GB, by removing idle torrents (least recently used first),
//    then deleting far-away pieces of active torrents.
function enforceDiskBudget () {
  if (config.maxDiskPerStreamBytes) {
    for (const entry of entries.values()) {
      const used = PieceStore.byInfoHash.get(entry.infoHash)?.bytes || 0
      if (used > config.maxDiskPerStreamBytes) evictPieces([entry], used - config.maxDiskPerStreamBytes)
    }
  }
  if (!config.maxDiskBytes) return
  // Prefetched torrents nobody played go first, then idle ones, least recently used first.
  const idle = [...entries.values()].filter(isIdle).sort((a, b) => b.prefetch - a.prefetch || a.lastUsed - b.lastUsed)
  for (const e of idle) {
    if (diskUsage() <= config.maxDiskBytes) return
    console.log(`[webtorrent] disk budget reached, removing idle ${e.infoHash}`)
    removeTorrent(e.infoHash)
  }
  const over = diskUsage() - config.maxDiskBytes
  if (over > 0) evictPieces([...entries.values()], over)
}

let lastBudgetWarning = 0
// Always running: disk limits can be switched on from the TUI while the server runs.
{
  setInterval(() => {
    enforceDiskBudget()
    const used = diskUsage()
    if (config.maxDiskBytes && used > config.maxDiskBytes * 1.1 && Date.now() - lastBudgetWarning > 60_000) {
      lastBudgetWarning = Date.now()
      console.warn(`[webtorrent] disk budget exceeded: ${(used / 1024 ** 3).toFixed(2)} GB of ${(config.maxDiskBytes / 1024 ** 3).toFixed(2)} GB`)
    }
  }, 1000).unref()
}

// Prefetched torrents nobody has played yet do not take a torrent slot.
const usedSlots = () => [...entries.values()].filter(e => !e.prefetch).length

function checkLimits (infoHash, user) {
  const others = [...entries.values()].filter(e => e.infoHash !== infoHash && usedBy(e, user))
  if (others.length >= config.maxTorrentsPerUser) {
    throw new LimitError(`Limit reached: you are already streaming ${others.length} torrent(s). Stop one first.`, 429)
  }
  const existing = entries.get(infoHash)
  if (existing) {
    // Another viewer of a running torrent: the torrent's own budget must fit one more window.
    if (config.maxDiskPerStreamBytes && windowRoom(config.maxDiskPerStreamBytes, existing.readers.size + 1) < CHUNK_BYTES) {
      throw new LimitError('Too many viewers for this torrent: MAX_DISK_PER_STREAM_MB is too small for another one.', 507)
    }
    return
  }

  // Every viewer needs a minimum window on disk; refuse when one more would not fit.
  if (config.maxDiskBytes && config.maxDiskBytes * BUDGET_SHARE / (allReaders() + 1) < MIN_WINDOW_BYTES) {
    throw new LimitError('Disk cache full: MAX_DISK_GB is too small for another stream. Try again later.', 507)
  }
  if (usedSlots() < config.maxActiveTorrents) return

  // Make room by dropping the least recently used idle torrents.
  const idle = [...entries.values()].filter(e => isIdle(e) && !e.prefetch).sort((a, b) => a.lastUsed - b.lastUsed)
  for (const e of idle) {
    if (usedSlots() < config.maxActiveTorrents) break
    removeTorrent(e.infoHash)
  }
  if (usedSlots() >= config.maxActiveTorrents) {
    throw new LimitError(`Server busy: all ${config.maxActiveTorrents} torrent slots are in use. Try again later.`)
  }
}

function getTorrent (infoHash) {
  let entry = entries.get(infoHash)
  if (!entry) {
    const dir = newTorrentDir(infoHash)
    // From the edge cache: metadata without asking peers, and header/index pieces on disk.
    const cachedTorrent = edgeCacheRestore(infoHash, dir)
    if (cachedTorrent) console.log(`[edge-cache] ${infoHash.slice(0, 8)} restored: metadata and header/index pieces from cache`)
    const torrent = client.add(cachedTorrent || magnetUri(infoHash), {
      path: dir,
      store: PieceStore,
      destroyStoreOnDestroy: true,
      // Download nothing until a file stream asks for pieces.
      deselect: true
    })
    entry = {
      infoHash,
      torrent,
      dir,
      played: new Set(),
      connections: 0,
      files: new Map(),
      users: new Map(),
      pending: new Map(),
      readers: new Set(),
      prefetch: false,
      warmup: [],
      holds: new Map(),
      kept: 0,
      idleTimer: null,
      addedAt: Date.now(),
      lastUsed: Date.now()
    }
    entry.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out fetching torrent metadata (no peers?)')), READY_TIMEOUT_MS)
      const done = () => { clearTimeout(timer); resolve(torrent) }
      if (torrent.ready) done()
      else torrent.once('ready', done)
      torrent.once('error', err => { clearTimeout(timer); reject(err) })
    })
    entry.ready.catch(() => removeTorrent(infoHash))
    entries.set(infoHash, entry)
  }
  entry.lastUsed = Date.now()
  return entry
}

export async function resolveFile (infoHash, fileIdx, season, episode, user) {
  infoHash = infoHash.toLowerCase()
  checkLimits(infoHash, user)
  const entry = getTorrent(infoHash)
  if (entry.prefetch) console.log(`[prefetch] ${infoHash.slice(0, 8)} used by ${user}${entry.torrent.ready ? ' (metadata was ready)' : ''}`)
  entry.prefetch = false
  entry.nextEpisode = false
  clearTimeout(entry.idleTimer)
  bump(entry.pending, user, 1)
  try {
    const torrent = await entry.ready
    const idx = fileIdx === 'auto' || fileIdx == null
      ? pickFile(torrent.files, season, episode)
      : Number(fileIdx)
    const file = torrent.files[idx]
    if (!file) throw new Error('No playable file found in torrent')
    return { entry, torrent, file, idx }
  } finally {
    bump(entry.pending, user, -1)
    scheduleIdle(entry)
  }
}

// Keep one normal (non-stream) selection per open stream: from its playback position to
// READAHEAD_MB ahead. Recomputed for the whole torrent so viewers do not clobber each other.
function updateReadahead (entry) {
  const { torrent } = entry
  if (!torrent.ready || torrent.destroyed) return
  const last = torrent.pieces.length - 1
  const readahead = effectiveReadahead(entry)
  torrent.deselect(0, last)
  for (const w of entry.warmup) torrent.select(w.from, Math.min(w.to, last), 0)
  const now = Date.now()
  for (const [key, h] of entry.holds) {
    if (h.expires < now) entry.holds.delete(key)
    else torrent.select(h.from, Math.min(h.to, last), 1)
  }
  for (const r of entry.readers) {
    const fileEnd = r.file.offset + r.file.length - 1
    const from = Math.floor((r.file.offset + r.pos) / torrent.pieceLength)
    const to = Math.floor(Math.min(r.file.offset + r.pos + readahead, fileEnd) / torrent.pieceLength)
    if (from <= to) torrent.select(Math.min(from, last), Math.min(to, last), 0)
  }
}

// Reads the file in 16 MB slices. A single WebTorrent read stream would select every piece
// up to its end byte, which downloads the rest of the file; slices plus the readahead window
// keep downloads close to the playback position.
// A Readable subclass rather than an async generator: a generator cannot be stopped while it
// waits for a missing piece, so destroy() would hang and the stream would never close.
class SliceStream extends Readable {
  constructor (entry, reader, start, end) {
    super()
    this.entry = entry
    this.reader = reader
    this.next = start
    this.end = end
    this.slice = null
  }

  _read () {
    if (this.slice) return this.slice.resume()
    if (this.next > this.end || this.entry.torrent.destroyed) return this.push(null)

    const from = this.next
    const to = Math.min(from + CHUNK_BYTES - 1, this.end)
    this.next = to + 1
    this.reader.pos = from
    this.reader.sliceEnd = to
    // Viewer count changes the readahead of every torrent, so refresh them all.
    for (const e of entries.values()) updateReadahead(e)

    // WebTorrent treats `end: 0` as "no end" and would read the whole file, so a request for
    // byte 0 alone reads two bytes. `left` trims whatever comes back beyond the slice.
    const file = this.reader.file
    const readEnd = to === 0 ? Math.min(1, file.length - 1) : to
    let left = to - from + 1
    const slice = this.slice = file.createReadStream({ start: from, end: readEnd })
    const finish = () => {
      if (this.slice !== slice) return
      this.slice = null
      if (!this.destroyed) this._read()
    }
    slice.on('data', buf => {
      if (left <= 0) return
      if (buf.length > left) buf = buf.subarray(0, left)
      left -= buf.length
      this.reader.pos += buf.length
      this.reader.bytesRead += buf.length
      const more = this.push(buf)
      if (left <= 0) {
        slice.destroy()
        return finish()
      }
      if (!more) slice.pause()
    })
    slice.on('end', finish)
    slice.on('error', err => this.destroy(err))
  }

  _destroy (err, cb) {
    this.slice?.destroy()
    this.slice = null
    cb(err)
  }
}

// ---- Activity log: one line when someone starts watching a file, one when they stop.
//
// Players open many short connections (probes, seeks), so a "watch" is one user and one file
// across all their connections: it starts once they have read WATCHING_MIN_BYTES (a probe
// stays below that) and ends WATCH_END_MS after their last connection to the file closed.
// `via` says how: "WebTorrent" (/play), "Stereo" (conversion) or "room <id>".

const WATCH_END_MS = 60_000
const watches = new Map() // user \n infoHash \n file path -> watch

const minutes = ms => ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`

function trackWatch (entry, file, user, via, stream, start) {
  const key = `${user}\n${entry.infoHash}\n${file.path}`
  let w = watches.get(key)
  if (!w) {
    w = { user, via, open: 0, bytes: 0, startedAt: null, firstPos: start, endTimer: null }
    watches.set(key, w)
  }
  clearTimeout(w.endTimer)
  w.open++
  stream.on('data', buf => {
    w.bytes += buf.length
    if (!w.startedAt && w.bytes >= WATCHING_MIN_BYTES) {
      w.startedAt = Date.now()
      const scraped = getScraped(entry.infoHash)
      const at = w.firstPos > file.length * 0.01 ? ` at ${(w.firstPos / file.length * 100).toFixed(0)}%` : ''
      console.log(`[watch] ${user} started ${oneLine(file.name)}${at} via ${w.via}` +
        `${scraped?.quality ? ` (${scraped.quality})` : ''} [${entry.infoHash.slice(0, 8)}]`)
    }
  })
  stream.once('close', () => {
    if (--w.open > 0) return
    w.endTimer = setTimeout(() => {
      if (w.open > 0) return
      watches.delete(key)
      if (!w.startedAt) return
      const took = Date.now() - WATCH_END_MS - w.startedAt
      console.log(`[watch] ${user} stopped ${oneLine(file.name)} after ${minutes(Math.max(0, took))}, ` +
        `${(w.bytes / 1024 ** 2).toFixed(0)} MB read via ${w.via} [${entry.infoHash.slice(0, 8)}]`)
    }, WATCH_END_MS)
    w.endTimer.unref()
  })
}

export function openStream (entry, file, start, end, user, { season, episode, via } = {}) {
  const reader = { file, user, season, episode, pos: start, sliceEnd: start, bytesRead: 0, openedAt: Date.now() }
  entry.played.add(file.path)
  entry.readers.add(reader)
  const stream = new SliceStream(entry, reader, start, end)
  if (via) trackWatch(entry, file, user, via, stream, start)

  entry.connections++
  bump(entry.files, file.path, 1)
  bump(entry.users, user, 1)
  clearTimeout(entry.idleTimer)
  stream.once('close', () => {
    entry.connections--
    entry.readers.delete(reader)
    bump(entry.files, file.path, -1)
    bump(entry.users, user, -1)
    entry.lastUsed = Date.now()
    updateReadahead(entry)
    scheduleIdle(entry)
  })
  return stream
}

// Load a torrent that is likely to be played next: metadata first, then the first and last
// megabytes of the file that would play (players read the header, and for MKV/MP4 often the
// index at the end, before anything else). Players give up when these take too long, which
// happens on networks with few peers. Unused prefetched torrents expire after PREFETCH_TTL_MS.
// Download the first and last megabytes of the file that would play for season/episode, so a
// player's first requests (header, and often the index at the end) are answered at once.
function warmFile (entry, season, episode) {
  entry.ready.then(torrent => {
    if (torrent.destroyed || !entries.has(entry.infoHash)) return
    const file = torrent.files[pickFile(torrent.files, season, episode)]
    if (!file) return
    const pl = torrent.pieceLength
    const head = Math.min(config.prefetchHeadBytes, file.length)
    const tail = Math.min(config.prefetchTailBytes, file.length)
    entry.warmup.push(...[
      head && { from: Math.floor(file.offset / pl), to: Math.floor((file.offset + head - 1) / pl) },
      tail && { from: Math.floor((file.offset + file.length - tail) / pl), to: Math.floor((file.offset + file.length - 1) / pl) }
    ].filter(Boolean))
    updateReadahead(entry)
    console.log(`[prefetch] ${entry.infoHash.slice(0, 8)} ready, warming up ${oneLine(file.name)}`)
  }, () => {})
}

// Load a torrent that is likely to be played next: metadata first, then the first and last
// megabytes of the file that would play (players read the header, and for MKV/MP4 often the
// index at the end, before anything else). Players give up when these take too long, which
// happens on networks with few peers. Unused prefetched torrents expire after PREFETCH_TTL_MS,
// or `ttlMs`. `nextEpisode` marks a prefetch for the next episode of a show being watched: it
// runs even with list prefetch off, is not pushed out by PREFETCH_MAX, and when the torrent is
// already running (a season pack) it only warms up the episode's file.
export function prefetch (infoHash, { season, episode, ttlMs, nextEpisode = false } = {}) {
  infoHash = infoHash.toLowerCase()
  if (!config.prefetchCount && !nextEpisode) return
  const running = entries.get(infoHash)
  if (running) {
    if (nextEpisode) warmFile(running, season, episode)
    return
  }
  if (config.maxDiskBytes && diskUsage() >= config.maxDiskBytes * BUDGET_SHARE) return

  // Keep at most PREFETCH_MAX list prefetches; the oldest unused one makes room.
  const prefetched = [...entries.values()].filter(e => e.prefetch && !e.nextEpisode).sort((a, b) => a.addedAt - b.addedAt)
  while (!nextEpisode && prefetched.length >= config.prefetchMax) removeTorrent(prefetched.shift().infoHash)

  const entry = getTorrent(infoHash)
  entry.prefetch = true
  entry.nextEpisode = nextEpisode
  entry.prefetchTtlMs = ttlMs
  scheduleIdle(entry)
  warmFile(entry, season, episode)
}

// Connections that are watching an episode: long enough reads (not a player's probe) of a
// series file, with how far they are into it.
export function episodeViewers () {
  const list = []
  for (const entry of entries.values()) {
    for (const r of entry.readers) {
      if (r.season == null || r.episode == null || r.bytesRead < WATCHING_MIN_BYTES) continue
      list.push({ user: r.user, infoHash: entry.infoHash, season: r.season, episode: r.episode, fraction: r.pos / r.file.length })
    }
  }
  return list
}

// Keep a torrent from going idle while something other than an HTTP stream needs it (an audio
// conversion between two reads). Returns the function that releases it again.
export function keepTorrent (entry) {
  entry.kept++
  clearTimeout(entry.idleTimer)
  let released = false
  return () => {
    if (released) return
    released = true
    entry.kept--
    entry.lastUsed = Date.now()
    scheduleIdle(entry)
  }
}

// Bytes start..end (inclusive) of a file, downloaded on demand like a stream.
export function readRange (entry, file, start, end, user) {
  return new Promise((resolve, reject) => {
    const parts = []
    const stream = openStream(entry, file, start, end, user)
    stream.on('data', buf => parts.push(buf))
    stream.on('end', () => resolve(Buffer.concat(parts)))
    stream.on('error', reject)
    stream.on('close', () => reject(new Error('Torrent removed while reading')))
  })
}

export const isRemoved = entry => entry.torrent.destroyed || !entries.has(entry.infoHash)

// Returns "removed", "missing", or "busy" (someone else is streaming it).
export function removeByHash (infoHash, user) {
  const entry = entries.get(infoHash)
  if (!entry) return 'missing'
  if ([...entry.users.keys(), ...entry.pending.keys()].some(u => u !== user)) return 'busy'
  removeTorrent(infoHash)
  return 'removed'
}

// Wait until the piece holding byte `start` of `file` is downloaded, for at most `ms`.
// Meanwhile the piece (and the next one) are fetched with top priority, and keep being
// fetched for a minute after a timeout, so a redirected player finds them sooner.
// Resolves true when the piece is there, false on timeout or when `signal` aborts.
export function waitForData (entry, file, start, ms, signal) {
  const { torrent } = entry
  const piece = Math.floor((file.offset + start) / torrent.pieceLength)
  if (torrent.bitfield?.get(piece)) return Promise.resolve(true)
  const last = Math.min(piece + 1, torrent.pieces.length - 1)
  entry.holds.set(piece, { from: piece, to: last, expires: Date.now() + 60_000 })
  updateReadahead(entry)
  torrent.critical(piece, last)
  return new Promise(resolve => {
    const done = ok => {
      clearTimeout(timer)
      torrent.removeListener('verified', onVerified)
      signal?.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onVerified = i => { if (i === piece) done(true) }
    const onAbort = () => done(false)
    const timer = setTimeout(() => done(Boolean(torrent.bitfield?.get(piece))), ms)
    torrent.on('verified', onVerified)
    signal?.addEventListener('abort', onAbort)
  })
}

// Open connections of one user across all torrents, plus requests still loading.
export function userConnections (user) {
  let n = 0
  for (const e of entries.values()) n += (e.users.get(user) || 0) + (e.pending.get(user) || 0)
  return n
}

// Admin removal from the TUI: stops the torrent even while people are watching it.
export function forceRemove (infoHash) {
  if (!entries.has(infoHash)) return false
  removeTorrent(infoHash)
  return true
}

// Bytes downloaded without gaps from a viewer's playback position onward.
function bufferedAhead (torrent, reader) {
  if (!torrent.bitfield) return 0
  const at = reader.file.offset + reader.pos
  const fileEnd = reader.file.offset + reader.file.length
  const last = Math.floor((fileEnd - 1) / torrent.pieceLength)
  let piece = Math.floor(at / torrent.pieceLength)
  while (piece <= last && torrent.bitfield.get(piece)) piece++
  return Math.max(0, Math.min(piece * torrent.pieceLength, fileEnd) - at)
}

function viewerStats (entry) {
  const readahead = effectiveReadahead(entry)
  return [...entry.readers].map(r => ({
    user: r.user,
    file: r.file.name,
    position: r.pos,
    length: r.file.length,
    bufferedAhead: bufferedAhead(entry.torrent, r),
    // What the readahead window can hold from here; less near the end of the file.
    target: Math.min(readahead, r.file.length - r.pos)
  }))
}

// A connection counts as someone watching once it has read this much. Players open short
// extra connections to read a file's header or index, and those stay below it.
const WATCHING_MIN_BYTES = 8 * 1024 ** 2

// Estimated playback time of every user watching the torrent, for watching together. It is
// the read position scaled by the runtime from Cinemeta, so it assumes a constant bitrate and
// runs ahead of the real playback by whatever the player has buffered.
function watchers (entry) {
  const runtimeSec = getScraped(entry.infoHash)?.runtimeSec
  const best = new Map()
  for (const r of entry.readers) {
    if (r.bytesRead < WATCHING_MIN_BYTES) continue
    const prev = best.get(r.user)
    if (!prev || r.bytesRead > prev.bytesRead) best.set(r.user, r)
  }
  const list = [...best.values()].map(r => {
    const fraction = r.pos / r.file.length
    return { user: r.user, fraction, positionSec: runtimeSec ? Math.round(fraction * runtimeSec) : null }
  })
  const lead = Math.max(0, ...list.map(w => w.positionSec ?? 0))
  for (const w of list) w.behindSec = w.positionSec == null ? null : lead - w.positionSec
  return { runtimeSec: runtimeSec || null, list: list.sort((a, b) => b.fraction - a.fraction) }
}

function torrentStats (entry) {
  const { infoHash, torrent, connections, files, users, addedAt, lastUsed } = entry
  const wires = torrent.wires || []
  const seeders = wires.filter(w => w.isSeeder).length
  const playing = [...files.keys()].map(path => {
    const f = torrent.files?.find(x => x.path === path)
    return f ? { name: f.name, length: f.length, progress: f.progress } : { name: path }
  })
  return {
    infoHash,
    name: torrent.name || getScraped(infoHash)?.name || infoHash,
    ready: Boolean(torrent.ready),
    connections,
    prefetched: entry.prefetch,
    users: [...users.keys()],
    playing,
    viewers: viewerStats(entry),
    watchers: watchers(entry),
    length: torrent.length || 0,
    progress: torrent.progress || 0,
    downloaded: torrent.downloaded || 0,
    onDisk: PieceStore.byInfoHash.get(infoHash)?.bytes || 0,
    readahead: effectiveReadahead(entries.get(infoHash)),
    uploaded: torrent.uploaded || 0,
    downloadSpeed: torrent.downloadSpeed || 0,
    uploadSpeed: torrent.uploadSpeed || 0,
    ratio: torrent.ratio || 0,
    timeRemaining: Number.isFinite(torrent.timeRemaining) ? torrent.timeRemaining : null,
    peers: { connected: wires.length, seeders, leechers: wires.length - seeders },
    scraped: getScraped(infoHash) || null,
    addedAt,
    lastUsed,
    removesAt: connections === 0 ? lastUsed + (entry.prefetch ? (entry.prefetchTtlMs || config.prefetchTtlMs) : config.idleTimeoutMs) : null,
    nextEpisode: Boolean(entry.nextEpisode)
  }
}

export function status (user) {
  return {
    user,
    downloadSpeed: client.downloadSpeed,
    uploadSpeed: client.uploadSpeed,
    maxActiveTorrents: config.maxActiveTorrents,
    usedSlots: usedSlots(),
    maxTorrentsPerUser: config.maxTorrentsPerUser,
    disk: { used: diskUsage(), limit: config.maxDiskBytes || null, perStreamLimit: config.maxDiskPerStreamBytes || null },
    edgeCache: edgeCacheUsage(),
    idleTimeoutMs: config.idleTimeoutMs,
    torrents: [...entries.values()].map(torrentStats)
  }
}

export async function shutdown () {
  for (const entry of entries.values()) saveEdges(entry)
  await new Promise(resolve => client.destroy(() => resolve()))
  for (const entry of entries.values()) fs.rmSync(entry.dir, { recursive: true, force: true })
}

// Name and size of the file that would play, when the torrent's file list is known (running
// or in the edge cache). Used for Stremio's filename/videoSize stream hints.
export function knownFile (infoHash, season, episode) {
  const running = entries.get(infoHash)?.torrent
  const files = running?.ready ? running.files.map(f => ({ name: f.name, path: f.path, length: f.length })) : edgeCacheFiles(infoHash)
  if (!files) return null
  const file = files[pickFile(files, season, episode)]
  return file ? { filename: file.name, videoSize: file.length } : null
}
