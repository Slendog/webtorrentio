// Helpers for turning torrent titles into something Stremio can display and filter on.

// HTTP(S) trackers come first: many networks block outbound UDP, which also kills DHT.
export const TRACKERS = [
  'http://tracker.opentrackr.org:1337/announce',
  'http://open.tracker.cl:1337/announce',
  'http://tracker.bt4g.com:2095/announce',
  'https://tracker.gbitt.info:443/announce',
  'http://tracker.files.fm:6969/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.tiny-vps.com:6969/announce',
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  ...(process.env.EXTRA_TRACKERS || '').split(',').map(t => t.trim()).filter(Boolean)
]

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|wmv|m4v|webm|ts|m2ts|mpg|mpeg|flv)$/i

export function isVideo (name) {
  return VIDEO_EXT.test(name) && !/\bsample\b/i.test(name)
}

export function parseQuality (title) {
  const t = title.toLowerCase()
  if (/\b(2160p|4k|uhd)\b/.test(t)) return '4k'
  if (/\b1080p\b/.test(t)) return '1080p'
  if (/\b720p\b/.test(t)) return '720p'
  if (/\b(480p|576p|dvdrip|sdtv)\b/.test(t)) return '480p'
  if (/\b(cam|camrip|hdcam|ts|telesync|hdts)\b/.test(t)) return 'CAM'
  return 'SD'
}

export function parseTags (title) {
  const tags = []
  const checks = [
    [/\b(hdr10\+?|hdr|dolby.?vision|dv)\b/i, 'HDR'],
    [/\b(x265|h\.?265|hevc)\b/i, 'HEVC'],
    [/\b(x264|h\.?264|avc)\b/i, 'x264'],
    [/\b(remux)\b/i, 'REMUX'],
    [/\b(web-?dl|webrip)\b/i, 'WEB'],
    [/\b(blu-?ray|bdrip|brrip)\b/i, 'BluRay'],
    [/\b(atmos)\b/i, 'Atmos'],
    [/\b(ddp?5\.1|dts|aac|ac3|truehd)\b/i, m => m.toUpperCase()]
  ]
  for (const [re, label] of checks) {
    const m = title.match(re)
    if (m) tags.push(typeof label === 'function' ? label(m[1]) : label)
  }
  return tags
}

export function formatBytes (bytes) {
  if (!bytes) return '?'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(i >= 3 ? 2 : 0)} ${units[i]}`
}

export function parseSize (str) {
  if (!str) return 0
  const m = String(str).replace(/,/g, '').match(/([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB|TB|TiB)/i)
  if (!m) return 0
  const mult = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3, tb: 1e12, tib: 1024 ** 4 }
  return Math.round(parseFloat(m[1]) * mult[m[2].toLowerCase()])
}

export function normalizeTitle (s) {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// "Frieren: Beyond Journey's End" -> ["Frieren: Beyond Journey's End", "Frieren"]
export function titleVariants (title) {
  const variants = [title]
  const short = title.split(/[:\u2013\u2014]|\s-\s/)[0].trim()
  if (short && short !== title && short.length >= 4) variants.push(short)
  return variants
}

// Loose check that a torrent name refers to the wanted title. By default the title must open
// the name (ignoring "[Group]" prefixes); with `anywhere` it may appear anywhere, as whole words.
export function titleMatches (torrentName, wantedTitle, { anywhere = false } = {}) {
  const name = normalizeTitle(torrentName.replace(/^(\s*[[(][^\])]*[\])])+/, ''))
  return titleVariants(wantedTitle).some(v => {
    const wanted = normalizeTitle(v).replace(/^the /, '')
    if (!wanted) return true
    const bare = name.replace(/^the /, '')
    return anywhere ? ` ${bare} `.includes(` ${wanted} `) : bare === wanted || bare.startsWith(`${wanted} `)
  })
}

const pad = n => String(n).padStart(2, '0')

// Does this name contain the wanted episode? Handles S01E02, 1x02, and season packs.
export function episodeMatch (name, season, episode) {
  const n = name.toLowerCase()
  // S01E02, S01E02E03, S01E02-E03, S01E02-03
  const se = n.match(/s(\d{1,2})[ ._-]?e(\d{1,3})(?:e(\d{1,3})|[ ._]?-[ ._]?e?(\d{1,3}))?(?!\d)/)
  if (se) {
    const s = +se[1]; const e1 = +se[2]; const e2 = se[3] || se[4] ? +(se[3] || se[4]) : e1
    return s === season && episode >= e1 && episode <= e2 ? 'episode' : null
  }
  const x = n.match(/\b(\d{1,2})x(\d{2,3})\b/)
  if (x) return +x[1] === season && +x[2] === episode ? 'episode' : null
  const pack = n.match(/\b(?:s|season[ ._-]?)(\d{1,2})\b(?![ ._-]?e\d)/)
  if (pack) return +pack[1] === season ? 'pack' : null
  if (/complete|all seasons|collection/.test(n)) return 'pack'
  return null
}

export function episodeQuery (title, season, episode) {
  return `${title} S${pad(season)}E${pad(episode)}`
}

export function seasonQuery (title, season) {
  return `${title} S${pad(season)}`
}

export function magnetUri (infoHash, name, trackers = TRACKERS) {
  const tr = trackers.map(t => `&tr=${encodeURIComponent(t)}`).join('')
  return `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name || infoHash)}${tr}`
}

// Pick the file index to play: the matching episode for series, otherwise the largest video.
export function pickFile (files, season, episode) {
  const videos = files
    .map((f, idx) => ({ name: f.name || f.path, length: f.length, idx }))
    .filter(f => isVideo(f.name))
  if (!videos.length) return -1
  if (season != null && episode != null) {
    const hit = videos
      .filter(f => episodeMatch(f.name, season, episode) === 'episode')
      .sort((a, b) => b.length - a.length)[0]
    if (hit) return hit.idx
    if (videos.length > 1) return -1
  }
  return videos.sort((a, b) => b.length - a.length)[0].idx
}
