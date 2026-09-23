import readline from 'node:readline'
import { adminRequest } from './client.js'

// Full-screen terminal dashboard: live torrents, users, limits and log, plus keys to add or
// remove users and change limits while the server runs. It is a client of the server's admin
// socket, so it can be closed and reopened while the server keeps running.
// Plain ANSI escape codes, no dependencies.

const ESC = '\x1b['
const c = {
  bold: s => `${ESC}1m${s}${ESC}22m`,
  dim: s => `${ESC}2m${s}${ESC}22m`,
  green: s => `${ESC}32m${s}${ESC}39m`,
  blue: s => `${ESC}34m${s}${ESC}39m`,
  yellow: s => `${ESC}33m${s}${ESC}39m`,
  red: s => `${ESC}31m${s}${ESC}39m`,
  cyan: s => `${ESC}36m${s}${ESC}39m`,
  inverse: s => `${ESC}7m${s}${ESC}27m`
}

// Names come from peers and index sites; never let them reach the terminal as control codes.
const safe = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '?')

const visible = s => s.replace(/\x1b\[[0-9;]*m/g, '')

// Cut or pad a line to exactly `width` visible characters, keeping color codes intact.
function fit (s, width) {
  let out = ''
  let n = 0
  for (const part of s.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith('\x1b[')) { out += part; continue }
    for (const ch of part) {
      if (n >= width) break
      out += ch
      n++
    }
  }
  return out + ' '.repeat(Math.max(0, width - n)) + `${ESC}0m`
}

const pad = (s, w, right = false) => {
  s = String(s)
  const len = visible(s).length
  if (len >= w) return visible(s).slice(0, Math.max(0, w - 1)) + (w > 0 ? '…' : '')
  return right ? ' '.repeat(w - len) + s : s + ' '.repeat(w - len)
}

function bytes (n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  return (n / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + u[i]
}
const speed = n => bytes(n) + '/s'

function duration (ms) {
  if (ms == null || !Number.isFinite(ms)) return '-'
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return s + 's'
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
  return Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm'
}

// Seconds -> "1:02:03" or "2:03".
function clock (sec) {
  sec = Math.max(0, Math.round(sec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec % 3600 / 60)
  const s = String(sec % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

const section = (title, width) => c.dim('── ') + c.bold(title) + ' ' + c.dim('─'.repeat(Math.max(0, width - title.length - 4)))

export async function startTui () {
  const out = process.stdout
  if (!out.isTTY || !process.stdin.isTTY) {
    console.error('The dashboard needs an interactive terminal.')
    process.exit(1)
  }

  // ---- Server state, refreshed every second over the admin socket.
  let data = null
  let logSeq = 0
  let failures = 0
  const logs = []

  async function poll () {
    try {
      const next = await adminRequest('GET', `/state?since=${logSeq}`)
      failures = 0
      logs.push(...next.logs.lines)
      if (logs.length > 500) logs.splice(0, logs.length - 500)
      logSeq = next.logs.seq
      data = next
      scheduleRender()
    } catch (err) {
      if (++failures >= 3) leave(`Lost connection to the server: ${err.message}`)
    }
  }

  // ---- UI state
  let showTokens = false
  let prompt = null // { label, value, onSubmit }
  let message = null // { text, level, sticky }
  let messageTimer = null
  let torrents = []

  const flash = (text, level = 'info', sticky = false) => {
    message = { text, level, sticky }
    clearTimeout(messageTimer)
    if (!sticky) messageTimer = setTimeout(() => { message = null; scheduleRender() }, 6000)
    scheduleRender()
  }

  const ask = (label, onSubmit) => {
    prompt = { label, value: '', onSubmit }
    message = null
    scheduleRender()
  }

  // ---- Rendering
  let pending = false
  function scheduleRender () {
    if (pending) return
    pending = true
    setImmediate(() => { pending = false; render() })
  }

  function render () {
    if (!data) return
    const width = out.columns || 100
    const height = out.rows || 30
    const st = data.status
    torrents = st.torrents
    const lines = []

    // Header
    const disk = st.disk.limit ? `${bytes(st.disk.used)} / ${bytes(st.disk.limit)}` : `${bytes(st.disk.used)} (no limit)`
    lines.push(c.inverse(fit(` WebTorrent Scraper  ${c.green('↓ ' + speed(st.downloadSpeed))}  ${c.blue('↑ ' + speed(st.uploadSpeed))}  ` +
      `disk ${disk}  torrents ${st.usedSlots}/${st.maxActiveTorrents}${st.torrents.length > st.usedSlots ? ` (+${st.torrents.length - st.usedSlots} prefetched)` : ''}  ${data.publicUrl}  pid ${data.pid}, up ${duration(data.uptime)}`, width)))
    lines.push('')

    // Torrents
    lines.push(section(`Torrents (${torrents.length})`, width))
    const nameW = Math.max(16, width - 88)
    lines.push(c.dim(`  #  ${pad('NAME', nameW)} ${pad('USERS', 12)} ${pad('DOWN', 11, true)} ${pad('UP', 10, true)} ${pad('PEERS', 8, true)} ${pad('ON DISK', 20, true)} ${pad('STATE', 18)}`))
    if (!torrents.length) lines.push(c.dim('     No active torrents. Start a stream in Stremio.'))
    torrents.forEach((t, i) => {
      const state = t.prefetched ? c.cyan(`${t.nextEpisode ? 'next episode' : 'prefetched'}${t.ready ? '' : ', loading'}, ${duration(t.removesAt - Date.now())}`) : !t.ready ? c.yellow('loading') : t.connections ? c.green(`▶ ${t.connections} connection${t.connections > 1 ? 's' : ''}`) : c.dim(`idle, ${duration(t.removesAt - Date.now())}`)
      const disk = bytes(t.onDisk) + (st.disk.perStreamLimit ? c.dim('/' + bytes(st.disk.perStreamLimit)) : '')
      lines.push(`  ${pad(i + 1, 2)} ${pad(safe(t.name), nameW)} ${pad(safe(t.users.join(',')) || '-', 12)} ${pad(c.green(speed(t.downloadSpeed)), 11, true)} ` +
        `${pad(c.blue(speed(t.uploadSpeed)), 10, true)} ${pad(`${t.peers.connected}(${t.peers.seeders}s)`, 8, true)} ${pad(disk, 20, true)} ${state}`)
      if (t.watchers.list.length) {
        const w = t.watchers
        lines.push('       ' + c.cyan('Watching: ') + w.list.map(x => {
          if (x.positionSec == null) return `${safe(x.user)} at ${(x.fraction * 100).toFixed(1)}%`
          const gap = w.list.length > 1 ? (x.behindSec > 0 ? c.red(` ${clock(x.behindSec)} behind`) : c.green(' ahead')) : ''
          return `${safe(x.user)} ≈ ${c.bold(clock(x.positionSec))}/${clock(w.runtimeSec)}${gap}`
        }).join('   '))
      }
      for (const v of t.viewers) {
        const pct = v.target ? Math.min(1, v.bufferedAhead / v.target) : 1
        const barW = 20
        const bar = c.green('█'.repeat(Math.round(pct * barW))) + c.dim('░'.repeat(barW - Math.round(pct * barW)))
        lines.push(c.dim(`       └ ${safe(v.user)} at ${(v.position / v.length * 100).toFixed(1)}%  `) + bar +
          c.dim(`  ${bytes(v.bufferedAhead)} of ${bytes(v.target)} ahead`))
      }
    })
    lines.push('')

    // Users
    const users = data.users
    lines.push(section(`Users (${users.length})${users.length ? '' : ' - open access, anyone can use the addon'}`, width))
    if (!users.length) lines.push(c.dim('     No users. Press [a] to add one; tokens are then required.'))
    for (const u of users) {
      const url = showTokens ? `${data.publicUrl}/${u.token}/` : `${data.publicUrl}/${u.token.slice(0, 4)}${'•'.repeat(12)}/`
      lines.push(`     ${pad(safe(u.user), 16)} ${pad(c.dim(u.source === 'env' ? 'env' : 'runtime'), 8)} ${url}`)
    }
    lines.push('')

    // Limits
    lines.push(section('Limits', width))
    const cells = data.limits.map(l => `${c.cyan(`[${l.n}]`)} ${l.label}: ${c.bold(l.display)}`)
    let row = '    '
    for (const cell of cells) {
      if (visible(row + cell).length + 3 > width) { lines.push(row); row = '    ' }
      row += cell + '   '
    }
    lines.push(row)
    lines.push('')

    // Footer (help + prompt/message), then the log fills what is left.
    const footer = []
    if (prompt) {
      footer.push(c.bold(prompt.label) + ' ' + prompt.value + c.inverse(' '))
      footer.push(c.dim('Enter to confirm, Esc to cancel'))
    } else {
      const color = { info: c.green, warn: c.yellow, error: c.red }[message?.level] || (s => s)
      footer.push(message ? color(message.text) : '')
      footer.push(c.dim('[a] add user  [d] delete user  [t] ' + (showTokens ? 'hide' : 'show') + ' tokens  [1-6] edit limit  [x] remove torrent  ' +
        '[b] background (keep server running)  [s] stop server'))
    }

    const logRows = Math.max(1, height - lines.length - footer.length - 1)
    lines.push(section('Log', width))
    const shown = logs.slice(-logRows + 1)
    for (const l of shown) {
      const text = safe(l.text)
      lines.push(l.level === 'error' ? c.red(text) : l.level === 'warn' ? c.yellow(text) : c.dim(text))
    }
    while (lines.length < height - footer.length) lines.push('')
    lines.length = height - footer.length
    lines.push(...footer)

    out.write(`${ESC}H` + lines.map(l => fit(l, width)).join('\r\n'))
  }

  // ---- Actions
  const act = async (fn, done) => {
    try {
      const result = await fn()
      done?.(result)
      await poll()
    } catch (err) {
      flash(err.message, 'error')
    }
  }

  function handleKey (str, key) {
    if (key?.ctrl && key.name === 'c') return leave()

    if (prompt) {
      if (key?.name === 'escape') { prompt = null; return scheduleRender() }
      if (key?.name === 'return' || key?.name === 'enter') {
        const { value, onSubmit } = prompt
        prompt = null
        onSubmit(value.trim())
        return scheduleRender()
      }
      if (key?.name === 'backspace') prompt.value = prompt.value.slice(0, -1)
      else if (str && !key?.ctrl && !key?.meta && str >= ' ') prompt.value += str
      return scheduleRender()
    }

    // Any key dismisses a sticky message (like a new install link) and does nothing else.
    if (message?.sticky) { message = null; return scheduleRender() }
    if (!data) return

    switch (str) {
      case 'a':
        return ask('New user name:', name => act(
          () => adminRequest('POST', '/users', { name }),
          ({ token }) => flash(`Added ${name}. Install page: ${data.publicUrl}/${token}/   (any key to dismiss)`, 'info', true)))
      case 'd': {
        const names = data.users.filter(u => u.source === 'runtime').map(u => u.user)
        if (!names.length) return flash('No runtime users to delete (users from ACCESS_TOKENS are removed in the environment).', 'warn')
        return ask(`Delete which user? (${names.join(', ')}):`, name => act(
          () => adminRequest('DELETE', `/users/${encodeURIComponent(name)}`),
          () => flash(`Deleted ${name}. Their install links stop working now.`)))
      }
      case 't':
        showTokens = !showTokens
        return scheduleRender()
      case 'x':
        if (!torrents.length) return flash('No torrents to remove.', 'warn')
        return ask(`Remove torrent # (1-${torrents.length}); stops it for everyone:`, n => {
          const t = torrents[Number(n) - 1]
          if (!t) return flash(`No torrent #${n}`, 'error')
          act(() => adminRequest('DELETE', `/torrents/${t.infoHash}`), () => flash(`Removed ${safe(t.name)}`))
        })
      case 'b':
      case 'q':
        return leave()
      case 's':
        return ask('Stop the server? Streams end and torrent data is deleted (y/n):', a => {
          if (!/^y/i.test(a)) return
          act(() => adminRequest('POST', '/shutdown', { by: 'dashboard (key s)' }), () => leave('Server stopped.', true))
        })
      default: {
        const l = data.limits.find(x => String(x.n) === str)
        if (!l) return
        const hint = `${l.unit ? ` in ${l.unit}` : ''}${l.zero ? `, 0 = ${l.zero}` : ''}`
        return ask(`${l.label}${hint} (now ${Number(l.value.toFixed(2))}):`, v => act(
          () => adminRequest('PUT', `/limits/${l.key}`, { value: v }),
          () => flash(`${l.label} set to ${v}${l.unit ? ' ' + l.unit : ''}. Saved to ${data.statePath}`)))
      }
    }
  }

  // Close the dashboard. The server keeps running unless it was just stopped.
  let leaving = false
  function leave (reason, stopped = false) {
    if (leaving) return
    leaving = true
    restore()
    if (reason) console.log(reason)
    if (!stopped && !reason) console.log('Dashboard closed; the server keeps running. Reopen: npm start dashboard   Stop: npm stop')
    process.exit(0)
  }

  let restored = false
  function restore () {
    if (restored) return
    restored = true
    out.write(`${ESC}?25h${ESC}?1049l`)
    try { process.stdin.setRawMode(false) } catch {}
  }

  // ---- Start
  await poll()
  if (!data) {
    console.error('Cannot reach the server.')
    process.exit(1)
  }
  out.write(`${ESC}?1049h${ESC}?25l${ESC}2J`)
  readline.emitKeypressEvents(process.stdin)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('keypress', handleKey)
  out.on('resize', () => { out.write(`${ESC}2J`); scheduleRender() })
  process.on('exit', restore)
  setInterval(poll, 1000)
  render()
}
