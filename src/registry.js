// What the scrapers reported about each torrent (name, seeders, leechers, ...), keyed by
// infoHash. The dashboard shows it next to WebTorrent's live numbers.
const MAX_ENTRIES = 2000
const scraped = new Map()

export function rememberScraped (torrents, { runtimeSec } = {}) {
  for (const t of torrents) {
    scraped.delete(t.infoHash)
    scraped.set(t.infoHash, {
      name: t.name,
      source: t.source,
      quality: t.quality,
      size: t.size,
      seeders: t.seeders,
      leechers: t.leechers,
      // Runtime from Cinemeta (typical episode length for series), for timestamp estimates.
      runtimeSec,
      scrapedAt: Date.now()
    })
  }
  while (scraped.size > MAX_ENTRIES) scraped.delete(scraped.keys().next().value)
}

export const getScraped = infoHash => scraped.get(infoHash)
