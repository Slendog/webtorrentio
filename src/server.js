// Must be the first import: it starts collecting log lines for the dashboard.
import './logbuffer.js'
import fs from 'node:fs'
import https from 'node:https'
import express from 'express'
import { manifest, parseUserConfig, STREAM_MODES, streamResponse } from './addon.js'
import { config } from './config.js'
import { dashboardHtml } from './dashboard.js'
import { configurePage, installPage, lockedPage } from './pages.js'
import { startAdmin } from './admin.js'
import { resolveScraperKeys, SCRAPER_KEYS } from './scrapers/index.js'
import { authRequired, listUsers, userForToken } from './settings.js'
import { LimitError, openStream, removeByHash, resolveFile, shutdown, status } from './torrent.js'

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', mov: 'video/quicktime', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv', flv: 'video/x-flv'
}

const app = express()
app.disable('x-powered-by')

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Range')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
  next()
})

app.get('/health', (req, res) => res.json({ ok: true }))

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
  current: req.userConfig
})))

configurable.get('/stream/:type/:id.json', async (req, res) => {
  const { type, id } = req.params
  if (!manifest.types.includes(type)) return res.json({ streams: [] })
  const playBase = (req.userConfig.url || config.streamUrl) + userBase(req)
  res.json(await streamResponse(type, id, playBase, req.userConfig, `${config.publicUrl}${userBase(req)}/configure`))
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
    user: req.userBase ? req.user : null
  }))
})

router.get('/install', (req, res) =>
  res.redirect(`${config.publicUrl}${userBase(req)}/manifest.json`.replace(/^https?:\/\//, 'stremio://')))

router.get('/dashboard', (req, res) => res.type('html').send(dashboardHtml))
router.get('/status', (req, res) => res.json(status(req.user)))

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
  const season = req.query.s ? Number(req.query.s) : undefined
  const episode = req.query.e ? Number(req.query.e) : undefined
  const t0 = Date.now()
  const id = `${req.user} ${infoHash.slice(0, 8)} #${++playRequests}`
  const secs = t => `${((t - t0) / 1000).toFixed(1)}s`

  let resolved
  try {
    resolved = await resolveFile(infoHash, fileIdx, season, episode, req.user)
  } catch (err) {
    console.warn(`[play] ${id} failed after ${secs(Date.now())}: ${err.message}`)
    return res.status(err instanceof LimitError ? err.status : 504).send(err.message)
  }
  const { entry, file } = resolved
  const ext = file.name.split('.').pop().toLowerCase()
  const total = file.length

  res.setHeader('Accept-Ranges', 'bytes')
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`)

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
  const resolvedAt = Date.now()
  const rangeText = req.headers.range || 'whole file'

  const stream = openStream(entry, file, start, end, req.user)
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
    console.log(`[play] ${id} ${file.name} ${rangeText}: metadata ${secs(resolvedAt)}, ` +
      `first byte ${firstByteAt ? secs(firstByteAt) : 'never'}, sent ${(sent / 1024 ** 2).toFixed(1)} MB ` +
      `in ${secs(Date.now())}, ${done}`)
  })
  stream.pipe(res)
})

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
  const user = userForToken(token)
  // 404 rather than 401: an unknown path and a wrong token look the same from outside.
  if (!user) return res.status(404).send('Not found')
  req.user = user
  req.userBase = `/${token}`
  req.url = req.url.slice(token.length + 1) || '/'
  router(req, res, next)
})

// ---- Start

const servers = [app.listen(config.port, () => console.log(`HTTP on port ${config.port}`))]
if (config.tls) {
  const tlsOpts = { cert: fs.readFileSync(config.tls.cert), key: fs.readFileSync(config.tls.key) }
  servers.push(https.createServer(tlsOpts, app).listen(config.httpsPort, () => console.log(`HTTPS on port ${config.httpsPort}`)))
}

for (const server of servers) {
  server.on('error', err => {
    if (err.code !== 'EADDRINUSE') throw err
    console.error(`Port ${err.port} is already in use. Another addon server is probably running: run \`npm stop\` first.`)
    process.exit(1)
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
    for (const { user, token } of users) lines.push(`  ${user}: ${config.publicUrl}/${token}/`)
  } else {
    lines.push(`Install page: ${config.publicUrl}/`, `Dashboard: ${config.publicUrl}/dashboard`,
      'WARNING: no users. Anyone who can reach this server can use it.')
  }
  if (!config.publicUrl.startsWith('https://')) {
    lines.push('No HTTPS: stremio:// install links fail with a TLS error. Paste the manifest URL into Stremio instead.')
  }
  return lines
}

async function stop (reason = 'unknown') {
  console.log(`Shutting down (${reason}), cleaning up torrents...`)
  servers.forEach(s => s.close())
  await shutdown()
  process.exit(0)
}

for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => stop(`${sig} received`))

console.log(`Server starting (pid ${process.pid})`)
for (const line of startupSummary()) console.log(line)
await startAdmin({ stop })
console.log('Dashboard: npm start dashboard')
