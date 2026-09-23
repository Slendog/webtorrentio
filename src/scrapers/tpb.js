import { fetchFromMirrors } from '../http.js'
import { episodeQuery, seasonQuery } from '../parse.js'

// The Pirate Bay via its apibay JSON API.
const MIRRORS = ['https://apibay.org']
const CATEGORIES = { movie: '200', series: '200' } // 200 = Video (covers movies + TV)

const toResults = (list, imdbId) => (Array.isArray(list) ? list : [])
  .filter(t => t.info_hash && !/^0+$/.test(t.info_hash))
  // apibay attaches an imdb id to many uploads; reject ones that clearly belong elsewhere.
  .filter(t => !t.imdb || !imdbId || t.imdb === imdbId)
  .map(t => ({
    name: t.name,
    infoHash: t.info_hash.toLowerCase(),
    size: Number(t.size),
    seeders: Number(t.seeders),
    leechers: Number(t.leechers),
    trusted: Boolean(imdbId && t.imdb === imdbId)
  }))

export default {
  name: 'TPB',
  types: ['movie', 'series'],
  async search ({ type, imdbId, title, year, season, episode }) {
    const cat = CATEGORIES[type]
    const queries = type === 'movie'
      ? [`${title} ${year || ''}`.trim()]
      : [episodeQuery(title, season, episode), seasonQuery(title, season)]
    const lists = await Promise.all(queries.map(q =>
      fetchFromMirrors(MIRRORS, `/q.php?q=${encodeURIComponent(q)}&cat=${cat}`).catch(() => [])
    ))
    return lists.flatMap(l => toResults(l, imdbId))
  }
}
