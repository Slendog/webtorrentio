import { esc, page, scriptJson, urlBox } from './ui.js'

// The install page (a user's personal pass), the Configure page, and the page shown when no
// access token is given. Look and shared parts: ui.js.

const hostOf = url => { try { return new URL(url).host } catch { return '' } }
const stremioLink = url => url.replace(/^https?:\/\//, 'stremio://')

const PASS_CSS = `
  .pass { position: relative; margin-top: 36px; background: var(--surface); border-radius: 20px; border: 1px solid var(--line);
    box-shadow: 0 1px 0 var(--line), 0 18px 40px -28px rgba(20, 30, 50, .45); }
  .step { display: grid; grid-template-columns: 44px 1fr; gap: 16px; padding: 26px 26px 28px; }
  .num { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; font: 800 20px var(--display);
    background: var(--accent-soft); color: var(--accent); }
  .step p { margin: 6px 0 16px; color: var(--muted); }
  .stub { background: color-mix(in srgb, var(--stub) var(--stub-mix), var(--surface)); border-radius: 0 0 20px 20px; }
  .stub .num { background: var(--stub); color: var(--stub-ink); }
  .optional { font: 600 13px var(--font); color: var(--muted); margin-left: 6px; }
  /* Tear line between the two steps: dashes with a notch cut into each side. */
  .tear { position: relative; height: 0; border-top: 2px dashed var(--line); margin: 0 22px; }
  .tear::before, .tear::after { content: ""; position: absolute; top: -13px; width: 24px; height: 24px; border-radius: 50%;
    background: var(--paper); border: 1px solid var(--line); }
  .tear::before { left: -35px; clip-path: inset(0 0 0 50%); }
  .tear::after { right: -35px; clip-path: inset(0 50% 0 0); }
  .entries { margin: 18px 0 0; }
  .entries div { display: grid; grid-template-columns: minmax(130px, 34%) 1fr; gap: 4px 18px; padding: 14px 0; border-top: 1px solid var(--line); }
  .entries dt { font: 700 15px var(--display); }
  .entries dd { margin: 0; color: var(--muted); }
  @media (max-width: 520px) {
    main { padding-top: 32px; }
    .step { grid-template-columns: 1fr; gap: 12px; padding: 22px 20px 24px; }
    .entries div { grid-template-columns: 1fr; }
    .button { width: 100%; }
  }
`

export function installPage ({ manifest, manifestUrl, togetherUrl, stereo, user }) {
  // stremio:// links open the Stremio app straight to the install prompt. Stremio always
  // fetches them over HTTPS, so they only work when the manifest URL is an HTTPS URL.
  const https = manifestUrl.startsWith('https://')
  const noHttps = https ? '' : '<p class="warn">This server has no HTTPS, so the button cannot open Stremio. Paste the link below instead.</p>'
  const paste = url => `<details${https ? '' : ' open'}><summary>Button not working? Paste this link instead</summary>
      <p class="small">In Stremio: Addons, then paste it into the search box at the top.</p>${urlBox(url)}</details>`

  const body = `
    <p class="host">${esc(hostOf(manifestUrl))}</p>
    <h1>${user ? `Hi ${esc(user)}.` : 'Watch with Stremio.'}</h1>
    <p class="lead">${user
      ? 'This is your personal pass to this server. It works only for you, so keep the link to yourself.'
      : 'Install this server\'s addon, then open any movie or episode in Stremio.'}</p>

    <section class="pass" aria-label="Install">
      <div class="step">
        <span class="num" aria-hidden="true">1</span>
        <div>
          <h3>Install the addon</h3>
          <p>Opens Stremio and asks you to confirm.</p>
          <a class="button" href="${esc(stremioLink(manifestUrl))}">Install in Stremio</a>
          ${noHttps}
          ${paste(manifestUrl)}
        </div>
      </div>
      ${togetherUrl ? `<div class="tear" aria-hidden="true"></div>
      <div class="step stub">
        <span class="num" aria-hidden="true">2</span>
        <div>
          <h3>Add watch together<span class="optional">optional</span></h3>
          <p>A second, small addon for watching with friends in the browser, all at the same moment.</p>
          <a class="button quiet" href="${esc(stremioLink(togetherUrl))}">Install Together</a>
          ${paste(togetherUrl)}
        </div>
      </div>` : ''}
    </section>

    <h2>What you will see in Stremio</h2>
    <p>Open a movie or an episode. This server's results appear in the stream list, best first:</p>
    <dl class="entries">
      <div><dt>WebTorrent 1080p</dt><dd>The video as it is. The dot shows how well it is shared: green starts quickly, red may not start at all.</dd></div>
      ${stereo ? '<div><dt>Stereo 1080p</dt><dd>The same video with the sound mixed down for TV speakers and headphones. Pick it if you hear pops or crackling.</dd></div>' : ''}
      ${togetherUrl ? '<div><dt>Together 1080p</dt><dd>From the Together addon. Opens a room in your browser; send its link to friends and everyone plays, pauses and skips together.</dd></div>' : ''}
    </dl>
    <p class="small">The first start of a video can take up to a minute while it connects.</p>

    <footer>
      <a href="configure">Settings</a>
      <a href="dashboard">What is playing on the server</a>
    </footer>`
  return page({ title: manifest.name, css: PASS_CSS, body })
}

export function lockedPage (manifest) {
  return page({
    title: manifest.name,
    body: `
      <h1>This server is private.</h1>
      <p class="lead">Open it with your personal link. The person who runs it can send you one.</p>`
  })
}

const CONFIGURE_CSS = `
  fieldset { border: 0; padding: 0; margin: 36px 0 0; }
  legend { font: 700 20px var(--display); padding: 0; }
  .chips { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .chip input, .choice input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .chip span { display: inline-block; padding: 10px 18px; border-radius: 999px; border: 2px solid var(--line); background: var(--surface);
    font-weight: 600; cursor: pointer; }
  .chip input:checked + span { border-color: var(--accent); background: var(--accent-soft); color: var(--accent); }
  .chip input:focus-visible + span, .choice input:focus-visible + span { outline: 3px solid var(--stub); outline-offset: 2px; }
  .choices { display: grid; gap: 10px; margin-top: 14px; }
  .choice span { display: block; padding: 14px 16px; border-radius: 12px; border: 2px solid var(--line); background: var(--surface); cursor: pointer; }
  .choice b { display: block; }
  .choice small { color: var(--muted); font-size: 14px; }
  .choice input:checked + span { border-color: var(--accent); background: var(--accent-soft); }
  form > details { margin-top: 30px; }
  input[type=url] { width: 100%; margin-top: 10px; padding: 12px; border-radius: 10px; border: 1px solid var(--line);
    background: var(--surface); color: var(--ink); font: 15px var(--mono); }
  .save { margin-top: 40px; padding: 22px; border-radius: 16px; background: var(--surface); border: 1px solid var(--line); }
  .save .button { margin-top: 6px; }
  .save .row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; }
`

// Stremio opens <addon base>/configure when the user clicks "Configure". The page builds a
// manifest URL with the settings encoded in it and offers to install that URL.
export function configurePage ({ manifest, addonBase, defaults, scraperKeys, modes, current, together }) {
  const value = current.url || defaults.url
  const enabled = current.scrapers || defaults.scrapers
  const mode = current.mode || defaults.mode
  const MODE_TEXT = {
    webtorrent: ['Through this server', 'Recommended. The server downloads and sends the video; works on every device.'],
    native: ['With Stremio\'s own torrent player', 'Your device downloads the torrent itself. No server load, but your device joins the torrent.'],
    both: ['Show both', 'Each result appears twice, once for each way.']
  }
  const body = `
    <p class="host">${esc(hostOf(addonBase))}</p>
    <h1>Settings</h1>
    <p class="lead">Your choices are saved in the addon link itself. After changing them, install the addon again.</p>
    <form id="form">
      <fieldset>
        <legend>Torrent sites to search</legend>
        <p class="small">Nothing is searched until you pick at least one. Only watch what you have the right to.</p>
        <div class="chips">
          ${scraperKeys.map(k => `<label class="chip"><input type="checkbox" name="scraper" value="${esc(k)}"${enabled.includes(k) ? ' checked' : ''}><span>${esc(k)}</span></label>`).join('')}
        </div>
      </fieldset>
      <fieldset>
        <legend>How videos play</legend>
        <div class="choices">
          ${modes.map(m => `<label class="choice"><input type="radio" name="mode" value="${esc(m)}"${m === mode ? ' checked' : ''}>
            <span><b>${esc(MODE_TEXT[m]?.[0] || m)}</b><small>${esc(MODE_TEXT[m]?.[1] || '')}</small></span></label>`).join('')}
        </div>
      </fieldset>
      <details>
        <summary>Server address</summary>
        <p class="small">Only change this if videos do not start on this device: the address this device uses to reach the server, for example http://192.168.1.20:7000.</p>
        <input id="url" type="url" value="${esc(value)}" required aria-label="Server address">
      </details>
    </form>
    <section class="save">
      <h3>Install with these settings</h3>
      <div class="row">
        <a class="button" id="install" href="#">Install in Stremio</a>
        ${together ? '<a class="button quiet" id="installTogether" href="#">Install Together</a>' : ''}
      </div>
      <details><summary>Button not working? Paste this link instead</summary>
        <div class="url"><code id="manifest"></code><button type="button" data-copy>Copy</button></div>
      </details>
    </section>
    <footer><a href="${esc(addonBase)}/">Back to your install page</a></footer>`
  const script = `
      const base = ${scriptJson(addonBase)}
      const defaults = ${scriptJson(defaults)}
      const form = document.getElementById('form')
      function update () {
        const cfg = {}
        const url = document.getElementById('url').value.trim().replace(/\\/+$/, '')
        if (url && url !== defaults.url) cfg.url = url
        const scrapers = [...form.querySelectorAll('[name=scraper]:checked')].map(i => i.value)
        if (scrapers.join() !== defaults.scrapers.join()) cfg.scrapers = scrapers
        const mode = (form.querySelector('[name=mode]:checked') || {}).value
        if (mode && mode !== defaults.mode) cfg.mode = mode
        const json = JSON.stringify(cfg)
        const encoded = btoa(unescape(encodeURIComponent(json))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
        const manifestUrl = base + (json === '{}' ? '' : '/c/' + encoded) + '/manifest.json'
        document.getElementById('manifest').textContent = manifestUrl
        document.getElementById('install').href = manifestUrl.replace(/^https?:\\/\\//, 'stremio://')
        const together = document.getElementById('installTogether')
        if (together) together.href = manifestUrl.replace(/\\/manifest\\.json$/, '/together/manifest.json').replace(/^https?:\\/\\//, 'stremio://')
      }
      form.addEventListener('input', update)
      form.addEventListener('change', update)
      update()`
  return page({ title: `Settings for ${manifest.name}`, css: CONFIGURE_CSS, body, script })
}
