import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import express from 'express'
import { config } from './config.js'
import { logsSince } from './logbuffer.js'
import { socketPath } from './paths.js'
import { addUser, formatLimit, LIMITS, limitValue, listUsers, removeUser, setLimit, statePath } from './settings.js'
import { forceRemove, status } from './torrent.js'

// Admin API for the TUI dashboard, on a Unix socket readable only by the owner. It never
// listens on a network port, so it is reachable only from this machine (or inside the container).

const startedAt = Date.now()

export async function startAdmin ({ stop }) {
  // Owner-only folder: the socket must never be reachable by other local users, not even in
  // the moment between creating it and changing its permissions.
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 })
  fs.chmodSync(path.dirname(socketPath), 0o700)
  await clearStaleSocket()

  const app = express()
  app.use(express.json())

  app.get('/state', (req, res) => res.json({
    pid: process.pid,
    uptime: Date.now() - startedAt,
    publicUrl: config.publicUrl,
    statePath,
    status: status(null),
    users: listUsers(),
    limits: LIMITS.map((l, i) => ({ key: l.key, n: i + 1, label: l.label, unit: l.unit, zero: l.zero, value: limitValue(l), display: formatLimit(l) })),
    logs: logsSince(Number(req.query.since) || 0)
  }))

  const handle = fn => (req, res) => {
    try {
      res.json(fn(req) ?? { ok: true })
    } catch (err) {
      res.status(400).json({ error: err.message })
    }
  }

  app.post('/users', handle(req => ({ token: addUser(req.body?.name) })))
  app.delete('/users/:name', handle(req => removeUser(req.params.name)))
  app.put('/limits/:key', handle(req => setLimit(req.params.key, req.body?.value)))
  app.delete('/torrents/:infoHash', handle(req => {
    if (!forceRemove(req.params.infoHash)) throw new Error('No such torrent')
  }))
  // `by` says who asked: "dashboard" (key s) or "npm stop". It ends up in the log.
  app.post('/shutdown', (req, res) => {
    res.json({ ok: true })
    setTimeout(() => stop(`requested by ${String(req.body?.by || 'admin socket').slice(0, 40)}`), 100)
  })

  const server = http.createServer(app)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  fs.chmodSync(socketPath, 0o600)
  process.on('exit', () => { try { fs.unlinkSync(socketPath) } catch {} })
  return server
}

// A socket file left by a crashed server blocks listen(). Remove it, unless a live server
// still answers on it.
async function clearStaleSocket () {
  if (!fs.existsSync(socketPath)) return
  const alive = await new Promise(resolve => {
    const sock = net.connect(socketPath)
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
  if (alive) {
    console.error(`Another server is already running (admin socket ${socketPath}). Use \`npm start dashboard\` to open it.`)
    process.exit(1)
  }
  fs.unlinkSync(socketPath)
}
