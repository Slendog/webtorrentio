import { TtlCache } from './cache.js'
import { config } from './config.js'
import { getMeta } from './meta.js'
import { formatBytes, parseTags, TRACKERS } from './parse.js'
import { rememberScraped } from './registry.js'
import { prefetch } from './torrent.js'
import { SCRAPER_KEYS, scrapeAll } from './scrapers/index.js'

export const manifest = {
  id: 'community.webtorrent.scraper',
  version: '1.0.0',
  name: 'WebTorrent Scraper',
  description: 'Scrapes public torrent indexes (YTS, TPB, EZTV, Nyaa, 1337x) and streams them through a WebTorrent server.',
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: false }
}

const cache = new TtlCache(config.cacheTtlMs)

function parseId (type, id) {
  const [imdbId, season, episode] = id.split(':')
  return type === 'series'
    ? { imdbId, season: Number(season), episode: Number(episode) }
    : { imdbId }
}

const peerCount = t => (t.seeders || 0) + (t.leechers || 0)

// Rough streaming health, mostly driven by seeders: leechers only have partial data.
function health (t) {
  const seeders = t.seeders || 0
  if (seeders >= 100) return { icon: '🟢', text: 'Excellent' }
  if (seeders >= 20) return { icon: '🟡', text: 'Good' }
  if (seeders >= 5) return { icon: '🟠', text: 'Slow' }
  return { icon: '🔴', text: 'Poor' }
}

// Bold line in the Stremio stream picker: source, quality, health, total peers.
function label (prefix, t) {
  return `${prefix} ${t.quality}\n${health(t).icon} ${peerCount(t)} peers`
}

function describe (t) {
  const tags = parseTags(t.name).join(' ')
  const { icon, text } = health(t)
  return [
    t.name,
    `👤 Seeders: ${t.seeders ?? '?'}   ⬇️ Leechers: ${t.leechers ?? '?'}   ${icon} ${text}`,
    [`💾 ${formatBytes(t.size)}`, `🔎 ${t.source}`, t.match === 'pack' ? '📦 Season pack' : '', tags ? `🎞️ ${tags}` : '']
      .filter(Boolean).join('   ')
  ].join('\n')
}

function toStreams (t, query, playBase, mode) {
  const streams = []
  const bingeGroup = `webtorrent-${t.quality}`
  const title = describe(t)

  if (mode === 'webtorrent' || mode === 'both') {
    const qs = query.type === 'series' ? `?s=${query.season}&e=${query.episode}` : ''
    streams.push({
      name: label('WebTorrent', t),
      title,
      url: `${playBase}/play/${t.infoHash}/auto${qs}`,
      behaviorHints: { bingeGroup, notWebReady: true }
    })
  }

  // Stremio's native engine picks the largest file when fileIdx is absent, which is wrong
  // for season packs, so packs are only offered through the WebTorrent server.
  if ((mode === 'native' || mode === 'both') && t.match !== 'pack') {
    streams.push({
      name: label('Torrent', t),
      title,
      infoHash: t.infoHash,
      sources: [...TRACKERS.map(tr => `tracker:${tr}`), `dht:${t.infoHash}`],
      behaviorHints: { bingeGroup: `native-${t.quality}` }
    })
  }
  return streams
}

export const STREAM_MODES = ['webtorrent', 'native', 'both']

// Per-install settings from the Configure page, stored base64url-encoded JSON in the addon URL:
// { url: "https://server", scrapers: ["yts", "tpb"], mode: "webtorrent" }.
// Anything missing or invalid falls back to the server defaults.
export function parseUserConfig (encoded) {
  let raw = {}
  try {
    raw = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const out = {}
  if (typeof raw.url === 'string' && /^https?:\/\/[^\s/]+/.test(raw.url)) out.url = raw.url.replace(/\/+$/, '')
  if (Array.isArray(raw.scrapers)) {
    const keys = raw.scrapers.filter(k => SCRAPER_KEYS.includes(k))
    if (keys.length) out.scrapers = keys
  }
  if (STREAM_MODES.includes(raw.mode)) out.mode = raw.mode
  return out
}

async function findTorrents (type, id, scraperKeys) {
  const key = `${type}:${id}:${scraperKeys.join(',')}`
  const cached = cache.get(key)
  if (cached) return cached

  const parsed = parseId(type, id)
  const { title, year, runtimeSec } = await getMeta(type, parsed.imdbId)
  const query = { type, title, year, ...parsed }
  console.log(`[stream] ${type} ${id} -> "${title}" (${year ?? '?'})`)

  const torrents = await scrapeAll(query, scraperKeys)
  rememberScraped(torrents, { runtimeSec })
  console.log(`[stream] ${id}: ${torrents.length} torrents`)
  const result = { query, torrents }
  if (torrents.length) cache.set(key, result)
  return result
}

// Stremio stream response. playBase is the URL prefix of /play links, including the
// user's access token, so every user gets links that only work for them.
export async function streamResponse (type, id, playBase, userConfig = {}) {
  const scraperKeys = userConfig.scrapers || config.scrapers
  const mode = userConfig.mode || config.mode
  try {
    const { query, torrents } = await findTorrents(type, id, scraperKeys)
    // Warm up the likely picks in the background; Stremio's native engine does its own loading.
    if (mode !== 'native') {
      setImmediate(() => {
        for (const t of torrents.slice(0, config.prefetchCount)) {
          prefetch(t.infoHash, { season: query.season, episode: query.episode })
        }
      })
    }
    // Short client cache: peer counts go stale fast, and a long cache hides addon updates.
    return { streams: torrents.flatMap(t => toStreams(t, query, playBase, mode)), cacheMaxAge: 5 * 60 }
  } catch (err) {
    console.error(`[stream] ${type} ${id}: ${err.message}`)
    return { streams: [] }
  }
}
