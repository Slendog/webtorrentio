import fs from 'node:fs'
import path from 'node:path'
import { format } from 'node:util'
import { stateDir } from './paths.js'

// Keeps the last log lines in memory so the dashboard can show them, writes every line to a
// daily log file, and still writes everything to stdout/stderr as before. Imported first by
// the server so no line is missed.
const MAX_LINES = 5000
const lines = []
let seq = 0

// Daily files in LOG_DIR (default: logs/ next to the state file), kept LOG_RETENTION_DAYS
// days (default 90) and at most LOG_MAX_MB in total (default 500); the oldest days go first.
// Docker's own log keeps only the last 30 MB, so these files are the long-term record.
export const logDir = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(stateDir, 'logs')
const retentionDays = process.env.LOG_RETENTION_DAYS !== undefined ? Number(process.env.LOG_RETENTION_DAYS) : 90
const maxLogBytes = (process.env.LOG_MAX_MB !== undefined ? Number(process.env.LOG_MAX_MB) : 500) * 1024 ** 2
const filesOn = retentionDays > 0
const FILE_RE = /^webtorrentio-(\d{4}-\d{2}-\d{2})\.log$/

// Torrent and file names come from other peers and from index sites. Escape sequences in them
// would be executed by the terminal that shows the log, so control characters are replaced.
// For values inside one log line (names, request headers): no line breaks, so they cannot
// start a fake log line.
export const oneLine = s => String(s).replace(/[\r\n\u2028\u2029]+/g, ' ')

export const safeText = s => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '?')

const dayOf = d => d.toISOString().slice(0, 10)
const fileOf = day => path.join(logDir, `webtorrentio-${day}.log`)

let fileBroken = false
function writeFile (date, level, message) {
  if (!filesOn || fileBroken) return
  try {
    const text = message.split('\n').map(l => `${date.toISOString()} ${level.toUpperCase().padEnd(5)} ${l}`).join('\n') + '\n'
    fs.appendFileSync(fileOf(dayOf(date)), text, { mode: 0o600 })
  } catch (err) {
    // A full or read-only disk must not stop the server; say it once on stderr.
    fileBroken = true
    process.stderr.write(`Log files disabled: cannot write to ${logDir}: ${err.message}\n`)
  }
}

for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console)
  // Terminals show the time already where it matters; log files (background mode) need it.
  const stamp = !process.stdout.isTTY
  const name = level === 'log' ? 'info' : level
  console[level] = (...args) => {
    const now = new Date()
    const time = now.toTimeString().slice(0, 8)
    const message = safeText(format(...args))
    if (stamp) original(`${now.toISOString()} ${message}`)
    else original(message)
    writeFile(now, name, message)
    for (const text of message.split('\n')) {
      lines.push({ seq: ++seq, level: name, text: `${time} ${text}` })
    }
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  }
}

// Lines after `since` (a sequence number the client got from an earlier call).
export function logsSince (since = 0) {
  return { lines: lines.filter(l => l.seq > since), seq }
}

// ---- Log files

// Days with a log file, newest first: [{ day: "2026-09-27", bytes }].
export function logDays () {
  if (!filesOn) return []
  let names = []
  try { names = fs.readdirSync(logDir) } catch { return [] }
  return names.map(n => n.match(FILE_RE)).filter(Boolean)
    .map(m => ({ day: m[1], bytes: fs.statSync(path.join(logDir, m[0])).size }))
    .sort((a, b) => b.day.localeCompare(a.day))
}

// The last `max` lines of one day's file: [{ at (ISO time), level, text }].
export function readLogDay (day, max = 20_000) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Bad day')
  let text
  try {
    const file = fileOf(day)
    const { size } = fs.statSync(file)
    // Read at most the last 8 MB: enough for a busy day, and bounded for the dashboard.
    const start = Math.max(0, size - 8 * 1024 ** 2)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    const m = line.match(/^(\S+) (\w+)\s+(.*)$/)
    if (m) out.push({ at: m[1], level: m[2].toLowerCase(), text: m[3] })
  }
  return out.slice(-max)
}

// Delete days past the retention time, then the oldest days while the total is too large.
function prune () {
  const days = logDays()
  const cutoff = dayOf(new Date(Date.now() - retentionDays * 86_400_000))
  let total = days.reduce((n, d) => n + d.bytes, 0)
  for (const d of [...days].reverse()) {
    if (d.day === dayOf(new Date())) break
    if (d.day >= cutoff && total <= maxLogBytes) continue
    try { fs.rmSync(fileOf(d.day)) } catch {}
    total -= d.bytes
  }
}

if (filesOn) {
  try {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 })
    try { fs.chmodSync(logDir, 0o700) } catch {}
    prune()
    setInterval(prune, 60 * 60 * 1000).unref()
  } catch (err) {
    fileBroken = true
    process.stderr.write(`Log files disabled: cannot create ${logDir}: ${err.message}\n`)
  }
}
