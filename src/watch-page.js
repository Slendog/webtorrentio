// Browser pages for watch together (see rooms.js): the room page with the player, and the
// page an invite link opens when the browser does not know the member's token yet.

import { esc, scriptJson, TOKENS } from './ui.js'

// The room page loads hls.js from this server and plays through MediaSource (blob: URLs,
// a blob: worker), so it needs a wider policy than the other pages.
export const WATCH_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data:; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

// Same colours and type as the other pages (ui.js), under the names this page uses.
const STYLE = `${TOKENS}
  :root { --bg: var(--paper); --card: var(--surface); --text: var(--ink); --ok: var(--accent); }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 var(--font); }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 40px; }
  h1 { font: 800 22px/1.2 var(--display); letter-spacing: -0.01em; margin: 0 0 14px; word-break: break-word; }
  .muted { color: var(--muted); }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 14px 16px; margin-top: 14px; }
  button, select, input[type=text] { font: inherit; color: var(--text); background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 7px 12px; }
  button { cursor: pointer; }
  button.primary { background: var(--accent); border: 0; color: var(--accent-ink); font-weight: 700; padding: 13px 26px; border-radius: 999px; }
  :focus-visible { outline: 3px solid var(--stub); outline-offset: 2px; }
  .error { color: var(--danger); }
`

export function watchPage ({ roomId, user, isHost, shareUrl, title, auth }) {
  const data = { roomId, user, isHost, shareUrl, auth }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch together · ${esc(title)}</title>
<style>${STYLE}
  .stage { position: relative; background: #000; border-radius: 12px; overflow: hidden; aspect-ratio: 16 / 9; }
  video { width: 100%; height: 100%; display: block; background: #000; }
  .overlay { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 16px; background: rgba(10, 8, 20, .82); color: #eee; }
  .overlay[hidden] { display: none; }
  .bar { display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: center; margin-top: 10px; }
  .status { flex: 1 1 260px; }
  .members { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .member { padding: 4px 10px; border-radius: 99px; border: 1px solid var(--line); font-size: 14px; }
  .member.buffering { border-color: var(--warn); color: var(--warn); }
  .member .drift { color: var(--muted); font-size: 12px; margin-left: 4px; }
  .share { display: flex; gap: 8px; margin-top: 6px; }
  .share input { flex: 1; min-width: 0; }
  label { user-select: none; }
</style>
</head>
<body>
<main>
  <h1 id="title">${esc(title)}</h1>
  <div class="stage">
    <video id="video" controls playsinline preload="auto"></video>
    <div class="overlay" id="overlay"><div id="overlayText"><p>Loading the torrent…</p></div></div>
  </div>
  <div class="bar">
    <div class="status" id="status" class="muted"></div>
    <label>Speed <select id="rate">
      <option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option>
    </select></label>
    <label>Subtitles <select id="subs"><option value="">Off</option></select></label>
  </div>
  <div class="card">
    <b>People</b> <span class="muted" id="count"></span>
    <div class="members" id="members"></div>
  </div>
  <div class="card">
    <b>Invite</b> <span class="muted">Send this link to the people you want to watch with. Each of them joins with their own install link.</span>
    <div class="share"><input type="text" id="share" readonly><button id="copy">Copy</button></div>
  </div>
  <div class="card" id="hostCard" hidden>
    <b>Room settings</b> <span class="muted">(host)</span>
    <div class="bar">
      <label><input type="checkbox" id="waitForAll"> Wait for everyone when someone buffers</label>
      <label><input type="checkbox" id="hostOnly"> Only I control playback</label>
      <button id="close">Close room</button>
    </div>
  </div>
</main>
<script src="/assets/hls.min.js"></script>
<script>
(() => {
  const D = ${scriptJson(data)}
  const base = location.pathname.replace(/\\/+$/, '')
  const $ = id => document.getElementById(id)
  const video = $('video')
  const overlay = $('overlay')
  const overlayText = $('overlayText')
  $('share').value = D.shareUrl
  $('copy').onclick = () => { $('share').select(); navigator.clipboard?.writeText(D.shareUrl) }
  // Invite links carry no token: remember this member's token for the next rooms.
  if (D.auth) try { localStorage.setItem('webtorrentio-token', base.split('/')[1]) } catch {}

  let clientId
  try { clientId = sessionStorage.getItem('wt-client') } catch {}
  if (!clientId) {
    clientId = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('')
    try { sessionStorage.setItem('wt-client', clientId) } catch {}
  }
  let name = D.user
  try { name = localStorage.getItem('wt-name') || D.user } catch {}

  const post = (path, body) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, ...body })
  }).then(async r => { if (!r.ok) showMessage(await r.text(), true) }).catch(() => {})

  function showOverlay (html) { overlayText.innerHTML = html; overlay.hidden = false }
  function showMessage (text, isError) { const s = $('status'); s.textContent = text; s.className = 'status ' + (isError ? 'error' : 'muted') }

  // ---- Clock: the server's time, from the fastest of five round trips.
  let offset = 0
  async function syncClock () {
    let best = null
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now()
      const { t } = await fetch(base.replace(/\\/[^/]+$/, '') + '/time', { cache: 'no-store' }).then(r => r.json())
      const t1 = Date.now()
      if (!best || t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: t - (t0 + t1) / 2 }
    }
    offset = best.offset
  }
  const serverNow = () => Date.now() + offset
  const expected = s => s.playing ? s.position + (serverNow() - s.updatedAt) / 1000 * s.rate : s.position

  // ---- Media: stereo HLS of the room's torrent through hls.js (or native HLS).
  let info = null
  const CODECS = { avc1: 'avc1.640028', avc3: 'avc1.640028', 'V_MPEG4/ISO/AVC': 'avc1.640028', hvc1: 'hvc1.1.6.L120.90', hev1: 'hvc1.1.6.L120.90', 'V_MPEGH/ISO/HEVC': 'hvc1.1.6.L120.90' }
  const codecName = c => /hvc|hev|HEVC/.test(c) ? 'HEVC (x265)' : 'H.264'
  function playable () {
    const codec = CODECS[info.videoCodec]
    const MS = window.ManagedMediaSource || window.MediaSource
    if (!codec) return false
    if (MS && MS.isTypeSupported) return MS.isTypeSupported('video/mp4; codecs="' + codec + ',mp4a.40.2"')
    return video.canPlayType('video/mp4; codecs="' + codec + '"') !== ''
  }

  async function loadInfo () {
    for (;;) {
      const r = await fetch(base + '/info', { cache: 'no-store' })
      if (r.status === 202) { await new Promise(res => setTimeout(res, 1500)); continue }
      if (!r.ok) throw new Error(await r.text())
      return r.json()
    }
  }

  let hls = null
  function startMedia () {
    const src = base + '/hls/index.m3u8'
    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({ maxBufferLength: 30, backBufferLength: 30 })
      hls.on(Hls.Events.ERROR, (e, d) => {
        if (!d.fatal) return
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) return hls.startLoad()
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !/Codec|codec/.test(d.details)) return hls.recoverMediaError()
        mediaFailed(d.details)
      })
      hls.loadSource(src)
      hls.attachMedia(video)
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src
    } else {
      mediaFailed('no HLS support')
    }
    video.addEventListener('error', () => mediaFailed(video.error && video.error.message))
  }
  function mediaFailed (why) {
    showOverlay('<p><b>This browser cannot play this video.</b></p><p class="muted">' +
      (info ? 'It uses ' + codecName(info.videoCodec) + ' video. ' : '') +
      'Safari and Edge play HEVC; Chrome only on some computers, Firefox rarely. Try another browser, or pick an H.264 (x264) release.</p>' +
      '<p class="muted">(' + String(why || 'media error').replace(/[<>&]/g, '') + ')</p>')
  }

  // ---- Room state and sync
  let room = null
  // Changes this page makes itself, so their events are not taken for the member's own
  // actions: per kind (play, pause, seek), events within 1.5 s of such a change are ignored.
  // Browsers fire these events differently (a pause() during a pending play() can fire more
  // than one), so the window is not used up by the first event.
  const expecting = { play: 0, pause: 0, seek: 0 }
  const expect = kind => { expecting[kind] = Date.now() + 1500 }
  const consume = kind => expecting[kind] > Date.now()
  const seekTo = t => { expect('seek'); video.currentTime = t }

  function apply () {
    if (!room || !joined) return
    const s = room.state
    const target = expected(s)
    if (s.playing && video.paused) { expect('play'); video.play().catch(() => {}) }
    if (!s.playing && !video.paused) { expect('pause'); video.pause() }
    if (Math.abs(video.currentTime - target) > (s.playing ? 2 : 0.3)) seekTo(target)
    if (!s.playing) setRate(s.rate)
  }
  function setRate (r) { if (video.playbackRate !== r) video.playbackRate = r }

  // Drift correction: small drift by playing slightly faster or slower (from 0.15 s until
  // back within 0.05 s), large drift by seeking.
  let correcting = false
  setInterval(() => {
    if (!room || !joined || video.seeking) return
    const s = room.state
    if (!s.playing || video.paused) return
    const d = video.currentTime - expected(s)
    if (Math.abs(d) > 2) return seekTo(expected(s))
    if (Math.abs(d) > 0.15) correcting = true
    else if (Math.abs(d) < 0.05) correcting = false
    const step = Math.abs(d) > 1 ? 0.1 : 0.05
    setRate(correcting ? s.rate * (d > 0 ? 1 - step : 1 + step) : s.rate)
  }, 500)

  // What this member does with the player's own controls becomes a room action.
  video.addEventListener('play', () => { if (!consume('play') && room && !room.state.playing) post('/action', { type: 'play' }) })
  video.addEventListener('pause', () => { if (!consume('pause') && !video.ended && room && room.state.playing && !buffering) post('/action', { type: 'pause', position: video.currentTime }) })
  // A seek counts when it starts: loading the target can take seconds, and a state update in
  // between must not pull the video back.
  video.addEventListener('seeking', () => {
    if (consume('seek') || !room || Math.abs(video.currentTime - expected(room.state)) <= 1) return
    room.state = { ...room.state, position: video.currentTime, updatedAt: serverNow() }
    post('/action', { type: 'seek', position: video.currentTime })
  })
  $('rate').onchange = () => post('/action', { type: 'rate', rate: Number($('rate').value) })

  // Buffering reports: a stall longer than 0.7 s counts; the room waits for this member.
  let buffering = false
  let stallTimer = null
  const reportNow = () => post('/report', { buffering, position: video.currentTime })
  video.addEventListener('waiting', () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => { if (video.readyState < 3 && !buffering) { buffering = true; reportNow() } }, 700)
  })
  const ready = () => { clearTimeout(stallTimer); if (buffering && video.readyState >= 3) { buffering = false; reportNow() } }
  for (const ev of ['playing', 'canplay', 'canplaythrough', 'seeked']) video.addEventListener(ev, ready)
  // Not every browser fires "waiting" for every stall (Safari after a seek often does not):
  // also count it as a stall when the room plays but this video has not advanced for 1 s.
  let lastTime = -1
  let stuckSince = 0
  setInterval(() => {
    if (!joined || !room) return
    const moving = video.currentTime !== lastTime
    lastTime = video.currentTime
    const shouldPlay = room.state.playing || room.waitingFor.length
    if (moving || !shouldPlay || video.ended) { stuckSince = 0; return }
    if (video.readyState >= 3 && !video.seeking) { stuckSince = 0; return }
    stuckSince = stuckSince || Date.now()
    if (!buffering && Date.now() - stuckSince > 1000) { buffering = true; reportNow() }
  }, 250)
  setInterval(() => { if (joined) { if (buffering) ready(); reportNow() } }, 5000)

  // ---- Rendering
  const clock = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0') }
  const ACTIONS = { play: 'pressed play', pause: 'paused', seek: 'jumped to', rate: 'changed the speed', settings: 'changed the room settings', wait: 'is buffering, everyone waits', resume: 'resumed' }
  function render () {
    const s = room.state
    let text = (s.playing ? '▶ Playing' : '⏸ Paused') + ' at ' + clock(expected(s)) + (s.rate !== 1 ? ' (' + s.rate + '×)' : '')
    if (room.waitingFor.length) text = '⏳ Waiting for ' + room.waitingFor.join(', ')
    const a = room.lastAction
    if (a) text += ' · ' + (a.type === 'resume' ? 'everyone ready, resumed' : a.by + ' ' + ACTIONS[a.type] + (a.type === 'seek' ? ' ' + clock(a.position) : ''))
    showMessage(text, false)
    $('rate').value = String(s.rate)
    const list = $('members')
    list.textContent = ''
    for (const m of room.members) {
      const el = document.createElement('span')
      el.className = 'member' + (m.buffering ? ' buffering' : '')
      el.textContent = (m.clientId === clientId ? 'You' : m.name) + (m.host ? ' ★' : '') + (m.buffering ? ' ⏳' : '')
      if (m.drift != null && !m.stale && Math.abs(m.drift) >= 0.5) {
        const d = document.createElement('span'); d.className = 'drift'; d.textContent = (m.drift > 0 ? '+' : '') + m.drift + ' s'; el.append(d)
      }
      list.append(el)
    }
    $('count').textContent = room.members.length + (room.members.length === 1 ? ' person' : ' people')
    $('hostCard').hidden = !D.isHost
    $('waitForAll').checked = room.settings.waitForAll
    $('hostOnly').checked = room.settings.hostOnly
  }
  $('waitForAll').onchange = () => post('/action', { type: 'settings', settings: { waitForAll: $('waitForAll').checked } })
  $('hostOnly').onchange = () => post('/action', { type: 'settings', settings: { hostOnly: $('hostOnly').checked } })
  $('close').onclick = () => { if (confirm('Close the room for everyone?')) post('/close', {}) }

  // ---- Subtitles: fetched on demand, one <track> at a time.
  function setupSubtitles () {
    const sel = $('subs')
    // Numbered per language ("eng 1", "eng 2"), the browser's language first.
    const mine = (navigator.language || 'en').slice(0, 2).toLowerCase()
    const first = l => l.slice(0, 2).toLowerCase() === mine ? 0 : 1
    const counts = {}
    const list = info.subtitles.slice().sort((a, b) => first(a.lang) - first(b.lang) || a.lang.localeCompare(b.lang))
    for (const s of list) {
      counts[s.lang] = (counts[s.lang] || 0) + 1
      const o = document.createElement('option'); o.value = String(s.id); o.textContent = s.lang + ' ' + counts[s.lang]; sel.append(o)
    }
    sel.onchange = () => {
      for (const t of [...video.querySelectorAll('track')]) t.remove()
      if (!sel.value) return
      const t = document.createElement('track')
      t.kind = 'subtitles'; t.srclang = 'und'; t.label = sel.selectedOptions[0].textContent; t.default = true
      t.src = base + '/sub/' + sel.value + '.vtt'
      video.append(t)
      // Safari loads a track only once it is showing.
      t.track.mode = 'showing'
      t.addEventListener('load', () => { t.track.mode = 'showing' })
    }
  }

  // ---- Start: load info, then a click (browsers only allow sound after one), then join.
  let joined = false
  async function start () {
    try {
      info = await loadInfo()
    } catch (err) {
      return showOverlay('<p class="error">' + String(err.message).replace(/[<>&]/g, '') + '</p>')
    }
    if (info.name) $('title').textContent = info.name
    setupSubtitles()
    const warn = playable() ? '' : '<p class="error">This browser probably cannot play ' + codecName(info.videoCodec) + ' video. Safari or Edge usually can.</p>'
    showOverlay(warn + '<p><label>Your name <input type="text" id="nameInput" maxlength="24"></label></p><p><button class="primary" id="joinBtn">Join and play</button></p>')
    $('nameInput').value = name
    $('joinBtn').onclick = async () => {
      name = $('nameInput').value.trim() || D.user
      try { localStorage.setItem('wt-name', name) } catch {}
      overlay.hidden = true
      await syncClock().catch(() => {})
      startMedia()
      joined = true
      const es = new EventSource(base + '/events?cid=' + clientId + '&name=' + encodeURIComponent(name))
      es.addEventListener('state', e => { room = JSON.parse(e.data); render(); apply() })
      es.addEventListener('closed', () => { es.close(); joined = false; video.pause(); showOverlay('<p>The room was closed.</p>') })
      setInterval(() => syncClock().catch(() => {}), 60_000)
    }
  }
  start()
})()
</script>
</body>
</html>`
}

// Invite link opened without a token: ask for the member's own install link once.
export function joinPage (roomId) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watch together</title>
<style>${STYLE} main { max-width: 560px; padding-top: 56px; } h1 { font-size: clamp(28px, 6vw, 38px); } input { width: 100%; margin: 12px 0; padding: 12px; }</style>
</head>
<body>
<main>
  <h1>You are invited to watch together.</h1>
  <p>To join, paste your own install link: the one you got for Stremio, or the address of your install page. This browser remembers it for next time.</p>
  <input type="text" id="link" placeholder="https://…/your-personal-code/" autocomplete="off" aria-label="Your install link">
  <p><button class="primary" id="go">Join the room</button></p>
  <p class="muted">No link yet? Ask the person who runs the server for one.</p>
  <p class="error" id="err"></p>
</main>
<script>
(() => {
  const roomId = ${scriptJson(roomId)}
  const err = t => { document.getElementById('err').textContent = t }
  // Check the token first, so a wrong or removed one shows an error here instead of a 404.
  async function go (token, fromStorage) {
    const r = await fetch('/' + encodeURIComponent(token) + '/watch/time', { cache: 'no-store' }).catch(() => null)
    if (!r || !r.ok) {
      try { localStorage.removeItem('webtorrentio-token') } catch {}
      return err(fromStorage ? '' : 'This link is not valid on this server.')
    }
    try { localStorage.setItem('webtorrentio-token', token) } catch {}
    location.href = '/' + encodeURIComponent(token) + '/watch/' + encodeURIComponent(roomId)
  }
  let saved = null
  try { saved = localStorage.getItem('webtorrentio-token') } catch {}
  if (saved) go(saved, true)
  document.getElementById('go').onclick = () => {
    const v = document.getElementById('link').value.trim()
    // The token is the first path segment of the install link (https:// or stremio://).
    const m = v.match(/^(?:https?|stremio):\\/\\/[^/]+\\/([^/?#]+)/) || v.match(/^([\\w-]{16,})$/)
    if (!m) return err('That does not look like an install link.')
    go(m[1], false)
  }
})()
</script>
</body>
</html>`
}
