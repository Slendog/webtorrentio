import { fetchJson } from './http.js'

const CINEMETA = 'https://v3-cinemeta.strem.io'
const cache = new Map()
// Airing shows gain episodes; refresh the metadata after this long.
const META_TTL_MS = 6 * 60 * 60 * 1000

// "136 min", "2h 16min" -> seconds. For series, Cinemeta gives a typical episode length.
function parseRuntime (text) {
  if (!text) return undefined
  const h = Number(String(text).match(/(\d+)\s*h/)?.[1] || 0)
  const m = Number(String(text).match(/(\d+)\s*m/)?.[1] || 0)
  return h * 3600 + m * 60 || undefined
}

// Resolve an IMDb id to a title, year and runtime via Stremio's Cinemeta addon.
export async function getMeta (type, imdbId) {
  const key = `${type}:${imdbId}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.fetchedAt < META_TTL_MS) return hit
  const { meta } = await fetchJson(`${CINEMETA}/meta/${type}/${imdbId}.json`)
  if (!meta?.name) throw new Error(`No Cinemeta entry for ${key}`)
  const year = parseInt(meta.year || meta.releaseInfo, 10) || undefined
  // Series: every episode in watch order, without specials (season 0).
  const episodes = (meta.videos || [])
    .map(v => ({ season: Number(v.season), episode: Number(v.episode ?? v.number) }))
    .filter(v => v.season > 0 && v.episode > 0)
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
  const result = { title: meta.name, year, runtimeSec: parseRuntime(meta.runtime), episodes, fetchedAt: Date.now() }
  cache.set(key, result)
  return result
}

// The episode after season/episode in Cinemeta's list (next season's first episode after a
// finale), or null for the last episode.
export async function nextEpisode (imdbId, season, episode) {
  const { episodes } = await getMeta('series', imdbId)
  const after = episodes.find(v => v.season > season || (v.season === season && v.episode > episode))
  return after || null
}
