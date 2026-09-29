import { fetchJson } from '../http.js'
import { episodeQuery, seasonQuery } from '../parse.js'

// Torrents-CSV: an open database of torrents found on the DHT, with seeders and leechers from
// regular tracker scrapes. JSON API, no account, and it answers requests from servers in data
// centers, where TPB and 1337x often show a Cloudflare challenge instead. For series it is
// searched for the episode and for the season, so season packs are found for every episode.
const BASE = 'https://torrents-csv.com/service/search'

const toResults = data => (data?.torrents || [])
  .filter(t => /^[a-f0-9]{40}$/i.test(t.infohash || ''))
  .map(t => ({
    name: t.name,
    infoHash: t.infohash.toLowerCase(),
    size: Number(t.size_bytes),
    seeders: Number(t.seeders),
    leechers: Number(t.leechers)
  }))

export default {
  name: 'Torrents-CSV',
  types: ['movie', 'series'],
  async search ({ type, title, year, season, episode }) {
    const queries = type === 'movie'
      ? [`${title} ${year || ''}`.trim()]
      : [episodeQuery(title, season, episode), seasonQuery(title, season)]
    const settled = await Promise.allSettled(queries.map(q => fetchJson(`${BASE}?q=${encodeURIComponent(q)}&size=50`)))
    if (settled.every(r => r.status === 'rejected')) throw settled[0].reason
    return settled.flatMap(r => r.status === 'fulfilled' ? toResults(r.value) : [])
  }
}
