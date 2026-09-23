import { fetchJson } from './http.js'

const CINEMETA = 'https://v3-cinemeta.strem.io'
const cache = new Map()

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
  if (cache.has(key)) return cache.get(key)
  const { meta } = await fetchJson(`${CINEMETA}/meta/${type}/${imdbId}.json`)
  if (!meta?.name) throw new Error(`No Cinemeta entry for ${key}`)
  const year = parseInt(meta.year || meta.releaseInfo, 10) || undefined
  const result = { title: meta.name, year, runtimeSec: parseRuntime(meta.runtime) }
  cache.set(key, result)
  return result
}
