import { fetchFromMirrors } from '../http.js'

// EZTV: TV only, JSON API keyed by numeric IMDb id. Its imdb tagging is sloppy, so the
// aggregator's title check does the real filtering.
const MIRRORS = ['https://eztvx.to', 'https://eztv.re', 'https://eztv.wf']
const MAX_PAGES = 5

export default {
  name: 'EZTV',
  types: ['series'],
  async search ({ imdbId, season, episode }) {
    const id = imdbId.replace(/^tt/, '')
    const out = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await fetchFromMirrors(MIRRORS, `/api/get-torrents?imdb_id=${id}&limit=100&page=${page}`)
      const torrents = data?.torrents || []
      for (const t of torrents) {
        if (+t.season !== season || (+t.episode !== episode && +t.episode !== 0)) continue
        out.push({
          name: t.filename || t.title,
          infoHash: t.hash.toLowerCase(),
          size: Number(t.size_bytes),
          seeders: Number(t.seeds),
          leechers: Number(t.peers)
        })
      }
      if (torrents.length < 100) break
    }
    return out
  }
}
