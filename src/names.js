// Readable titles from release names: "Mayday.2026.1080p.BluRay.x264-[YTS].mp4" -> "Mayday 2026",
// "Reacher.S01E08.1080p.BluRay.x265-RARBG.mp4" -> "Reacher S01E08",
// "Ted Lasso (2020) - S02E03 - Two Aces (1080p).mkv" -> "Ted Lasso S02E03".
// For series the episode wins over the year. When the name has no episode (a file in a season
// pack named "03 - Two Aces.mkv", or the pack's own name), `season` and `episode` from the
// request fill it in. Falls back to the name.
const clean = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '')
const pad = n => String(n).padStart(2, '0')

export const episodeTag = (season, episode) => season != null && episode != null ? `S${pad(season)}E${pad(episode)}` : null

export function prettyTitle (name, { season, episode } = {}) {
  const base = clean(name).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  const ep = base.match(/\bS(\d{1,2}) ?E(\d{1,3})\b/i) || base.match(/\b(\d{1,2})x(\d{2,3})\b/)
  const seasonOnly = base.match(/\b(?:S|Season )(\d{1,2})\b/i)
  const year = base.match(/\b(19|20)\d{2}\b/)
  // The show or film name ends where the first year, season, episode or resolution starts.
  const cut = base.search(/\b(19|20)\d{2}\b|\bS\d{1,2}( ?E\d{1,3})?\b|\bSeason \d{1,2}\b|\b\d{1,2}x\d{2,3}\b|\b(480|576|720|1080|2160)p\b/i)
  const show = (cut > 0 ? base.slice(0, cut) : base).replace(/[\s([{-]+$/, '').trim()
  if (!show) return base
  const tag = ep ? episodeTag(+ep[1], +ep[2]) : episodeTag(season, episode)
  if (tag) return `${show} ${tag}`
  if (seasonOnly) return `${show} S${pad(seasonOnly[1])}`
  return year && cut > 0 ? `${show} ${year[0]}` : show
}

// Title of what someone watches: the file's own name when it names the episode, else the
// torrent's name (the show) with the requested episode. Files in season packs are often only
// "03 - Two Aces.mkv".
export function watchTitle (fileName, torrentName, { season, episode } = {}) {
  const names = clean(fileName)
  if (!fileName || (episodeTag(season, episode) && !/\bS\d{1,2} ?E\d{1,3}\b|\b\d{1,2}x\d{2,3}\b/i.test(names.replace(/[._]+/g, ' ')))) {
    return prettyTitle(torrentName || fileName, { season, episode })
  }
  return prettyTitle(fileName, { season, episode })
}
