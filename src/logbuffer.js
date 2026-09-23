import { format } from 'node:util'

// Keeps the last log lines in memory so the dashboard can show them, while still writing
// everything to stdout/stderr as before. Imported first by the server so no line is missed.
const MAX_LINES = 1000
const lines = []
let seq = 0

// Torrent and file names come from other peers and from index sites. Escape sequences in them
// would be executed by the terminal that shows the log, so control characters are replaced.
export const safeText = s => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '?')

for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console)
  // Terminals show the time already where it matters; log files (background mode) need it.
  const stamp = !process.stdout.isTTY
  console[level] = (...args) => {
    const time = new Date().toTimeString().slice(0, 8)
    const message = safeText(format(...args))
    if (stamp) original(`${new Date().toISOString()} ${message}`)
    else original(message)
    for (const text of message.split('\n')) {
      lines.push({ seq: ++seq, level: level === 'log' ? 'info' : level, text: `${time} ${text}` })
    }
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  }
}

// Lines after `since` (a sequence number the client got from an earlier call).
export function logsSince (since = 0) {
  return { lines: lines.filter(l => l.seq > since), seq }
}
