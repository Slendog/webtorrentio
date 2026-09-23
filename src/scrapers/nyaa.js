import * as cheerio from 'cheerio'
import { fetchFromMirrors, fetchText } from '../http.js'
import { parseSize, titleVariants } from '../parse.js'

// Nyaa: anime. Uses the RSS feed, which exposes info hashes directly.
const MIRRORS = ['https://nyaa.si', 'https://nyaa.land']
const pad = n => String(n).padStart(2, '0')

export default {
  name: 'Nyaa',
  types: ['series', 'movie'],
  async search ({ type, title, season, episode }) {
    // Fansub releases rarely use the full English title, so search with the shortest variant.
    const name = titleVariants(title).at(-1)
    const q = type === 'series' ? `${name} ${season > 1 ? `S${pad(season)}` : ''} ${pad(episode)}` : name
    // c=1_2: Anime - English-translated. f=0: no filter.
    const xml = await fetchFromMirrors(MIRRORS, `/?page=rss&c=1_2&f=0&q=${encodeURIComponent(q.replace(/\s+/g, ' ').trim())}`, fetchText)
    const $ = cheerio.load(xml, { xmlMode: true })
    return $('item').toArray().map(el => {
      const item = $(el)
      return {
        name: item.find('title').text(),
        infoHash: item.find('nyaa\\:infoHash').text().toLowerCase(),
        size: parseSize(item.find('nyaa\\:size').text()),
        seeders: Number(item.find('nyaa\\:seeders').text()),
        leechers: Number(item.find('nyaa\\:leechers').text()),
        // Anime releases usually use absolute numbering ("Title - 05"), not SxxEyy.
        absoluteEpisode: true
      }
    }).filter(t => t.infoHash)
  }
}
