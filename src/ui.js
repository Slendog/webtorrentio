// Shared look of the server's web pages (install, Configure, locked, invite, room, dashboard).
//
// The pages are opened by friends of the person running the server, from a personal link,
// often on a phone. So: one column, plain words, big targets, and one memorable element, the
// "pass" on the install page. System fonts only: the Content-Security-Policy allows no
// outside resources. Rounded headings where the system has them (Apple), sans-serif elsewhere.

export const TOKENS = `
  :root {
    color-scheme: light dark;
    --paper: #f2f4f8; --surface: #ffffff; --ink: #18202f; --muted: #586274; --line: #d9dee8;
    --accent: #1f7a6d; --accent-ink: #ffffff; --accent-soft: #dcefeb;
    --stub: #f2b544; --stub-ink: #3a2a05; --danger: #b23b3b; --warn: #9a6a00;
    --stub-mix: 14%;
    --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --display: ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #121826; --surface: #1b2335; --ink: #e8ecf4; --muted: #9aa4b8; --line: #2c374d;
      --accent: #4cc3b0; --accent-ink: #062521; --accent-soft: #173b39;
      --stub: #f2b544; --stub-ink: #2a1e03; --danger: #ff7b7b; --warn: #f0b429; --stub-mix: 7%;
    }
  }
`

export const BASE_CSS = `${TOKENS}
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.55 var(--font); }
  main { max-width: 640px; margin: 0 auto; padding: 48px 20px 64px; }
  h1, h2, h3 { font-family: var(--display); line-height: 1.15; margin: 0; }
  h1 { font-size: clamp(34px, 7vw, 46px); font-weight: 800; letter-spacing: -0.02em; }
  h2 { font-size: 22px; font-weight: 700; margin-top: 44px; }
  h3 { font-size: 17px; font-weight: 700; }
  p { margin: 10px 0; max-width: 62ch; }
  a { color: var(--accent); text-underline-offset: 3px; }
  .lead { font-size: 18px; color: var(--muted); margin-top: 12px; }
  .small { font-size: 14px; color: var(--muted); }
  .host { font: 600 14px var(--font); color: var(--muted); margin: 0 0 14px; }
  .warn { font-size: 14px; color: var(--warn); margin: 12px 0 0; }
  details { margin-top: 14px; font-size: 14px; color: var(--muted); }
  summary { cursor: pointer; width: fit-content; }
  .button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 12px 22px;
    border-radius: 999px; border: 0; background: var(--accent); color: var(--accent-ink); font: 700 16px/1.2 var(--font);
    text-decoration: none; cursor: pointer; }
  .button:hover { filter: brightness(1.07); }
  .button.quiet { background: transparent; color: var(--accent); box-shadow: inset 0 0 0 2px var(--accent); }
  :focus-visible { outline: 3px solid var(--stub); outline-offset: 3px; }
  .url { display: flex; gap: 8px; align-items: stretch; margin-top: 8px; }
  .url code { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 10px; background: var(--paper); border: 1px solid var(--line);
    font: 13px/1.4 var(--mono); overflow-wrap: anywhere; }
  .url button { flex: none; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink);
    font: 600 14px var(--font); padding: 0 14px; cursor: pointer; }
  .url button.done { color: var(--accent); border-color: var(--accent); }
  footer { margin-top: 56px; padding-top: 18px; border-top: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 8px 22px; font-size: 14px; }
  footer a { color: var(--muted); }
  @media (prefers-reduced-motion: no-preference) { .button, .url button { transition: filter .15s, color .15s, border-color .15s; } }
`

// Copy buttons next to URLs: <div class="url"><code>…</code><button data-copy>Copy</button></div>.
// The clipboard API needs HTTPS; without it the text is selected so Ctrl+C / long-press works.
export const COPY_SCRIPT = `
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      const code = b.parentElement.querySelector('code')
      try {
        await navigator.clipboard.writeText(code.textContent)
        b.textContent = 'Copied'; b.classList.add('done')
        setTimeout(() => { b.textContent = 'Copy'; b.classList.remove('done') }, 2000)
      } catch {
        const r = document.createRange(); r.selectNodeContents(code)
        const s = getSelection(); s.removeAllRanges(); s.addRange(r)
        b.textContent = 'Press Ctrl+C'
      }
    })
  }
`

export const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// JSON inside <script>: escape "<" so no value can close the script tag.
export const scriptJson = v => JSON.stringify(v).replace(/</g, '\\u003c')

export const urlBox = (url, id) => `<div class="url"><code${id ? ` id="${id}"` : ''}>${esc(url)}</code><button type="button" data-copy>Copy</button></div>`

export function page ({ title, css = '', body, script = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${BASE_CSS}${css}</style>
</head>
<body>
<main>${body}</main>
<script>${COPY_SCRIPT}${script}</script>
</body>
</html>`
}
