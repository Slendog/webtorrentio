// Tiny in-memory TTL cache so repeated stream requests don't hammer the torrent sites.
export class TtlCache {
  constructor (ttlMs, maxEntries = 500) {
    this.ttlMs = ttlMs
    this.maxEntries = maxEntries
    this.map = new Map()
  }

  get (key) {
    const hit = this.map.get(key)
    if (!hit) return undefined
    if (Date.now() > hit.expires) {
      this.map.delete(key)
      return undefined
    }
    return hit.value
  }

  set (key, value) {
    if (this.map.size >= this.maxEntries) this.map.delete(this.map.keys().next().value)
    this.map.set(key, { value, expires: Date.now() + this.ttlMs })
  }
}
