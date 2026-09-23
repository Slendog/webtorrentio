import { config } from './config.js'

const MAX_BODY_BYTES = 5 * 1024 ** 2

export async function fetchText (url, { timeoutMs = config.scraperTimeoutMs, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': config.userAgent, Accept: '*/*', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow'
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  // Read at most MAX_BODY_BYTES: a hostile or broken mirror could send an endless body.
  const chunks = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`Response too large from ${url}`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function fetchJson (url, opts) {
  return JSON.parse(await fetchText(url, { ...opts, headers: { Accept: 'application/json', ...opts?.headers } }))
}

// Try each base URL in order until one answers. Torrent sites move domains often.
export async function fetchFromMirrors (bases, pathAndQuery, parser = fetchJson) {
  let lastErr
  for (const base of bases) {
    try {
      return await parser(base + pathAndQuery)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}
