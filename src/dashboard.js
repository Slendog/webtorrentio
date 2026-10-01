import { TOKENS } from './ui.js'

// The web dashboard ("What is playing"), shared by every user of the server: what is playing,
// who watches it and how far they are, what is loaded ahead, and the server's totals. Polls
// /status. Technical figures (peers, disk, upload, search results) sit under "Details".
export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>What is playing</title>
<style>
  ${TOKENS}
  :root { --down: var(--accent); --up: #3f7fd6; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 var(--font); }
  main { max-width: 980px; margin: 0 auto; padding: 32px 18px 56px; }
  h1 { margin: 0; font: 800 clamp(28px, 5vw, 36px)/1.15 var(--display); letter-spacing: -0.02em; }
  h2 { margin: 34px 0 12px; font: 700 18px var(--display); }
  h2 small { font: 400 14px var(--font); color: var(--muted); margin-left: 8px; }
  .muted { color: var(--muted); }
  .intro { color: var(--muted); margin: 8px 0 0; max-width: 70ch; }

  /* Server totals: a value and a short explanation under it; nothing is cut off. */
  .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 22px; }
  .total { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
  .total .label { font-size: 13px; color: var(--muted); }
  .total .value { font: 700 20px/1.3 var(--display); font-variant-numeric: tabular-nums; }
  .total .note { font-size: 13px; color: var(--muted); }

  .item { background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 16px 18px; margin-bottom: 12px; }
  .head { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
  .title { font: 700 17px/1.3 var(--display); overflow-wrap: anywhere; }
  .release { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
  .state { margin-top: 8px; }
  .state b { color: var(--accent); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; flex: none; }
  button { font: 600 13px var(--font); color: var(--danger); background: transparent; border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px; cursor: pointer; }
  button:hover { border-color: var(--danger); }
  button.soft { color: var(--ink); }
  a.join { font-weight: 700; color: var(--accent); text-decoration: none; padding: 6px 12px; border: 1px solid var(--accent); border-radius: 999px; font-size: 13px; }
  :focus-visible { outline: 3px solid var(--stub); outline-offset: 2px; }

  /* One line per person watching. */
  .person { margin-top: 12px; }
  .person-top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; }
  .person-top .who { font-weight: 700; }
  .via { font-size: 12px; padding: 1px 8px; border-radius: 99px; background: var(--accent-soft); color: var(--accent); margin-left: 6px; font-weight: 600; }
  .bar { position: relative; height: 8px; border-radius: 99px; background: var(--line); overflow: hidden; margin-top: 6px; }
  .bar .done { position: absolute; inset: 0 auto 0 0; background: var(--accent); }
  .bar .ahead { position: absolute; top: 0; bottom: 0; background: color-mix(in srgb, var(--accent) 35%, var(--line)); }
  .person .note { font-size: 13px; color: var(--muted); margin-top: 3px; }
  .speed { margin-top: 12px; font-size: 14px; color: var(--muted); }

  details { margin-top: 12px; }
  summary { cursor: pointer; font-size: 14px; color: var(--muted); width: fit-content; }
  .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px 18px; margin: 12px 0 0; }
  .facts dt { font-size: 13px; color: var(--muted); }
  .facts dd { margin: 0; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  svg.spark { width: 100%; height: 38px; margin-top: 12px; display: block; }
  .people { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { font-size: 13px; padding: 2px 10px; border-radius: 99px; border: 1px solid var(--line); }
  .empty { color: var(--muted); padding: 28px 0 8px; }
  .error { color: var(--danger); }
</style>
</head>
<body>
<main>
  <h1>What is playing</h1>
  <p class="intro" id="intro"></p>
  <div class="totals" id="totals"></div>
  <div id="rooms"></div>
  <div id="groups"></div>
</main>
<script>
  const HISTORY = 60
  const history = new Map()
  const open = new Set() // torrents whose Details are open, kept across refreshes

  const bytes = n => {
    if (!n) return '0 B'
    const u = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
    return (n / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + u[i]
  }
  const speed = n => bytes(n) + '/s'
  const duration = ms => {
    if (ms == null || !isFinite(ms)) return 'a moment'
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return s + ' s'
    if (s < 3600) return Math.floor(s / 60) + ' min' + (s % 60 ? ' ' + (s % 60) + ' s' : '')
    return Math.floor(s / 3600) + ' h ' + Math.floor(s % 3600 / 60) + ' min'
  }
  const clock = sec => {
    sec = Math.max(0, Math.round(sec))
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), ss = String(sec % 60).padStart(2, '0')
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss
  }
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  let me = null
  const name = u => u === me ? 'You' : esc(u)

  function spark (points) {
    const max = Math.max(1, ...points.flatMap(p => [p.d, p.u]))
    const line = key => points.map((p, i) => (i * 100 / (HISTORY - 1)).toFixed(1) + ',' + (36 - p[key] / max * 34).toFixed(1)).join(' ')
    return '<svg class="spark" viewBox="0 0 100 38" preserveAspectRatio="none" aria-label="Download and upload speed, last 90 seconds">' +
      '<polyline fill="none" stroke="var(--down)" stroke-width="1.5" vector-effect="non-scaling-stroke" points="' + line('d') + '"/>' +
      '<polyline fill="none" stroke="var(--up)" stroke-width="1.5" vector-effect="non-scaling-stroke" points="' + line('u') + '"/></svg>'
  }

  const total = (label, value, note) =>
    '<div class="total"><div class="label">' + label + '</div><div class="value">' + value + '</div>' + (note ? '<div class="note">' + note + '</div>' : '') + '</div>'

  // What is going on with a torrent, in one sentence.
  function stateText (t) {
    if (!t.ready) return 'Connecting to the torrent…'
    if (t.prefetched) return (t.nextEpisode ? 'Next episode, loaded ahead for binge watching.' : 'Loaded ahead so it starts at once if someone picks it.') +
      ' Removed in ' + duration(t.removesAt - Date.now()) + ' if nobody plays it.'
    if (t.connections) {
      const who = t.users.map(name).join(', ')
      return '<b>Playing</b>' + (who ? ' for ' + who : '') + '.'
    }
    return 'Nobody is watching. Removed in ' + duration(t.removesAt - Date.now()) + '.'
  }

  // One row per person: where they are, how much is ready ahead, and how they watch.
  function people (t) {
    return t.watchers.list.map(w => {
      const v = t.viewers.filter(x => x.user === w.user && x.file === w.file).sort((a, b) => b.position - a.position)[0]
      const where = w.positionSec != null && t.watchers.runtimeSec
        ? 'about ' + clock(w.positionSec) + ' of ' + clock(t.watchers.runtimeSec)
        : Math.round(w.fraction * 100) + '% into the file'
      const done = Math.min(100, w.fraction * 100)
      const ahead = v && v.length ? Math.min(100 - done, v.bufferedAhead / v.length * 100) : 0
      const via = w.via && w.via.startsWith('room ') ? 'Together' : (w.via || 'WebTorrent')
      const behind = t.watchers.list.length > 1 && w.behindSec > 5 ? ', ' + clock(w.behindSec) + ' behind' : ''
      // In a season pack people can watch different episodes of the same torrent.
      const episode = w.title && w.title !== t.title ? ' <span class="muted">' + esc(w.title) + '</span>' : ''
      return '<div class="person"><div class="person-top"><span><span class="who">' + name(w.user) + '</span><span class="via">' + esc(via) + '</span>' + episode + '</span>' +
        '<span class="muted">' + where + behind + '</span></div>' +
        '<div class="bar" role="img" aria-label="' + Math.round(done) + '% watched"><div class="done" style="width:' + done.toFixed(1) + '%"></div>' +
        '<div class="ahead" style="left:' + done.toFixed(1) + '%;width:' + ahead.toFixed(1) + '%"></div></div>' +
        (v ? '<div class="note">' + bytes(v.bufferedAhead) + ' ready ahead' + (v.target && v.bufferedAhead < v.target / 4 ? ', still loading' : '') + '</div>' : '') + '</div>'
    }).join('')
  }

  function actions (t) {
    let html = ''
    if (t.mine && t.othersWatching) html += '<button class="soft" data-stop="' + t.infoHash + '">Stop my stream</button>'
    if (t.canRemove) html += '<button data-remove="' + t.infoHash + '"' + (t.othersWatching ? ' data-others="1"' : '') + '>' + (t.othersWatching ? 'Stop for everyone' : 'Remove') + '</button>'
    return html ? '<div class="actions">' + html + '</div>' : ''
  }

  function details (t, diskPerStream) {
    const s = t.scraped
    const facts = [
      ['Downloaded', (t.progress * 100).toFixed(1) + '% of ' + bytes(t.length) + (t.timeRemaining != null && t.progress < 1 && t.downloadSpeed > 1024 ? ', all of it in ' + duration(t.timeRemaining) : '')],
      ['On this server’s disk', bytes(t.onDisk) + (diskPerStream ? ' of at most ' + bytes(diskPerStream) : '')],
      ['Download window', bytes(t.readahead) + ' ahead of each viewer'],
      ['Uploaded to others', bytes(t.uploaded)],
      ['People sharing it', t.peers.connected + ' connected, ' + t.peers.seeders + ' with the whole file'],
      ['Open connections', t.connections + (t.connections > 1 ? ' (players open several)' : '')],
      s ? ['Found on', esc(s.source) + (s.quality ? ', ' + esc(s.quality) : '') + ', ' + (s.seeders ?? '?') + ' seeders and ' + (s.leechers ?? '?') + ' leechers at search time'] : null,
      ['Torrent', '<span class="release">' + esc(t.name) + '</span>']
    ].filter(Boolean)
    return '<details data-hash="' + t.infoHash + '"' + (open.has(t.infoHash) ? ' open' : '') + '><summary>Details</summary>' +
      '<dl class="facts">' + facts.map(([k, v]) => '<div><dt>' + k + '</dt><dd>' + v + '</dd></div>').join('') + '</dl>' +
      spark(history.get(t.infoHash) || []) + '</details>'
  }

  // Quality, size and where it was found: tells apart releases of the same title.
  function release (t) {
    const s = t.scraped
    const parts = [s && s.quality, t.length ? bytes(t.length) : null, s && s.source ? 'from ' + s.source : null].filter(Boolean)
    const file = t.playing[0] && t.playing[0].name
    return (parts.length ? '<div class="release">' + esc(parts.join(', ')) + '</div>' : '') +
      (file ? '<div class="release">' + esc(file) + '</div>' : '')
  }

  function item (t, diskPerStream) {
    return '<div class="item"><div class="head"><div><div class="title">' + esc(t.title || t.name) + '</div>' +
      release(t) + '</div>' + actions(t) + '</div>' +
      '<div class="state">' + stateText(t) + '</div>' + people(t) +
      (t.ready ? '<div class="speed">↓ ' + speed(t.downloadSpeed) + ' from ' + t.peers.connected + (t.peers.connected === 1 ? ' person' : ' people') + ', ↑ ' + speed(t.uploadSpeed) + '</div>' : '') +
      details(t, diskPerStream) + '</div>'
  }

  function room (r) {
    const state = r.waiting ? 'Waiting for someone who is buffering' : r.playing ? '<b>Playing</b>' : 'Paused'
    return '<div class="item"><div class="head"><div><div class="title">' + esc(r.title || 'Watch-together room') + '</div>' +
      '<div class="release">Hosted by ' + name(r.host) + '</div></div>' +
      '<div class="actions"><a class="join" href="watch/' + encodeURIComponent(r.id) + '">Join</a></div></div>' +
      '<div class="state">' + state + ' at ' + clock(r.position) + '.</div>' +
      '<div class="people">' + (r.members.length ? r.members.map(m => '<span class="chip">' + esc(m.name) + (m.buffering ? ', buffering' : '') + '</span>').join('') : '<span class="muted">Nobody is in the room.</span>') + '</div></div>'
  }

  const group = (title, note, list, diskPerStream) => list.length
    ? '<h2>' + title + (note ? '<small>' + note + '</small>' : '') + '</h2>' + list.map(t => item(t, diskPerStream)).join('') : ''

  async function refresh () {
    let data
    try {
      data = await fetch('status', { cache: 'no-store' }).then(r => r.json())
    } catch (err) {
      document.getElementById('groups').innerHTML = '<p class="empty error">Cannot reach the server: ' + esc(err.message) + '</p>'
      return
    }
    me = data.user
    const playing = data.torrents.filter(t => !t.prefetched && (t.connections > 0 || !t.ready))
    const ahead = data.torrents.filter(t => t.prefetched)
    const idle = data.torrents.filter(t => !playing.includes(t) && !ahead.includes(t))

    document.getElementById('intro').textContent = 'Everything this server is streaming right now. Everyone can play up to ' +
      data.maxTorrentsPerUser + ' torrents at once; torrents nobody watches are removed after a few minutes.'
    const conv = data.conversions
    document.getElementById('totals').innerHTML =
      total('Downloading', speed(data.downloadSpeed), 'uploading ' + speed(data.uploadSpeed)) +
      total('Torrents in use', data.usedSlots + ' of ' + data.maxActiveTorrents, ahead.length ? ahead.length + ' more loaded ahead' : 'none loaded ahead') +
      total('Disk', bytes(data.disk.used), data.disk.limit ? 'of ' + bytes(data.disk.limit) : 'no limit') +
      total('Stereo audio', conv && conv.limit ? conv.active.length + ' of ' + conv.limit : 'Off', conv && conv.limit ? 'conversions running' : 'not available on this server') +
      total('Rooms', String((data.rooms || []).length), 'watch-together rooms open')

    const rooms = data.rooms || []
    document.getElementById('rooms').innerHTML = rooms.length ? '<h2>Watch-together rooms</h2>' + rooms.map(room).join('') : ''

    for (const t of data.torrents) {
      const h = history.get(t.infoHash) || Array.from({ length: HISTORY }, () => ({ d: 0, u: 0 }))
      h.push({ d: t.downloadSpeed, u: t.uploadSpeed })
      history.set(t.infoHash, h.slice(-HISTORY))
    }
    const alive = new Set(data.torrents.map(t => t.infoHash))
    for (const k of history.keys()) if (!alive.has(k)) history.delete(k)

    const d = data.disk.perStreamLimit
    document.getElementById('groups').innerHTML = data.torrents.length
      ? group('Playing now', '', playing, d) +
        group('Loaded ahead', 'ready to start at once, not played yet', ahead, d) +
        group('Not playing', 'removed soon unless someone plays them', idle, d)
      : '<p class="empty">Nothing is playing. Start a movie or an episode in Stremio and it shows up here.</p>'
  }

  document.addEventListener('toggle', e => {
    const hash = e.target.dataset && e.target.dataset.hash
    if (!hash) return
    if (e.target.open) open.add(hash); else open.delete(hash)
  }, true)

  document.addEventListener('click', async e => {
    const mine = e.target.dataset && e.target.dataset.stop
    if (mine) {
      e.target.disabled = true
      await fetch('api/torrents/' + mine + '/stop-mine', { method: 'POST' })
      return refresh()
    }
    const hash = e.target.dataset && e.target.dataset.remove
    if (!hash) return
    if (e.target.dataset.others && !confirm('Others are watching this. Stop it for everyone?')) return
    e.target.disabled = true
    const res = await fetch('api/torrents/' + hash, { method: 'DELETE' })
    if (res.status === 409 || res.status === 403) alert(await res.text())
    refresh()
  })

  refresh()
  setInterval(refresh, 1500)
</script>
</body>
</html>`
