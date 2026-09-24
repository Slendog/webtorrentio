import fs from 'node:fs'
import path from 'node:path'

// Chunk store for WebTorrent (abstract-chunk-store interface) that keeps every piece in its
// own file. Unlike the default store, single pieces can be deleted again, which is what lets
// the disk budget roll: already watched pieces are dropped to make room for new ones.
export class PieceStore {
  static byInfoHash = new Map()

  constructor (chunkLength, opts = {}) {
    this.chunkLength = Number(chunkLength)
    this.dir = opts.path
    this.infoHash = opts.torrent?.infoHash
    this.pieces = new Map() // index -> byte length on disk
    this.bytes = 0
    this.closed = false
    fs.mkdirSync(this.dir, { recursive: true })
    // Pieces already in the folder (restored from the edge cache). WebTorrent hashes them
    // before use, so a damaged one is downloaded again.
    for (const f of fs.readdirSync(this.dir)) {
      const m = f.match(/^(\d+)\.piece$/)
      if (!m) continue
      const size = fs.statSync(path.join(this.dir, f)).size
      this.pieces.set(Number(m[1]), size)
      this.bytes += size
    }
    if (this.infoHash) PieceStore.byInfoHash.set(this.infoHash, this)
  }

  _file (index) {
    return path.join(this.dir, `${index}.piece`)
  }

  put (index, buf, cb = () => {}) {
    if (this.closed) return queueMicrotask(() => cb(new Error('Storage is closed')))
    fs.writeFile(this._file(index), buf, err => {
      if (err) return cb(err)
      const prev = this.pieces.get(index) || 0
      this.pieces.set(index, buf.length)
      this.bytes += buf.length - prev
      cb(null)
    })
  }

  get (index, opts, cb) {
    if (typeof opts === 'function') return this.get(index, null, opts)
    if (this.closed) return queueMicrotask(() => cb(new Error('Storage is closed')))
    if (!this.pieces.has(index)) return queueMicrotask(() => cb(new Error(`Piece ${index} not stored`)))
    fs.readFile(this._file(index), (err, buf) => {
      if (err) return cb(err)
      const offset = opts?.offset || 0
      const length = opts?.length ?? buf.length - offset
      cb(null, offset === 0 && length === buf.length ? buf : buf.subarray(offset, offset + length))
    })
  }

  has (index) {
    return this.pieces.has(index)
  }

  // Delete one piece from disk. The caller must also tell WebTorrent the piece is gone.
  del (index) {
    const size = this.pieces.get(index)
    if (size === undefined) return
    this.pieces.delete(index)
    this.bytes -= size
    fs.rm(this._file(index), { force: true }, () => {})
  }

  close (cb = () => {}) {
    this.closed = true
    // A newer store for the same torrent may already be registered; only remove our own entry.
    if (this.infoHash && PieceStore.byInfoHash.get(this.infoHash) === this) PieceStore.byInfoHash.delete(this.infoHash)
    queueMicrotask(() => cb(null))
  }

  destroy (cb = () => {}) {
    this.close(() => {
      this.pieces.clear()
      this.bytes = 0
      fs.rm(this.dir, { recursive: true, force: true }, err => cb(err || null))
    })
  }
}
