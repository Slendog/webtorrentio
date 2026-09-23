import * as cheerio from 'cheerio'
import { fetchFromMirrors, fetchText } from '../http.js'
import { episodeQuery, parseSize } from '../parse.js'

// 1337x: HTML scraping. Frequently sits behind Cloudflare, so failures are expected
// and handled by the aggregator. Magnets live on detail pages, so only the top results are opened.
const MIRRORS = ['https://1337x.to', 'https://1337x.st', 'https://x1337x.ws', 'https://1337xx.to']
const MAX_DETAILS = 8

export default {
  name: '1337x',
  types: ['movie', 'series'],
  async search ({ type, title, year, season, episode }) {
    const q = type === 'movie' ? `${title} ${year || ''}`.trim() : episodeQuery(title, season, episode)
    const category = type === 'movie' ? 'Movies' : 'TV'
    let base
    const html = await fetchFromMirrors(MIRRORS, `/sort-category-search/${encodeURIComponent(q)}/${category}/seeders/desc/1/`, async url => {
      const text = await fetchText(url)
      base = new URL(url).origin
      return text
    })
    const $ = cheerio.load(html)
    const rows = $('table.table-list tbody tr').toArray().slice(0, MAX_DETAILS).map(tr => {
      const row = $(tr)
      return {
        href: row.find('td.name a[href^="/torrent/"]').attr('href'),
        name: row.find('td.name a[href^="/torrent/"]').text().trim(),
        seeders: Number(row.find('td.seeds').text()),
        leechers: Number(row.find('td.leeches').text()),
        size: parseSize(row.find('td.size').clone().children().remove().end().text())
      }
    }).filter(r => r.href)

    const detailed = await Promise.all(rows.map(async r => {
      try {
        const page = await fetchText(base + r.href)
        const magnet = cheerio.load(page)('a[href^="magnet:"]').first().attr('href') || ''
        const hash = magnet.match(/btih:([a-f0-9]{40})/i)?.[1]
        return hash ? { name: r.name, infoHash: hash.toLowerCase(), size: r.size, seeders: r.seeders, leechers: r.leechers } : null
      } catch {
        return null
      }
    }))
    return detailed.filter(Boolean)
  }
}
