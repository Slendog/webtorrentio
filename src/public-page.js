import { config } from './config.js'
import { roomStatus } from './rooms.js'
import { status } from './torrent.js'
import { page } from './ui.js'
import { prettyTitle as title } from './names.js'

// Read-only page without a token (PUBLIC_DASHBOARD=on): who is watching what right now, and
// the open watch-together rooms. It shows names, never tokens, links or controls.

const clean = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '')

export function publicStatus () {
  const st = status(null)
  const watching = []
  for (const t of st.torrents) {
    for (const w of t.watchers.list) {
      // A room is read once by its host; the room itself is listed below.
      if (w.via?.startsWith('room ')) continue
      watching.push({
        user: clean(w.user),
        title: title(w.file || t.name),
        via: w.via?.startsWith('room ') ? 'Together' : w.via || 'WebTorrent',
        percent: Math.round(w.fraction * 100),
        positionSec: w.positionSec,
        runtimeSec: t.watchers.runtimeSec
      })
    }
  }
  const rooms = roomStatus().map(r => ({
    title: r.title || 'Watch-together room',
    playing: r.playing,
    waiting: r.waiting,
    positionSec: r.position,
    people: r.members.map(m => clean(m.name))
  }))
  return { server: new URL(config.publicUrl).host, watching, rooms, torrents: st.usedSlots, downloadSpeed: st.downloadSpeed, updatedAt: Date.now() }
}

const CSS = `
  .live { display: grid; gap: 12px; margin-top: 28px; }
  .row { display: grid; grid-template-columns: 1fr auto; gap: 4px 16px; align-items: baseline; padding: 16px 18px; border-radius: 14px;
    background: var(--surface); border: 1px solid var(--line); }
  .who { font: 700 17px var(--display); }
  .what { grid-column: 1; color: var(--ink); }
  .meta { grid-column: 2; grid-row: 1 / span 2; text-align: right; color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums; }
  .bar { grid-column: 1 / -1; height: 6px; border-radius: 99px; background: var(--line); overflow: hidden; margin-top: 8px; }
  .bar > div { height: 100%; background: var(--accent); }
  .tag { display: inline-block; font-size: 13px; padding: 1px 9px; border-radius: 99px; background: var(--accent-soft); color: var(--accent); margin-left: 6px; }
  .tag.together { background: color-mix(in srgb, var(--stub) 30%, var(--surface)); color: var(--stub-ink); }
  .empty { color: var(--muted); margin-top: 28px; }
`

const SCRIPT = `
  const clock = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0') }
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  async function refresh () {
    let d
    try { d = await fetch('public/status.json', { cache: 'no-store' }).then(r => r.json()) } catch { return }
    document.getElementById('host').textContent = d.server
    const list = document.getElementById('live'); list.textContent = ''
    for (const w of d.watching) {
      const row = el('div', 'row')
      const who = el('div', 'who', w.user); who.append(el('span', 'tag' + (w.via === 'Together' ? ' together' : ''), w.via))
      row.append(who, el('div', 'what', w.title),
        el('div', 'meta', w.positionSec != null && w.runtimeSec ? 'about ' + clock(w.positionSec) + ' of ' + clock(w.runtimeSec) : w.percent + '%'))
      const bar = el('div', 'bar'); const fill = el('div'); fill.style.width = Math.min(100, w.percent) + '%'; bar.append(fill); row.append(bar)
      list.append(row)
    }
    for (const r of d.rooms) {
      const row = el('div', 'row')
      const who = el('div', 'who', r.people.length ? r.people.join(', ') : 'Nobody yet'); who.append(el('span', 'tag together', 'Together'))
      row.append(who, el('div', 'what', r.title), el('div', 'meta', (r.waiting ? 'waiting' : r.playing ? 'playing' : 'paused') + ' at ' + clock(r.positionSec)))
      list.append(row)
    }
    document.getElementById('empty').hidden = d.watching.length + d.rooms.length > 0
  }
  refresh(); setInterval(refresh, 5000)
`

export const publicPage = () => page({
  title: 'Now watching',
  css: CSS,
  body: `
    <p class="host" id="host"></p>
    <h1>Now watching</h1>
    <p class="lead">Who is watching what on this server right now. Updates every few seconds.</p>
    <div class="live" id="live"></div>
    <p class="empty" id="empty" hidden>Nobody is watching right now.</p>`,
  script: SCRIPT
})
