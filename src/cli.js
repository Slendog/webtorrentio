import crypto from 'node:crypto'
import { adminRequest } from './client.js'
import { commands } from './runtime.js'

// Command-line management of a running server, over its admin socket (the same connection the
// TUI dashboard uses): users, tokens, install links, limits, torrents, rooms and logs.
// Every command takes --json for scripts.

const tty = process.stdout.isTTY
const paint = code => s => tty ? `\x1b[${code}m${s}\x1b[0m` : String(s)
const dim = paint(2)
const bold = paint(1)
const red = paint(31)
const yellow = paint(33)
const cyan = paint(36)

// Names come from peers and index sites: never print control characters.
const safe = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '?')

function table (rows, headers) {
  const cells = [headers, ...rows].map(r => r.map(c => safe(c)))
  const widths = headers.map((_, i) => Math.max(...cells.map(r => r[i].length)))
  const line = r => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()
  console.log(bold(line(cells[0])))
  for (const r of cells.slice(1)) console.log(line(r))
}

function bytes (n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  return (n / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + u[i]
}
const duration = ms => {
  const s = Math.round(ms / 1000)
  return s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`
}

class UsageError extends Error {}

const state = () => adminRequest('GET', '/state?logs=0')
const out = (json, data, print) => json ? console.log(JSON.stringify(data, null, 2)) : print(data)

// ---- Commands

const HELP = {
  status: 'Server overview: uptime, torrents, disk, conversions, rooms.',
  users: 'List users.  users add <name> | users remove <name> | users token <name> (new token)',
  links: 'Install links of all users, or links <name>.',
  limits: 'List limits.  limits set <number|key> <value>',
  torrents: 'List torrents.  torrents remove <number|infoHash>',
  rooms: 'List watch-together rooms.  rooms close <number|id>',
  logs: 'Show log lines.  logs [-n 50] [--day YYYY-MM-DD] [--grep text] [--activity] [-f]   logs days',
  token: 'Print a new random token (for ACCESS_TOKENS). Needs no server.',
  dashboard: 'Open the TUI dashboard (starts a server in the background if none runs).',
  background: 'Start the server in the background.',
  stop: 'Stop the server.'
}

function help () {
  console.log(`Usage: ${commands.cli} <command> [arguments] [--json]\n`)
  for (const [name, text] of Object.entries(HELP)) console.log(`  ${cyan(name.padEnd(11))} ${text}`)
  console.log(`\nWithout a command, the server starts in the foreground.`)
}

async function status ({ json }) {
  const s = await state()
  out(json, s, s => {
    const st = s.status
    console.log(`${bold('webtorrentio')}  pid ${s.pid}, up ${duration(s.uptime)}, ${s.publicUrl}`)
    console.log(`  Speed      ↓ ${bytes(st.downloadSpeed)}/s  ↑ ${bytes(st.uploadSpeed)}/s`)
    console.log(`  Torrents   ${st.usedSlots} of ${st.maxActiveTorrents}${st.torrents.length > st.usedSlots ? ` (+${st.torrents.length - st.usedSlots} prefetched)` : ''}`)
    console.log(`  Disk       ${bytes(st.disk.used)}${st.disk.limit ? ` of ${bytes(st.disk.limit)}` : ''}, header/index cache ${bytes(st.edgeCache.bytes)}`)
    const c = s.conversions
    console.log(`  Stereo     ${!c.ffmpeg ? 'unavailable (no ffmpeg)' : c.limit ? `${c.active.length} of ${c.limit} conversions running` : 'off'}`)
    console.log(`  Rooms      ${s.rooms.length} open`)
    console.log(`  Users      ${s.users.length ? s.users.map(u => safe(u.user)).join(', ') : 'none (open access)'}`)
  })
}

async function users ({ args, json }) {
  const [sub, name] = args
  if (!sub || sub === 'list') {
    const s = await state()
    return out(json, s.users.map(({ user, source, createdAt }) => ({ user, source, createdAt })), list => {
      if (!list.length) return console.log('No users: the addon is open to anyone who can reach it. Add one with: users add <name>')
      table(list.map(u => [u.user, u.source === 'env' ? 'ACCESS_TOKENS' : 'added at runtime', u.createdAt?.slice(0, 10) || '']), ['USER', 'SOURCE', 'ADDED'])
    })
  }
  if (!name) throw new UsageError(`users ${sub} needs a user name`)
  if (sub === 'add') {
    await adminRequest('POST', '/users', { name })
    return links({ args: [name], json }, `Added ${name}.`)
  }
  if (sub === 'remove' || sub === 'delete') {
    await adminRequest('DELETE', `/users/${encodeURIComponent(name)}`)
    return out(json, { removed: name }, () => console.log(`Removed ${name}. Their links stop working now.`))
  }
  if (sub === 'token') {
    await adminRequest('POST', `/users/${encodeURIComponent(name)}/token`)
    return links({ args: [name], json }, `New token for ${name}; the old links stop working now. Reinstall the addon in Stremio with:`)
  }
  throw new UsageError(`Unknown: users ${sub}`)
}

async function links ({ args, json }, intro) {
  const [name] = args
  const res = await adminRequest('GET', `/links${name ? `?user=${encodeURIComponent(name)}` : ''}`)
  out(json, res, ({ links, https }) => {
    if (intro) console.log(intro + '\n')
    for (const l of links) {
      console.log(bold(l.user ? `${safe(l.user)}${l.source === 'env' ? dim(' (ACCESS_TOKENS)') : ''}` : 'Open access (no users)'))
      console.log(`  Install page   ${l.installPage}`)
      console.log(`  Stremio link   ${l.stremio}${https ? '' : yellow('  (needs HTTPS; paste the manifest instead)')}`)
      console.log(`  Manifest       ${l.manifest}`)
      if (l.together) console.log(`  Together       ${l.together}`)
      console.log(`  Configure      ${l.configure}`)
      console.log(`  Dashboard      ${l.dashboard}`)
      console.log('')
    }
    console.log(dim('Each link contains the user\'s token: send it only to that person.'))
  })
}

async function limits ({ args, json }) {
  const [sub, which, value] = args
  const s = await state()
  if (!sub || sub === 'list') {
    return out(json, s.limits, list => table(list.map(l => [String(l.n), l.key, l.label, l.display]), ['#', 'KEY', 'LIMIT', 'VALUE']))
  }
  if (sub !== 'set') throw new UsageError(`Unknown: limits ${sub}`)
  const l = s.limits.find(x => String(x.n) === which || x.key === which)
  if (!l || value === undefined) throw new UsageError('limits set <number|key> <value>, for example: limits set 7 3')
  await adminRequest('PUT', `/limits/${l.key}`, { value })
  const now = (await state()).limits.find(x => x.key === l.key)
  out(json, now, n => console.log(`${n.label}: ${n.display} (saved to ${s.statePath})`))
}

async function torrents ({ args, json }) {
  const [sub, which] = args
  const s = await state()
  const list = s.status.torrents
  if (!sub || sub === 'list') {
    return out(json, list, list => {
      if (!list.length) return console.log('No torrents.')
      table(list.map((t, i) => [String(i + 1), t.name.slice(0, 60), t.users.join(',') || '-', `${bytes(t.downloadSpeed)}/s`, `${t.peers.connected}`, bytes(t.onDisk),
        t.prefetched ? (t.nextEpisode ? 'next episode' : 'prefetched') : !t.ready ? 'loading' : t.connections ? `${t.connections} connection(s)` : 'idle', t.infoHash.slice(0, 8)]),
      ['#', 'NAME', 'USERS', 'DOWN', 'PEERS', 'ON DISK', 'STATE', 'HASH'])
    })
  }
  if (sub !== 'remove') throw new UsageError(`Unknown: torrents ${sub}`)
  const t = list[Number(which) - 1] || list.find(x => which && x.infoHash.startsWith(which.toLowerCase()))
  if (!t) throw new UsageError(`No torrent ${which ?? ''}`)
  await adminRequest('DELETE', `/torrents/${t.infoHash}`)
  out(json, { removed: t.infoHash }, () => console.log(`Removed ${safe(t.name)}`))
}

async function rooms ({ args, json }) {
  const [sub, which] = args
  const list = (await state()).rooms
  if (!sub || sub === 'list') {
    return out(json, list, list => {
      if (!list.length) return console.log('No watch-together rooms.')
      table(list.map((r, i) => [String(i + 1), r.id, (r.name || r.infoHash).slice(0, 50), r.host, r.waiting ? 'waiting' : r.playing ? 'playing' : 'paused',
        r.members.map(m => m.name + (m.buffering ? ' (buffering)' : '')).join(', ') || '-']), ['#', 'ID', 'TORRENT', 'HOST', 'STATE', 'PEOPLE'])
    })
  }
  if (sub !== 'close') throw new UsageError(`Unknown: rooms ${sub}`)
  const r = list[Number(which) - 1] || list.find(x => x.id === which)
  if (!r) throw new UsageError(`No room ${which ?? ''}`)
  await adminRequest('DELETE', `/rooms/${r.id}`)
  out(json, { closed: r.id }, () => console.log(`Closed room ${r.id}`))
}

const color = l => l.level === 'error' ? red : l.level === 'warn' ? yellow : /\[(watch|room)\]/.test(l.text) ? cyan : s => s

async function logs ({ args, json, opts }) {
  if (args[0] === 'days') {
    const res = await adminRequest('GET', '/logs')
    return out(json, res, r => {
      if (!r.days.length) return console.log(`No log files in ${r.dir}.`)
      table(r.days.map(d => [d.day, bytes(d.bytes)]), ['DAY', 'SIZE'])
      console.log(dim(`\n${r.dir}`))
    })
  }
  const n = Number(opts.n ?? 50)
  const grep = opts.grep?.toLowerCase()
  const keep = l => (!opts.activity || /\[(watch|room)\]/.test(l.text)) && (!grep || l.text.toLowerCase().includes(grep))
  const localTime = iso => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : `${d.toLocaleDateString('sv')} ${d.toTimeString().slice(0, 8)}` }
  const print = l => console.log(color(l)(safe(`${localTime(l.at)} ${l.level === 'info' ? '' : l.level.toUpperCase() + ' '}${l.text}`)))

  const day = opts.day || new Date().toISOString().slice(0, 10)
  const { lines } = await adminRequest('GET', `/logs/${day}`)
  const shown = lines.filter(keep).slice(-n)
  if (json && !opts.f) return console.log(JSON.stringify(shown, null, 2))
  shown.forEach(print)
  if (!opts.f) return

  // Follow: new lines from the server's memory, like tail -f.
  let { logs: { seq } } = await adminRequest('GET', '/state?logs=0')
  for (;;) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    const next = await adminRequest('GET', `/state?since=${seq}`)
    seq = next.logs.seq
    for (const l of next.logs.lines) {
      // Memory lines carry "HH:MM:SS text"; show them like the file lines.
      const line = { at: new Date().toISOString(), level: l.level, text: l.text.replace(/^\d\d:\d\d:\d\d /, '') }
      if (keep(line)) json ? console.log(JSON.stringify(line)) : print(line)
    }
  }
}

const token = ({ json }) => out(json, { token: crypto.randomBytes(24).toString('base64url') }, t => console.log(t.token))

const COMMANDS = { status, users, user: users, links, link: links, limits, limit: limits, torrents, torrent: torrents, rooms, room: rooms, logs, log: logs, token }

export const isCliCommand = name => name in COMMANDS || ['help', '--help', '-h'].includes(name)

// Split "a b --json -n 20 --day X -f" into positional arguments and options.
function parse (argv) {
  const args = []
  const opts = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const m = a.match(/^--?([\w-]+)(?:=(.*))?$/)
    if (!m) { args.push(a); continue }
    const [, key, inline] = m
    if (['json', 'activity', 'f', 'follow'].includes(key)) opts[key === 'follow' ? 'f' : key] = true
    else opts[key] = inline ?? argv[++i]
  }
  return { args, opts, json: Boolean(opts.json) }
}

export async function runCli (name, argv) {
  if (['help', '--help', '-h'].includes(name)) return help()
  try {
    await COMMANDS[name](parse(argv))
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n  ${cyan(name)}  ${HELP[name] || HELP[name + 's'] || ''}`)
    } else if (/ENOENT|ECONNREFUSED/.test(err.code || err.message)) {
      console.error(`No server running. Start one with: ${commands.start}`)
    } else {
      console.error(err.message)
    }
    process.exit(1)
  }
}
