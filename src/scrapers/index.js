import { config } from '../config.js'
import { episodeMatch, parseQuality, titleMatches } from '../parse.js'
import yts from './yts.js'
import tpb from './tpb.js'
import eztv from './eztv.js'
import nyaa from './nyaa.js'
import x1337 from './x1337.js'

const ALL = { yts, tpb, eztv, nyaa, '1337x': x1337 }

export const SCRAPER_KEYS = Object.keys(ALL)

const enabledScrapers = (keys = config.scrapers) => keys.map(k => ALL[k.toLowerCase()]).filter(Boolean)

const peers = t => (t.seeders || 0) + (t.leechers || 0)

const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
])


function absoluteEpisodeMatch (name, season, episode) {
  // Reject releases that name a different season ("S2", "2nd Season", "Season 2").
  const s = name.match(/\bS(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th) Season\b|\bSeason (\d{1,2})\b/i)
  if (s && Number(s[1] || s[2] || s[3]) !== season) return null
  // "Show - 05", "Show - 05v2", "Show E05", "Show 05 [1080p]"
  const re = new RegExp(`(?:\\s-\\s|\\bE|\\s)0*${episode}(?:v\\d)?(?=[\\s\\[\\(._]|$)`, 'i')
  return re.test(name) ? 'episode' : null
}

function relevant (t, query) {
  const { type, title, year, season, episode } = query
  if (!t.trusted && !titleMatches(t.name, title, { anywhere: t.absoluteEpisode })) return null
  if (type === 'movie') {
    const years = [...t.name.matchAll(/\b(19\d{2}|20\d{2})\b/g)].map(m => +m[1])
    if (year && years.length && !years.some(y => Math.abs(y - year) <= 1)) return null
    return { ...t, match: 'movie' }
  }
  let match = episodeMatch(t.name, season, episode)
  if (!match && t.absoluteEpisode) match = absoluteEpisodeMatch(t.name, season, episode)
  return match ? { ...t, match } : null
}

// Run every enabled scraper in parallel. A broken or blocked site only drops its own results.
export async function scrapeAll (query, scraperKeys) {
  const scrapers = enabledScrapers(scraperKeys).filter(s => s.types.includes(query.type))
  const settled = await Promise.allSettled(scrapers.map(s =>
    withTimeout(s.search(query), config.scraperTimeoutMs, s.name)
      .then(list => list.map(t => ({ ...t, source: s.name, trusted: t.trusted || s === yts })))
  ))

  settled.forEach((r, i) => {
    if (r.status === 'rejected') console.warn(`[scraper] ${scrapers[i].name}: ${r.reason?.message || r.reason}`)
    else console.log(`[scraper] ${scrapers[i].name}: ${r.value.length} raw results`)
  })

  const byHash = new Map()
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    for (const raw of r.value) {
      if (!/^[a-f0-9]{40}$/.test(raw.infoHash)) continue
      const t = relevant(raw, query)
      if (!t) continue
      const prev = byHash.get(t.infoHash)
      if (!prev || peers(t) > peers(prev)) byHash.set(t.infoHash, t)
    }
  }

  return [...byHash.values()]
    .map(t => ({ ...t, quality: t.quality || parseQuality(t.name) }))
    .filter(t => t.seeders !== 0)
    // Most peers (seeders + leechers) first; seeders break ties.
    .sort((a, b) => peers(b) - peers(a) || (b.seeders || 0) - (a.seeders || 0))
    .slice(0, config.maxResults)
}

