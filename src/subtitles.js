import { TtlCache } from './cache.js'
import { fetchJson, fetchText } from './http.js'

// Subtitles for the watch-together page, from Stremio's OpenSubtitles addon, converted from
// SRT to WebVTT (the only format browsers read in <track>).

const BASE = 'https://opensubtitles-v3.strem.io'
const lists = new TtlCache(6 * 60 * 60 * 1000)
const files = new TtlCache(60 * 60 * 1000)

// [{ id, lang, url }] for a Stremio id ("tt1234567" or "tt1234567:1:2").
export async function subtitleList (type, stremioId) {
  if (!['movie', 'series'].includes(type) || !/^tt\d{1,10}(:\d{1,4}:\d{1,5})?$/.test(stremioId || '')) return []
  const key = `${type}:${stremioId}`
  const cached = lists.get(key)
  if (cached) return cached
  const data = await fetchJson(`${BASE}/subtitles/${type}/${stremioId}.json`, { timeoutMs: 10_000 })
  const list = (data.subtitles || [])
    .filter(s => typeof s.url === 'string' && /^https:\/\//.test(s.url))
    .map((s, i) => ({ id: i, lang: String(s.lang || 'und').slice(0, 12), url: s.url }))
  lists.set(key, list)
  return list
}

export function srtToVtt (text) {
  const body = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim()
  if (body.startsWith('WEBVTT')) return body + '\n'
  // "00:01:02,345 --> 00:01:04,000" becomes "00:01:02.345 --> 00:01:04.000".
  const cues = body.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2')
  return `WEBVTT\n\n${cues}\n`
}

export async function subtitleVtt (entry) {
  const cached = files.get(entry.url)
  if (cached) return cached
  const vtt = srtToVtt(await fetchText(entry.url, { timeoutMs: 15_000 }))
  files.set(entry.url, vtt)
  return vtt
}
