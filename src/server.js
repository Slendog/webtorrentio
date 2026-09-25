// Must be the first import: it starts collecting log lines for the dashboard.
import { oneLine } from './logbuffer.js'
import https from 'node:https'
import express from 'express'
import { manifest, parseUserConfig, STREAM_MODES, streamResponse, togetherManifest, togetherResponse } from './addon.js'
import { config } from './config.js'
import { dashboardHtml } from './dashboard.js'
import { configurePage, installPage, lockedPage } from './pages.js'
import { startAdmin } from './admin.js'
import { loadPair, watchCertificate } from './tls-reload.js'
import { commands, fatal } from './runtime.js'
import { startNextEpisodePrefetch } from './next-episode.js'
import { conversionInfo, getSession, playlist, segment, stopAllConversions } from './convert.js'
import { act, closeAllRooms, closeRoom, createRoom, getRoom, join, report, roomsAvailable, roomStatus } from './rooms.js'
import { subtitleList, subtitleVtt } from './subtitles.js'
import { joinPage, WATCH_CSP, watchPage } from './watch-page.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveScraperKeys, SCRAPER_KEYS } from './scrapers/index.js'
import { authRequired, listUsers, userForToken } from './settings.js'
import net from 'node:net'
import { getScraped } from './registry.js'
import { LimitError, openStream, removeByHash, resolveFile, shutdown, status, userConnections, waitForData } from './torrent.js'

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv', flv: 'video/x-flv'
}

const app = express()
app.disable('x-powered-by')

// Reject Host names that are not ours. A web page could otherwise point a domain it controls at
// 127.0.0.1 (DNS rebinding) and read the dashboard or control the server from the browser.
// IP addresses cannot be rebound, so any IP literal is fine.
const hostName = url => { try { return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase() } catch { return null } }
const knownHosts = new Set(['localhost', hostName(config.publicUrl), hostName(config.streamUrl), ...config.allowedHosts].filter(Boolean))
app.use((req, res, next) => {
  const host = (req.hostname || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (net.isIP(host) || knownHosts.has(host)) return next()
  res.status(403).type('text').send(`Host "${host}" is not allowed. Add it to ALLOWED_HOSTS if it is yours.`)
})

// CORS only where Stremio needs it (Stremio Web fetches the manifest and stream lists from its
// own origin). The dashboard, status and API stay same-origin, so other sites cannot read them.
const stremioRoute = /\/(manifest\.json|stream\/[^/]+\/[^/]+\.json|play\/[^/]+\/[^/]+|hls\/[^/]+\/[^/]+\/[^/]+)$/
app.use((req, res, next) => {
  if (stremioRoute.test(req.path)) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Range')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
  }
  next()
})

// Browser hardening for every response. HTML pages also get a Content-Security-Policy (only
// this server's own scripts and data, no framing), and pages or data that can contain tokens
// must not be cached by browsers or proxies.
const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  if (!stremioRoute.test(req.path)) res.setHeader('Cache-Control', 'no-store')
  const type = res.type.bind(res)
  res.type = t => {
    if (t === 'html') res.setHeader('Content-Security-Policy', CSP)
    return type(t)
  }
  next()
})

app.get('/health', (req, res) => res.json({ ok: true }))

// Fixed one-minute window per user for stream list requests.
const streamRequests = new Map()
function streamRateExceeded (user) {
  const now = Date.now()
  const w = streamRequests.get(user)
  if (!w || now - w.start >= 60_000) {
    streamRequests.set(user, { start: now, count: 1 })
    return false
  }
  return ++w.count > config.streamRatePerMin
}

// IMDb ids from Stremio: "tt1234567" for movies, "tt1234567:1:2" for episodes.
const VALID_ID = /^tt\d{1,10}(:\d{1,4}:\d{1,5})?$/

// URL prefix for this user's routes: "/<token>" with access tokens, "" without.
const userBase = req => req.userBase

// ---- Routes that accept per-install settings (/c/<settings>/...)

const configurable = express.Router({ mergeParams: true })

configurable.get('/manifest.json', (req, res) => res.json(manifest))

configurable.get('/configure', (req, res) => res.type('html').send(configurePage({
  manifest,
  addonBase: config.publicUrl + userBase(req),
  defaults: { url: config.streamUrl, scrapers: resolveScraperKeys(), mode: config.mode },
  scraperKeys: SCRAPER_KEYS,
  modes: STREAM_MODES,
  current: req.userConfig,
  together: roomsAvailable()
})))

configurable.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params
  if (!manifest.types.includes(type) || !VALID_ID.test(id)) return res.json({ streams: [] })
  if (streamRateExceeded(req.user)) {
    console.warn(`[stream] ${req.user} over ${config.streamRatePerMin} stream lists per minute, request ignored`)
    return res.status(429).json({ streams: [] })
  }
  const playBase = (req.userConfig.url || config.streamUrl) + userBase(req)
  res.json(await streamResponse(type, id, playBase, req.userConfig, `${config.publicUrl}${userBase(req)}/configure`, req.user))
})

// The watch-together companion addon: /together/manifest.json (also under /c/<settings>/, so
// it can use the same index choice as the main addon).
configurable.get('/together/manifest.json', (req, res) => res.json(togetherManifest))

configurable.get('/together/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params
  if (!togetherManifest.types.includes(type) || !VALID_ID.test(id)) return res.json({ streams: [] })
  if (streamRateExceeded(req.user)) return res.status(429).json({ streams: [] })
  res.json(await togetherResponse(type, id, req.userConfig, config.publicUrl + userBase(req)))
})

// ---- All routes of one user

const router = express.Router({ mergeParams: true })

router.use('/c/:settings', (req, res, next) => {
  const parsed = parseUserConfig(req.params.settings)
  if (!parsed) return res.status(400).send('Invalid addon settings in URL')
  req.userConfig = parsed
  next()
}, configurable)

router.use((req, res, next) => {
  req.userConfig ??= {}
  next()
})
router.use(configurable)

router.get('/', (req, res) => {
  // Relative links on the page need the trailing slash: "/<token>" -> "/<token>/".
  if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect(req.originalUrl.replace(/(\?|$)/, '/$1'))
  res.type('html').send(installPage({
    manifest,
    manifestUrl: `${config.publicUrl}${userBase(req)}/manifest.json`,
    togetherUrl: roomsAvailable() ? `${config.publicUrl}${userBase(req)}/together/manifest.json` : null,
    user: req.userBase ? req.user : null
  }))
})

router.get('/install', (req, res) =>
  res.redirect(`${config.publicUrl}${userBase(req)}/manifest.json`.replace(/^https?:\/\//, 'stremio://')))

router.get('/dashboard', (req, res) => res.type('html').send(dashboardHtml))
router.get('/status', (req, res) => res.json({ ...status(req.user), conversions: conversionInfo(), rooms: roomStatus() }))

router.delete('/api/torrents/:infoHash', (req, res) => {
  const result = removeByHash(req.params.infoHash.toLowerCase(), req.user)
  if (result === 'removed') return res.status(204).end()
  if (result === 'busy') return res.status(409).send('Another user is streaming this torrent')
  res.status(404).end()
})

let playRequests = 0

// Serve a torrent file over HTTP with Range support, downloading pieces on demand via WebTorrent.
router.get('/play/:infoHash/:fileIdx', async (req, res) => {
  const { infoHash, fileIdx } = req.params
  if (!/^[a-fA-F0-9]{40}$/.test(infoHash)) return res.status(400).send('Bad infoHash')
  if (fileIdx !== 'auto' && !/^\d{1,6}$/.test(fileIdx)) return res.status(400).send('Bad file index')
  // Without users anyone who can reach the server, including a web page open in your browser
  // (a hidden <video> tag), could make it download and seed any torrent. Then only torrents
  // this server listed in a stream result can be played.
  if (!authRequired() && !getScraped(infoHash.toLowerCase())) {
    return res.status(404).send('Unknown torrent. Open it from the stream list in Stremio.')
  }
  if (userConnections(req.user) >= config.maxConnectionsPerUser) {
    return res.status(429).send(`Too many open connections (${config.maxConnectionsPerUser}).`)
  }
  const season = req.query.s ? Number(req.query.s) : undefined
  const episode = req.query.e ? Number(req.query.e) : undefined
  const t0 = Date.now()
  const id = `${req.user} ${infoHash.slice(0, 8)} #${++playRequests}`
  const secs = t => `${((t - t0) / 1000).toFixed(1)}s`

  // Waiting instead of timing out: players drop a request after ~15 s without data. While
  // metadata or the first piece is missing, hold the request for PLAY_WAIT_MS, then redirect
  // to the same URL (?w=n); the player follows it with a fresh timeout and the download goes on.
  const waits = Number(req.query.w) || 0
  const canWait = req.method === 'GET' && waits < config.playMaxWaits
  const aborted = new AbortController()
  // The response's close event fires only when the connection really ends (the request's can
  // fire as soon as its empty body is read).
  res.on('close', () => aborted.abort())
  const requested = oneLine(req.headers.range || 'whole file').slice(0, 60)
  const redirect = reason => {
    const url = new URL(req.originalUrl, 'http://placeholder')
    url.searchParams.set('w', String(waits + 1))
    console.log(`[play] ${id} ${requested}: ${reason} after ${secs(Date.now())}, redirect ${waits + 1}/${config.playMaxWaits}`)
    res.redirect(307, url.pathname + url.search)
  }

  let resolved
  try {
    const resolving = resolveFile(infoHash, fileIdx, season, episode, req.user)
    if (canWait) {
      let timer
      const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), config.playWaitMs) })
      resolved = await Promise.race([resolving, late])
      clearTimeout(timer)
      if (!resolved) {
        resolving.catch(() => {})
        return redirect('metadata not ready')
      }
    } else {
      resolved = await resolving
    }
  } catch (err) {
    console.warn(`[play] ${id} failed after ${secs(Date.now())}: ${oneLine(err.message)}`)
    return res.status(err instanceof LimitError ? err.status : 504).send(err.message)
  }
  const { entry, file } = resolved
  const metadataAt = Date.now()
  const ext = file.name.split('.').pop().toLowerCase()
  const total = file.length

  let start = 0
  let end = total - 1
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/)
  if (range) {
    if (range[1] === '' && range[2] !== '') {
      start = Math.max(0, total - Number(range[2]))
    } else {
      start = Number(range[1] || 0)
      if (range[2] !== '') end = Math.min(Number(range[2]), total - 1)
    }
    if (start > end || start >= total) {
      res.setHeader('Content-Range', `bytes */${total}`)
      return res.status(416).end()
    }
  }

  if (canWait) {
    const left = Math.max(0, config.playWaitMs - (Date.now() - t0))
    const ready = await waitForData(entry, file, start, left, aborted.signal)
    if (aborted.signal.aborted) {
      console.log(`[play] ${id} player gave up after ${secs(Date.now())} while waiting for data`)
      return
    }
    if (!ready) return redirect('first piece not ready')
  }

  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`)
  if (range) {
    res.status(206)
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
  }
  res.setHeader('Content-Length', end - start + 1)
  if (req.method === 'HEAD') return res.end()

  // The player may have given up while the torrent metadata was loading. Opening a stream for
  // a closed connection would count it as open forever.
  if (req.destroyed || res.destroyed || res.socket?.destroyed) {
    console.log(`[play] ${id} player gave up after ${secs(Date.now())} while the torrent was loading`)
    return
  }
  const dataAt = Date.now()
  const rangeText = requested

  const stream = openStream(entry, file, start, end, req.user, { season, episode })
  stream.on('error', err => {
    console.warn(`[http] stream error ${infoHash}: ${err.message}`)
    res.destroy(err)
  })
  // One line per request when it ends: what the player asked for, how long the first byte took,
  // and how much it got. Players time out when the first byte takes too long.
  let firstByteAt = null
  let sent = 0
  stream.on('data', buf => {
    firstByteAt ??= Date.now()
    sent += buf.length
  })
  res.on('close', () => {
    stream.destroy()
    const done = res.writableFinished ? 'finished' : 'closed by player'
    console.log(`[play] ${id}${waits ? ` (after ${waits} redirect${waits > 1 ? 's' : ''})` : ''} ${oneLine(file.name)} ${rangeText}: ` +
      `metadata ${secs(metadataAt)}, waited for data ${secs(dataAt)}, first byte ${firstByteAt ? secs(firstByteAt) : 'never'}, sent ${(sent / 1024 ** 2).toFixed(1)} MB ` +
      `in ${secs(Date.now())}, ${done}`)
  })
  stream.pipe(res)
})

// HLS with the audio mixed down to stereo (see convert.js): the playlist, or segment n.
// `open` returns the conversion session; `query` is appended to segment URLs in the playlist.
async function serveHls (req, res, { name, open, query = '', label }) {
  const isPlaylist = name === 'index.m3u8'
  const segMatch = name.match(/^(\d{1,6})\.ts$/)
  if (!isPlaylist && !segMatch) return res.status(404).end()
  const t0 = Date.now()
  const waits = Number(req.query.w) || 0
  const canWait = waits < config.playMaxWaits
  const aborted = new AbortController()
  res.on('close', () => aborted.abort())
  // Waiting instead of timing out, as for /play: redirect to the same URL before the player gives up.
  const redirect = () => {
    const url = new URL(req.originalUrl, 'http://placeholder')
    url.searchParams.set('w', String(waits + 1))
    res.redirect(307, url.pathname + url.search)
  }
  const fail = err => {
    console.warn(`[convert] ${req.user} ${label} ${name}: ${oneLine(err.message)}`)
    if (!res.headersSent) res.status(err.status || 502).send(err.message)
  }

  let session
  try {
    session = open()
    let timer
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), canWait ? config.playWaitMs : 120_000) })
    const ready = await Promise.race([session.ready, late])
    clearTimeout(timer)
    if (!ready) return canWait ? redirect() : res.status(504).send('Torrent metadata not ready')
  } catch (err) {
    return fail(err)
  }

  if (isPlaylist) {
    res.type('application/vnd.apple.mpegurl')
    return res.send(playlist(session, query))
  }

  let file
  try {
    const left = Math.max(1000, config.playWaitMs - (Date.now() - t0))
    file = await segment(session, Number(segMatch[1]), canWait ? left : 120_000, aborted.signal)
  } catch (err) {
    return fail(err)
  }
  if (file === undefined) return res.status(404).end()
  if (!file) {
    if (aborted.signal.aborted) return
    return canWait ? redirect() : res.status(504).send('Segment not ready')
  }
  res.type('video/mp2t')
  res.sendFile(file, err => {
    if (err && !res.headersSent) res.status(404).end()
  })
}

// The same file as HLS with stereo audio: /hls/<infoHash>/<fileIdx>/index.m3u8 and <n>.ts.
router.get('/hls/:infoHash/:fileIdx/:name', (req, res) => {
  const { infoHash, fileIdx, name } = req.params
  if (!/^[a-fA-F0-9]{40}$/.test(infoHash)) return res.status(400).send('Bad infoHash')
  if (fileIdx !== 'auto' && !/^\d{1,6}$/.test(fileIdx)) return res.status(400).send('Bad file index')
  if (!authRequired() && !getScraped(infoHash.toLowerCase())) {
    return res.status(404).send('Unknown torrent. Open it from the stream list in Stremio.')
  }
  const season = req.query.s ? Number(req.query.s) : undefined
  const episode = req.query.e ? Number(req.query.e) : undefined
  const qs = new URLSearchParams()
  if (season != null) qs.set('s', season)
  if (episode != null) qs.set('e', episode)
  return serveHls(req, res, {
    name,
    label: infoHash.slice(0, 8),
    query: qs.size ? `?${qs}` : '',
    open: () => getSession(req.user, infoHash, fileIdx, season, episode)
  })
})

// ---- Watch together (rooms.js, watch-page.js)

const watch = express.Router({ mergeParams: true })
router.use('/watch', watch)

watch.get('/time', (req, res) => res.json({ t: Date.now() }))

// Opened from the "Together" entry in Stremio: create a room and go to it.
watch.get('/new', (req, res) => {
  const { h, i = 'auto', s, e, type, id } = req.query
  if (!/^[a-fA-F0-9]{40}$/.test(h || '')) return res.status(400).send('Bad infoHash')
  if (i !== 'auto' && !/^\d{1,6}$/.test(i)) return res.status(400).send('Bad file index')
  if (!authRequired() && !getScraped(h.toLowerCase())) return res.status(404).send('Unknown torrent. Open it from the stream list in Stremio.')
  try {
    const room = createRoom({
      host: req.user,
      infoHash: h,
      fileIdx: i,
      season: s ? Number(s) : undefined,
      episode: e ? Number(e) : undefined,
      type: ['movie', 'series'].includes(type) ? type : null,
      stremioId: VALID_ID.test(id || '') ? id : null,
      name: getScraped(h.toLowerCase())?.name
    })
    res.redirect(303, `${userBase(req)}/watch/${room.id}`)
  } catch (err) {
    res.status(err.status || 500).type('text').send(err.message)
  }
})

// Every other /watch/<room> route needs the room.
watch.param('room', (req, res, next, id) => {
  const room = getRoom(id)
  if (!room) return res.status(404).type('text').send('This room does not exist (any more).')
  req.room = room
  next()
})

watch.get('/:room', (req, res) => {
  const { room } = req
  res.type('html')
  res.setHeader('Content-Security-Policy', WATCH_CSP)
  res.send(watchPage({
    roomId: room.id,
    user: req.user,
    isHost: req.user === room.host,
    shareUrl: `${config.publicUrl}/watch/${room.id}`,
    title: room.name || 'Watch together',
    auth: authRequired()
  }))
})

const roomSession = room => getSession(room.host, room.infoHash, room.fileIdx, room.season, room.episode, { key: room.id })

// File details for the page, once the torrent and its index are loaded (202 until then).
watch.get('/:room/info', async (req, res) => {
  const { room } = req
  let session
  try {
    session = roomSession(room)
  } catch (err) {
    return res.status(err.status || 500).send(err.message)
  }
  let timer
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(null), 10_000) })
  try {
    const ready = await Promise.race([session.ready, late])
    if (!ready) return res.status(202).json({ loading: true })
  } catch (err) {
    return res.status(err.status || 502).send(err.message)
  } finally {
    clearTimeout(timer)
  }
  if (!room.subtitles) {
    room.subtitles = room.stremioId && room.type
      ? await subtitleList(room.type, room.stremioId).catch(err => { console.warn(`[room] subtitles: ${oneLine(err.message)}`); return [] })
      : []
  }
  res.json({
    name: session.file?.name || room.name,
    videoCodec: session.videoCodec,
    duration: session.duration,
    subtitles: room.subtitles.map(s => ({ id: s.id, lang: s.lang }))
  })
})

watch.get('/:room/hls/:name', (req, res) => serveHls(req, res, {
  name: req.params.name,
  label: `room ${req.room.id}`,
  open: () => roomSession(req.room)
}))

watch.get('/:room/sub/:n.vtt', async (req, res) => {
  const entry = req.room.subtitles?.[Number(req.params.n)]
  if (!entry) return res.status(404).end()
  try {
    res.type('text/vtt').send(await subtitleVtt(entry))
  } catch (err) {
    res.status(502).send(err.message)
  }
})

watch.get('/:room/events', (req, res) => {
  try {
    join(req.room, { user: req.user, clientId: String(req.query.cid || ''), name: req.query.name, res })
  } catch (err) {
    res.status(err.status || 400).send(err.message)
  }
})

const roomAction = fn => (req, res) => {
  try {
    fn(req)
    res.status(204).end()
  } catch (err) {
    res.status(err.status || 400).type('text').send(err.message)
  }
}
watch.post('/:room/action', express.json({ limit: '4kb' }), roomAction(req => act(req.room, { ...req.body, user: req.user })))
watch.post('/:room/report', express.json({ limit: '4kb' }), roomAction(req => report(req.room, { ...req.body, user: req.user })))
watch.post('/:room/close', roomAction(req => {
  if (req.user !== req.room.host) throw Object.assign(new Error('Only the host can close the room.'), { status: 403 })
  closeRoom(req.room.id, `closed by ${req.user}`)
}))

// hls.js for the room page. Public: it is a published library, no data of this server.
const hlsJs = path.join(path.dirname(fileURLToPath(import.meta.resolve('hls.js'))), 'hls.min.js')
app.get('/assets/hls.min.js', (req, res) => res.set('Cache-Control', 'public, max-age=86400').type('js').sendFile(hlsJs))

// Users can be added and removed while the server runs, so the token check happens per request:
// with users, every route lives under "/<token>"; without users, the addon is open.
app.use((req, res, next) => {
  if (!authRequired()) {
    req.user = 'local'
    req.userBase = ''
    return router(req, res, next)
  }
  const token = req.path.split('/')[1]
  if (!token) return res.type('html').send(lockedPage(manifest))
  // Invite links (/watch/<room>) carry no token: the page asks for the member's own link.
  const invite = req.path.match(/^\/watch\/([\w-]{1,20})\/?$/)
  if (invite && req.method === 'GET') return res.type('html').send(joinPage(invite[1]))
  const user = userForToken(token)
  // 404 rather than 401: an unknown path and a wrong token look the same from outside.
  if (!user) return res.status(404).send('Not found')
  req.user = user
  req.userBase = `/${token}`
  req.url = req.url.slice(token.length + 1) || '/'
  router(req, res, next)
})

// ---- Start

const servers = [app.listen(config.port, config.host, () => console.log(`HTTP on ${config.host}:${config.port}`))]
if (config.tls) {
  const httpsServer = https.createServer(loadPair(config.tls), app)
  servers.push(httpsServer.listen(config.httpsPort, config.host, () => console.log(`HTTPS on ${config.host}:${config.httpsPort}`)))
  watchCertificate(httpsServer, config.tls)
}

for (const server of servers) {
  server.on('error', err => {
    if (err.code !== 'EADDRINUSE') throw err
    fatal(`Port ${err.port} is already in use. Another addon server is probably running: run \`${commands.stop}\` first.`)
  })
}

function startupSummary () {
  const lines = [
    `Stream mode: ${config.mode}; indexes: ${resolveScraperKeys().join(', ') || 'none (set SCRAPERS, e.g. SCRAPERS=all, or choose them on the Configure page)'}`,
    `Limits: ${config.maxActiveTorrents} torrents total, ${config.maxTorrentsPerUser} per user, ` +
      `disk ${config.maxDiskBytes ? `${config.maxDiskBytes / 1024 ** 3} GB` : 'unlimited'} total, ` +
      `${config.maxDiskPerStreamBytes ? `${config.maxDiskPerStreamBytes / 1024 ** 2} MB` : 'unlimited'} per stream, ` +
      `readahead ${config.readaheadBytes / 1024 ** 2} MB`
  ]
  const users = listUsers()
  if (users.length) {
    lines.push(`Access tokens enabled for ${users.length} user(s). Install pages:`)
    // Install links contain tokens: show them in a terminal, never in log files or docker logs.
    if (process.stdout.isTTY) for (const { user, token } of users) lines.push(`  ${user}: ${config.publicUrl}/${token}/`)
    else lines.push(`  ${users.map(u => u.user).join(', ')} (links: ${commands.dashboard}, then press t)`)
  } else {
    lines.push(`Install page: ${config.publicUrl}/`, `Dashboard: ${config.publicUrl}/dashboard`,
      'WARNING: no users. Anyone who can reach this server can use it.')
  }
  if (!users.length && !['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
    lines.push(`WARNING: listening on ${config.host} without users: other machines can use this server. Add a user.`)
  }
  lines.push(`HTTPS (HTTPS=${config.httpsMode}): ${config.tls ? `on, port ${config.httpsPort}` : 'off'}`)
  if (!config.publicUrl.startsWith('https://')) {
    lines.push('No HTTPS: stremio:// install links fail with a TLS error. Paste the manifest URL into Stremio instead.')
  }
  return lines
}

async function stop (reason = 'unknown') {
  console.log(`Shutting down (${reason}), cleaning up torrents...`)
  servers.forEach(s => s.close())
  closeAllRooms()
  stopAllConversions()
  await shutdown()
  process.exit(0)
}

for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => stop(`${sig} received`))

// Last line of defence: record why the server dies, with a timestamp, instead of a bare stack
// trace. An unknown error leaves the process in an unknown state, so it still exits.
process.on('uncaughtException', (err, origin) => {
  console.error(`Crashed (${origin}): ${err?.stack || err}`)
  process.exit(1)
})
process.on('unhandledRejection', reason => {
  console.error(`Unhandled promise rejection (server keeps running): ${reason?.stack || reason}`)
})

console.log(`Server starting (pid ${process.pid})`)
for (const line of startupSummary()) console.log(line)
await startAdmin({ stop })
startNextEpisodePrefetch()
console.log(`Dashboard: ${commands.dashboard}`)
