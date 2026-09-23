import { findTorrents } from './addon.js'
import { config } from './config.js'
import { nextEpisode } from './meta.js'
import { getStreamContext, rememberStreamContext } from './registry.js'
import { episodeViewers, prefetch } from './torrent.js'

// Binge-watching: Stremio asks for the next episode's streams as soon as one ends, and plays
// the first stream with the same bingeGroup (here: the same quality). Near the end of an
// episode, run that search ahead of time and prefetch the torrent Stremio will pick, so the
// next episode starts at once.

const CHECK_EVERY_MS = 15_000
const pad = n => String(n).padStart(2, '0')
const done = new Set() // user|show|season|episode already handled
const running = new Set()

async function prepareNext (viewer) {
  const key = `${viewer.user}|${viewer.infoHash}|${viewer.season}|${viewer.episode}`
  if (done.has(key)) return
  const ctx = getStreamContext(viewer.user, viewer.infoHash, viewer.season, viewer.episode)
  // Unknown origin (e.g. the stream list came from before a restart), or native mode where
  // Stremio downloads by itself: nothing to do.
  if (!ctx || ctx.mode === 'native') return done.add(key)
  const showKey = `${viewer.user}|${ctx.imdbId}|${viewer.season}|${viewer.episode}`
  if (done.has(showKey) || running.has(showKey)) return
  running.add(showKey)
  const finish = () => {
    done.add(key)
    done.add(showKey)
    if (done.size > 5000) done.clear()
  }
  try {
    const next = await nextEpisode(ctx.imdbId, viewer.season, viewer.episode)
    if (!next) {
      console.log(`[next] ${viewer.user}: S${pad(viewer.season)}E${pad(viewer.episode)} is the last episode`)
      return finish()
    }
    const id = `${ctx.imdbId}:${next.season}:${next.episode}`
    const { query, torrents } = await findTorrents('series', id, ctx.scraperKeys)
    if (!torrents.length) {
      console.log(`[next] ${viewer.user}: no torrents for S${pad(next.season)}E${pad(next.episode)}`)
      return finish()
    }
    // The stream list is sorted like the one Stremio will get; it picks the first stream in
    // the same bingeGroup, i.e. the same quality, and else the top one.
    const pick = torrents.find(t => t.quality === ctx.quality) || torrents[0]
    rememberStreamContext(viewer.user, torrents, { ...ctx, season: query.season, episode: query.episode })
    prefetch(pick.infoHash, { season: next.season, episode: next.episode, ttlMs: config.nextEpisodeTtlMs, nextEpisode: true })
    console.log(`[next] ${viewer.user}: prefetching S${pad(next.season)}E${pad(next.episode)} ` +
      `(${pick.quality}, ${pick.infoHash === viewer.infoHash ? 'same torrent' : pick.infoHash.slice(0, 8)}) ` +
      `at ${Math.round(viewer.fraction * 100)}% of S${pad(viewer.season)}E${pad(viewer.episode)}`)
    finish()
  } catch (err) {
    // Temporary failures (an index timing out) are retried at the next check.
    console.warn(`[next] ${viewer.user}: ${err.message}; will retry`)
  } finally {
    running.delete(showKey)
  }
}

export function startNextEpisodePrefetch () {
  setInterval(() => {
    if (!config.nextEpisodeAt) return
    for (const viewer of episodeViewers()) {
      if (viewer.fraction >= config.nextEpisodeAt) prepareNext(viewer)
    }
  }, CHECK_EVERY_MS).unref()
}
