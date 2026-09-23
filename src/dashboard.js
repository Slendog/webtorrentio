// Live stats page for the WebTorrent client. Polls /status and renders one card per torrent.
export const dashboardHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WebTorrent Dashboard</title>
<style>
  :root {
    --bg: #f4f3f8; --card: #ffffff; --text: #1d1a29; --muted: #6b6780; --line: #e3e0ec;
    --accent: #6a4ae0; --down: #1f8f5f; --up: #2f6fd6; --bar: #e9e6f3; --danger: #c43d3d;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #151221; --card: #211c33; --text: #eeeaf8; --muted: #9d97b3; --line: #332c4a;
      --accent: #8c70ff; --down: #3ecf8e; --up: #5b9bff; --bar: #2d2743; --danger: #ff6b6b;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.45 system-ui, -apple-system, sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 8px 24px; margin-bottom: 20px; }
  h1 { margin: 0; font-size: 22px; }
  .totals { display: flex; gap: 20px; font-variant-numeric: tabular-nums; }
  .totals b { font-size: 20px; }
  .down { color: var(--down); } .up { color: var(--up); }
  .muted { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 14px; }
  .top { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
  .name { font-weight: 600; word-break: break-word; }
  .badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .badge { font-size: 12px; padding: 2px 8px; border-radius: 99px; background: var(--bar); color: var(--muted); }
  .badge.live { background: var(--accent); color: #fff; }
  button { border: 1px solid var(--line); background: transparent; color: var(--danger); border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit; font-size: 13px; }
  button:hover { border-color: var(--danger); }
  .progress { height: 8px; border-radius: 99px; background: var(--bar); overflow: hidden; margin: 14px 0 4px; }
  .progress > div { height: 100%; background: var(--accent); transition: width .5s; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 12px; }
  .stat .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .stat .value { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .sub { font-size: 12px; color: var(--muted); }
  svg.spark { width: 100%; height: 40px; margin-top: 12px; display: block; }
  .watching { margin-top: 12px; font-size: 14px; }
  .watching .label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; margin-right: 6px; }
  .watching .behind { color: var(--danger); font-size: 13px; }
  .watching .lead { color: var(--down); font-size: 13px; }
  .viewer { margin-top: 12px; font-size: 13px; }
  .viewer-top { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; color: var(--muted); }
  .viewer-top b { color: var(--text); }
  .progress.thin { height: 5px; margin: 6px 0 0; }
  .playing { margin-top: 10px; font-size: 13px; color: var(--muted); word-break: break-word; }
  .empty { text-align: center; padding: 48px 16px; color: var(--muted); }
  .error { color: var(--danger); }
</style>
</head>
<body>
<main>
  <header>
    <h1>WebTorrent Dashboard</h1>
    <div class="totals">
      <span class="down">&darr; <b id="down">0 B/s</b></span>
      <span class="up">&uarr; <b id="up">0 B/s</b></span>
      <span class="muted"><b id="count">0</b> torrents</span>
      <span class="muted" id="limits"></span>
      <span class="muted">Disk <b id="disk">0 B</b></span>
    </div>
  </header>
  <div id="list"></div>
</main>
<script>
  const HISTORY = 60
  const history = new Map()

  const bytes = n => {
    if (!n) return '0 B'
    const u = ['B', 'KB', 'MB', 'GB', 'TB']
    const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
    return (n / 1024 ** i).toFixed(i > 1 ? 1 : 0) + ' ' + u[i]
  }
  const speed = n => bytes(n) + '/s'
  const duration = ms => {
    if (ms == null || !isFinite(ms)) return '–'
    const s = Math.round(ms / 1000)
    if (s < 60) return s + 's'
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
    return Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm'
  }
  // Seconds -> "1:02:03" or "2:03".
  const clock = sec => {
    sec = Math.max(0, Math.round(sec))
    const h = Math.floor(sec / 3600)
    const m = Math.floor(sec % 3600 / 60)
    const ss = String(sec % 60).padStart(2, '0')
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss
  }
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

  function spark (points) {
    const max = Math.max(1, ...points.flatMap(p => [p.d, p.u]))
    const line = key => points.map((p, i) =>
      (i * 100 / (HISTORY - 1)).toFixed(1) + ',' + (38 - p[key] / max * 36).toFixed(1)).join(' ')
    return '<svg class="spark" viewBox="0 0 100 40" preserveAspectRatio="none">' +
      '<polyline fill="none" stroke="var(--down)" stroke-width="1.5" vector-effect="non-scaling-stroke" points="' + line('d') + '"/>' +
      '<polyline fill="none" stroke="var(--up)" stroke-width="1.5" vector-effect="non-scaling-stroke" points="' + line('u') + '"/>' +
      '</svg>'
  }

  let me = null
  let diskPerStream = null

  function card (t) {
    const s = t.scraped
    const viewers = t.users.map(u => u === me ? 'you' : esc(u)).join(', ')
    const pct = (t.progress * 100).toFixed(1)
    const badges = [
      t.prefetched ? '<span class="badge">' + (t.nextEpisode ? 'next episode' : 'prefetched') + ', dropped in ' + duration(t.removesAt - Date.now()) + ' if unused</span>' : t.connections > 0 ? '<span class="badge live">&#9654; ' + t.connections + (t.connections > 1 ? ' connections' : ' connection') + '</span>' : '<span class="badge">idle, removed in ' + duration(t.removesAt - Date.now()) + '</span>',
      t.ready ? '' : '<span class="badge">fetching metadata&hellip;</span>',
      viewers ? '<span class="badge">&#128100; ' + viewers + '</span>' : '',
      s?.quality ? '<span class="badge">' + esc(s.quality) + '</span>' : '',
      s?.source ? '<span class="badge">' + esc(s.source) + '</span>' : ''
    ].join('')
    const viewerRows = t.viewers.map(v => {
      const pct = v.target ? Math.min(100, v.bufferedAhead / v.target * 100) : 100
      return '<div class="viewer">' +
        '<div class="viewer-top"><span>' + (v.user === me ? 'You' : esc(v.user)) + ' &middot; at ' + (v.position / v.length * 100).toFixed(1) + '% of the file</span>' +
        '<span><b>' + bytes(v.bufferedAhead) + '</b> of ' + bytes(v.target) + ' downloaded ahead</span></div>' +
        '<div class="progress thin"><div style="width:' + pct.toFixed(1) + '%;background:var(--down)"></div></div>' +
      '</div>'
    }).join('')
    const w = t.watchers
    const watching = w.list.length
      ? '<div class="watching"><span class="label">Watching</span> ' + w.list.map(x => {
          const who = x.user === me ? 'You' : esc(x.user)
          if (x.positionSec == null) return who + ' at ' + (x.fraction * 100).toFixed(1) + '%'
          const gap = w.list.length > 1 ? (x.behindSec > 0 ? ' <span class="behind">' + clock(x.behindSec) + ' behind</span>' : ' <span class="lead">ahead</span>') : ''
          return who + ' &asymp; <b>' + clock(x.positionSec) + '</b> / ' + clock(w.runtimeSec) + gap
        }).join(' &middot; ') + '</div>'
      : ''
    const playing = t.playing.length
      ? '<div class="playing">Playing: ' + t.playing.map(f => esc(f.name) + (f.length ? ' (' + bytes(f.length) + ', ' + (f.progress * 100).toFixed(1) + '% downloaded)' : '')).join(', ') + '</div>'
      : ''
    return '<div class="card">' +
      '<div class="top"><div><div class="name">' + esc(t.name) + '</div><div class="badges">' + badges + '</div></div>' +
      '<button data-remove="' + t.infoHash + '">Remove</button></div>' +
      '<div class="progress"><div style="width:' + pct + '%"></div></div>' +
      '<div class="muted" style="font-size:13px">' + pct + '% of ' + bytes(t.length) + (t.timeRemaining != null && t.progress < 1 && t.downloadSpeed > 1024 ? ' &middot; full download in ' + duration(t.timeRemaining) : '') + '</div>' +
      '<div class="grid">' +
        '<div class="stat"><div class="label">Download</div><div class="value down">&darr; ' + speed(t.downloadSpeed) + '</div><div class="sub">' + bytes(t.onDisk) + (diskPerStream ? ' / ' + bytes(diskPerStream) : '') + ' on disk &middot; ' + bytes(t.readahead) + ' ahead</div></div>' +
        '<div class="stat"><div class="label">Upload</div><div class="value up">&uarr; ' + speed(t.uploadSpeed) + '</div><div class="sub">' + bytes(t.uploaded) + ' total &middot; ratio ' + t.ratio.toFixed(2) + '</div></div>' +
        '<div class="stat"><div class="label">Connected peers</div><div class="value">' + t.peers.connected + '</div><div class="sub">' + t.peers.seeders + ' seeders &middot; ' + t.peers.leechers + ' leechers</div></div>' +
        '<div class="stat"><div class="label">Swarm (at scrape)</div><div class="value">' + (s ? (s.seeders ?? '?') + ' / ' + (s.leechers ?? '?') : '–') + '</div><div class="sub">seeders / leechers' + (s ? ' &middot; ' + duration(Date.now() - s.scrapedAt) + ' ago' : '') + '</div></div>' +
      '</div>' +
      spark(history.get(t.infoHash) || []) +
      watching +
      viewerRows +
      playing +
    '</div>'
  }

  async function refresh () {
    try {
      const res = await fetch('status', { cache: 'no-store' })
      const data = await res.json()
      me = data.user
      diskPerStream = data.disk.perStreamLimit
      document.getElementById('down').textContent = speed(data.downloadSpeed)
      document.getElementById('up').textContent = speed(data.uploadSpeed)
      document.getElementById('count').textContent = data.usedSlots + ' / ' + data.maxActiveTorrents + (data.torrents.length > data.usedSlots ? ' (+' + (data.torrents.length - data.usedSlots) + ' prefetched)' : '')
      document.getElementById('disk').textContent = bytes(data.disk.used) + (data.disk.limit ? ' / ' + bytes(data.disk.limit) : '')
      document.getElementById('limits').textContent = 'Limit: ' + data.maxTorrentsPerUser + ' torrents per user'

      const alive = new Set()
      for (const t of data.torrents) {
        alive.add(t.infoHash)
        const h = history.get(t.infoHash) || Array.from({ length: HISTORY }, () => ({ d: 0, u: 0 }))
        h.push({ d: t.downloadSpeed, u: t.uploadSpeed })
        history.set(t.infoHash, h.slice(-HISTORY))
      }
      for (const k of history.keys()) if (!alive.has(k)) history.delete(k)

      data.torrents.sort((a, b) => b.connections - a.connections || b.lastUsed - a.lastUsed)
      document.getElementById('list').innerHTML = data.torrents.length
        ? data.torrents.map(card).join('')
        : '<div class="card empty">No active torrents. Start a stream in Stremio and it shows up here.</div>'
    } catch (err) {
      document.getElementById('list').innerHTML = '<div class="card empty error">Cannot reach the addon server: ' + esc(err.message) + '</div>'
    }
  }

  document.addEventListener('click', async e => {
    const hash = e.target.dataset?.remove
    if (!hash) return
    e.target.disabled = true
    const res = await fetch('api/torrents/' + hash, { method: 'DELETE' })
    if (res.status === 409) alert(await res.text())
    refresh()
  })

  refresh()
  setInterval(refresh, 1500)
</script>
</body>
</html>`
