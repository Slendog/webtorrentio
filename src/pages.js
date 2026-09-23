// Small HTML pages: the install page and the page shown when no access token is given.
const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1b1530; color: #eee; font-family: system-ui, sans-serif; }
    main { max-width: 480px; padding: 32px 16px; text-align: center; }
    a.button { display: inline-block; margin: 24px 0 16px; padding: 14px 28px; border-radius: 8px; background: #7b5bf5; color: #fff; font-weight: 600; text-decoration: none; }
    a.button:hover { background: #6a4ae0; }
    a { color: #b7a6ff; }
    code { display: block; padding: 8px; border-radius: 6px; background: #2a2245; word-break: break-all; }
    p.small { color: #aaa; font-size: 14px; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`

// JSON inside <script>: escape "<" so no value can close the script tag.
const scriptJson = v => JSON.stringify(v).replace(/</g, '\\u003c')

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export function installPage ({ manifest, manifestUrl, user }) {
  // stremio:// links open the Stremio app straight to the install prompt. Stremio always
  // fetches them over HTTPS, so they only work when the manifest URL is an HTTPS URL.
  const stremioUrl = manifestUrl.replace(/^https?:\/\//, 'stremio://')
  const https = manifestUrl.startsWith('https://')
  return page(manifest.name, `
    <h1>${esc(manifest.name)}</h1>
    <p>${esc(manifest.description)}</p>
    ${user ? `<p class="small">Personal link for <b>${esc(user)}</b>. Do not share it.</p>` : ''}
    <a class="button" href="${esc(stremioUrl)}">Install in Stremio</a>
    ${https ? '' : '<p class="small">This server has no HTTPS, so the button fails with a TLS error. Use the URL below instead.</p>'}
    <p class="small">Button does nothing? Paste this URL into the Stremio addon search bar:</p>
    <code>${esc(manifestUrl)}</code>
    <p class="small"><a href="configure">Settings</a> &middot; <a href="dashboard">Live dashboard</a></p>`)
}

export function lockedPage (manifest) {
  return page(manifest.name, `
    <h1>${esc(manifest.name)}</h1>
    <p>This addon needs a personal link. Ask the server owner for yours.</p>`)
}

// Stremio opens <addon base>/configure when the user clicks "Configure". The page builds a
// manifest URL with the settings encoded in it and offers to install that URL.
export function configurePage ({ manifest, addonBase, defaults, scraperKeys, modes, current }) {
  const value = current.url || defaults.url
  const enabled = current.scrapers || defaults.scrapers
  const mode = current.mode || defaults.mode
  return page(`Configure ${manifest.name}`, `
    <h1>Configure</h1>
    <form id="form" style="text-align:left">
      <label class="small" for="url">Server URL for stream links</label>
      <input id="url" type="url" value="${esc(value)}" required style="width:100%;margin:6px 0 4px;padding:10px;border-radius:6px;border:1px solid #3a3160;background:#2a2245;color:#eee;font:inherit">
      <p class="small" style="margin-top:0">Address this device uses to reach the server, for example http://192.168.1.20:7000. Default: ${esc(defaults.url)}</p>

      <p class="small">Torrent indexes to search. None are searched until you tick them. Only stream content you have the right to access.</p>
      ${scraperKeys.map(k => `<label style="display:inline-block;margin:0 14px 8px 0"><input type="checkbox" name="scraper" value="${esc(k)}"${enabled.includes(k) ? ' checked' : ''}> ${esc(k)}</label>`).join('')}

      <p class="small">Stream mode</p>
      <select id="mode" style="padding:8px;border-radius:6px;background:#2a2245;color:#eee;border:1px solid #3a3160;font:inherit">
        ${modes.map(m => `<option value="${m}"${m === mode ? ' selected' : ''}>${m}</option>`).join('')}
      </select>
      <p class="small">webtorrent: stream through this server. native: Stremio's own torrent engine. both: show both.</p>
    </form>
    <a class="button" id="install" href="#">Install in Stremio</a>
    <p class="small">Or paste this URL into the Stremio addon search bar:</p>
    <code id="manifest"></code>
    <script>
      const base = ${scriptJson(addonBase)}
      const defaults = ${scriptJson(defaults)}
      const form = document.getElementById('form')
      function update () {
        const cfg = {}
        const url = document.getElementById('url').value.trim().replace(/\\/+$/, '')
        if (url && url !== defaults.url) cfg.url = url
        const scrapers = [...form.querySelectorAll('[name=scraper]:checked')].map(i => i.value)
        if (scrapers.join() !== defaults.scrapers.join()) cfg.scrapers = scrapers
        const mode = document.getElementById('mode').value
        if (mode !== defaults.mode) cfg.mode = mode
        const json = JSON.stringify(cfg)
        const encoded = btoa(unescape(encodeURIComponent(json))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
        const manifestUrl = base + (json === '{}' ? '' : '/c/' + encoded) + '/manifest.json'
        document.getElementById('manifest').textContent = manifestUrl
        document.getElementById('install').href = manifestUrl.replace(/^https?:\\/\\//, 'stremio://')
      }
      form.addEventListener('input', update)
      update()
    </script>`)
}
