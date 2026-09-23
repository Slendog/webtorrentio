import Wire from 'bittorrent-protocol'

// Every byte a remote peer sends passes through Wire#_write. The protocol code throws on some
// malformed input; one such case is an encryption handshake (MSE) with an invalid
// Diffie-Hellman key, where Node's crypto throws "Supplied key is too small". Uncaught, a single
// hostile or broken peer would crash the whole server. The guard turns any such error into
// "close this one connection", the same thing the library already does when it cannot
// resynchronise a stream.

let dropped = 0
let lastReport = 0

export function installPeerGuard () {
  if (Wire.prototype._peerGuarded) return
  const write = Wire.prototype._write
  Wire.prototype._write = function (data, cb) {
    let called = false
    const done = err => { called = true; cb(err) }
    try {
      write.call(this, data, done)
    } catch (err) {
      dropped++
      if (Date.now() - lastReport > 60_000) {
        lastReport = Date.now()
        console.warn(`[peer] closed a connection that sent invalid data (${err.code || err.name}: ${err.message}); ${dropped} so far`)
      }
      this.destroy()
      if (!called) cb(null)
    }
  }
  Wire.prototype._peerGuarded = true
}

// True when `wire` comes from the patched class, i.e. WebTorrent uses the same copy of
// bittorrent-protocol that was guarded.
export const isGuarded = wire => wire instanceof Wire
