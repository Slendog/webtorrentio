import { fetchFromMirrors } from '../http.js'

// YTS / YIFY: movies only, has a JSON API keyed by IMDb id.
const MIRRORS = ['https://movies-api.accel.li', 'https://yts.bz', 'https://yts.am', 'https://yts.mx']

export default {
  name: 'YTS',
  types: ['movie'],
  async search ({ imdbId, title }) {
    const data = await fetchFromMirrors(MIRRORS, `/api/v2/list_movies.json?query_term=${imdbId}`)
    const movies = data?.data?.movies || []
    return movies
      .filter(m => m.imdb_code === imdbId)
      .flatMap(m => (m.torrents || []).map(t => ({
        name: `${m.title_long || title} ${t.quality} ${t.type || ''} ${t.video_codec || ''} YTS`.replace(/\s+/g, ' ').trim(),
        infoHash: t.hash.toLowerCase(),
        size: t.size_bytes,
        seeders: t.seeds,
        leechers: t.peers,
        quality: t.quality === '2160p' ? '4k' : t.quality.replace('3D', '1080p')
      })))
  }
}
