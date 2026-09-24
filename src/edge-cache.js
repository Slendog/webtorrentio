import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { stateDir } from './paths.js'

// Persistent cache of the parts of a video a player reads before it starts: the first
// PREFETCH_HEAD_MB (container header) and last PREFETCH_TAIL_MB (seek index) of every file that
// was played, plus the torrent's metadata. When a cached torrent is opened again, even after a
// restart, the metadata is known at once and those pieces are served from disk. WebTorrent
// re-checks every restored piece against the torrent's hashes, so a damaged cache file is
// simply downloaded again. Total size is capped at EDGE_CACHE_MB (at most 500 MB); the least
// recently used torrents are dropped first.
//
// Layout: state/edge-cache/<infoHash>/{meta.json, torrent, <piece>.piece}

const root = path.join(stateDir, 'edge-cache')
const index = new Map() // infoHash -> { bytes, lastUsed, meta }

const dirOf = infoHash => path.join(root, infoHash)

function dirSize (dir) {
  let total = 0
  for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size
  return total
}

function readMeta (infoHash) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(infoHash), 'meta.json'), 'utf8'))
  } catch {
    return null
  }
}

function writeMeta (infoHash, meta) {
  fs.writeFileSync(path.join(dirOf(infoHash), 'meta.json'), JSON.stringify(meta))
}

function remove (infoHash) {
  fs.rmSync(dirOf(infoHash), { recursive: true, force: true })
  index.delete(infoHash)
}

export function edgeCacheUsage () {
  let bytes = 0
  for (const e of index.values()) bytes += e.bytes
  return { bytes, limit: config.edgeCacheBytes, torrents: index.size }
}

// Drop least recently used torrents until the cache fits its limit.
function enforceLimit () {
  const byAge = [...index.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [infoHash] of byAge) {
    if (edgeCacheUsage().bytes <= config.edgeCacheBytes) break
    remove(infoHash)
  }
}

// Load the index at startup; drop broken entries.
function init () {
  if (!config.edgeCacheBytes) return
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  for (const infoHash of fs.readdirSync(root)) {
    if (!/^[a-f0-9]{40}$/.test(infoHash)) {
      fs.rmSync(path.join(root, infoHash), { recursive: true, force: true })
      continue
    }
    const meta = readMeta(infoHash)
    if (!meta || !fs.existsSync(path.join(dirOf(infoHash), 'torrent'))) {
      remove(infoHash)
      continue
    }
    index.set(infoHash, { bytes: dirSize(dirOf(infoHash)), lastUsed: meta.lastUsed || 0, meta })
  }
  enforceLimit()
  const { bytes, torrents } = edgeCacheUsage()
  if (torrents) console.log(`[edge-cache] ${torrents} torrent(s), ${(bytes / 1024 ** 2).toFixed(0)} MB of ${(config.edgeCacheBytes / 1024 ** 2).toFixed(0)} MB`)
}
init()

// Pieces covering the head and tail of a file.
export function edgePieces (file, pieceLength) {
  const head = Math.min(config.prefetchHeadBytes, file.length)
  const tail = Math.min(config.prefetchTailBytes, file.length)
  const pieces = new Set()
  const add = (from, to) => {
    for (let i = Math.floor(from / pieceLength); i <= Math.floor(to / pieceLength); i++) pieces.add(i)
  }
  if (head) add(file.offset, file.offset + head - 1)
  if (tail) add(file.offset + file.length - tail, file.offset + file.length - 1)
  return pieces
}

// Save the edges of the played files of a torrent that is about to be removed.
// `store` is the torrent's PieceStore (pieces on disk), `played` the paths of played files.
export function edgeCacheSave (torrent, store, played) {
  if (!config.edgeCacheBytes || !torrent?.ready || !torrent.torrentFile || !store || !played.size) return
  const infoHash = torrent.infoHash
  const wanted = new Set()
  for (const file of torrent.files) {
    if (played.has(file.path)) for (const i of edgePieces(file, torrent.pieceLength)) wanted.add(i)
  }
  const present = [...wanted].filter(i => store.has(i))
  if (!present.length) return

  // One torrent alone must fit comfortably; otherwise it would evict everything else.
  const size = present.reduce((n, i) => n + store.pieces.get(i), 0) + torrent.torrentFile.length
  if (size > config.edgeCacheBytes / 2) return

  const dir = dirOf(infoHash)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const i of present) {
    const target = path.join(dir, `${i}.piece`)
    if (!fs.existsSync(target)) fs.copyFileSync(store._file(i), target)
  }
  fs.writeFileSync(path.join(dir, 'torrent'), torrent.torrentFile)
  const old = readMeta(infoHash)
  const meta = {
    name: torrent.name,
    pieceLength: torrent.pieceLength,
    files: torrent.files.map(f => ({ path: f.path, name: f.name, length: f.length, offset: f.offset })),
    played: [...new Set([...(old?.played || []), ...played])],
    lastUsed: Date.now()
  }
  writeMeta(infoHash, meta)
  index.set(infoHash, { bytes: dirSize(dir), lastUsed: meta.lastUsed, meta })
  enforceLimit()
  if (index.has(infoHash)) {
    console.log(`[edge-cache] saved ${present.length} piece(s) of ${torrent.name}; cache ${(edgeCacheUsage().bytes / 1024 ** 2).toFixed(0)} MB`)
  }
}

// If the torrent is cached, copy its edge pieces into `targetDir` (the new torrent's folder)
// and return its metadata file, so WebTorrent can start without asking peers for it.
export function edgeCacheRestore (infoHash, targetDir) {
  const entry = index.get(infoHash)
  if (!entry) return null
  try {
    const dir = dirOf(infoHash)
    const torrentFile = fs.readFileSync(path.join(dir, 'torrent'))
    fs.mkdirSync(targetDir, { recursive: true })
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.piece')) fs.copyFileSync(path.join(dir, f), path.join(targetDir, f))
    }
    entry.lastUsed = entry.meta.lastUsed = Date.now()
    writeMeta(infoHash, entry.meta)
    return torrentFile
  } catch (err) {
    console.warn(`[edge-cache] cannot restore ${infoHash.slice(0, 8)}: ${err.message}`)
    remove(infoHash)
    return null
  }
}

// File list of a cached torrent, for stream hints before the torrent is opened.
export const edgeCacheFiles = infoHash => index.get(infoHash)?.meta.files || null
