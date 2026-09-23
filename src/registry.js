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

// Where a torrent was offered: user -> infoHash:season:episode -> the stream list's query and
// settings. Next-episode prefetch uses it to find the show and repeat the same search.
const contexts = new Map()

export function rememberStreamContext (user, torrents, ctx) {
  for (const t of torrents) {
    const key = `${user}|${t.infoHash}|${ctx.season ?? ''}|${ctx.episode ?? ''}`
    contexts.delete(key)
    contexts.set(key, { ...ctx, quality: t.quality })
  }
  while (contexts.size > MAX_ENTRIES) contexts.delete(contexts.keys().next().value)
}

export const getStreamContext = (user, infoHash, season, episode) =>
  contexts.get(`${user}|${infoHash}|${season ?? ''}|${episode ?? ''}`)
