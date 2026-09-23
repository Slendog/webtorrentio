import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const env = process.env

// HTTPS is enabled when a cert/key pair exists. `npm run certs` creates one in ./certs with mkcert.
const certFile = env.TLS_CERT || path.resolve('certs/cert.pem')
const keyFile = env.TLS_KEY || path.resolve('certs/key.pem')
const tls = fs.existsSync(certFile) && fs.existsSync(keyFile) ? { cert: certFile, key: keyFile } : null

// ACCESS_TOKENS="alice:token1,bob:token2". A bare token gets the name "user1", "user2", ...
// With no tokens, the addon is open to anyone who can reach it.
const accessTokens = (env.ACCESS_TOKENS || '').split(',').map(s => s.trim()).filter(Boolean)
  .map((entry, i) => {
    const sep = entry.indexOf(':')
    return sep > 0 ? { user: entry.slice(0, sep), token: entry.slice(sep + 1) } : { user: `user${i + 1}`, token: entry }
  })

const weak = accessTokens.filter(t => t.token.length < 16 || /change-me/i.test(t.token))
if (weak.length) {
  console.error(`ACCESS_TOKENS: tokens for ${weak.map(t => t.user).join(', ')} are too weak. Use 16+ random characters (npm run token).`)
  process.exit(1)
}

const port = Number(env.PORT) || 7000
const httpsPort = Number(env.HTTPS_PORT) || 7443

const MIN_STREAM_MB = 128
if (env.MAX_DISK_PER_STREAM_MB && Number(env.MAX_DISK_PER_STREAM_MB) < MIN_STREAM_MB) {
  console.error(`MAX_DISK_PER_STREAM_MB must be at least ${MIN_STREAM_MB}.`)
  process.exit(1)
}

export const config = {
  port,
  httpsPort,
  tls,
  accessTokens,
  // URL Stremio uses to reach this server. Must be reachable from the Stremio client.
  // stremio:// install links always open over HTTPS, so prefer HTTPS when it is available.
  publicUrl: (env.PUBLIC_URL || (tls ? `https://127.0.0.1:${httpsPort}` : `http://127.0.0.1:${port}`)).replace(/\/$/, ''),
  // Base URL of /play links. Defaults to plain HTTP on localhost: Stremio's video player
  // does not necessarily trust a locally generated certificate the way the app does.
  streamUrl: (env.STREAM_URL || (env.PUBLIC_URL ? env.PUBLIC_URL : `http://127.0.0.1:${port}`)).replace(/\/$/, ''),
  // "webtorrent": streams are served over HTTP by this server's WebTorrent client.
  // "native": Stremio receives the infoHash and uses its own torrent engine.
  // "both": return both variants for every torrent.
  mode: env.STREAM_MODE || 'webtorrent',
  scrapers: (env.SCRAPERS || 'yts,tpb,eztv,nyaa,1337x').split(',').map(s => s.trim()).filter(Boolean),
  downloadPath: env.DOWNLOAD_PATH || path.join(os.tmpdir(), 'stremio-webtorrent'),
  // Torrents with no active HTTP stream are destroyed (and their data deleted) after this delay.
  idleTimeoutMs: Number(env.TORRENT_IDLE_MS) || 2 * 60 * 1000,
  maxConns: Number(env.MAX_CONNS) || 55,
  // Hard limits. New torrents are refused (HTTP 503) instead of exceeding them.
  maxActiveTorrents: Number(env.MAX_ACTIVE_TORRENTS) || 5,
  maxTorrentsPerUser: Number(env.MAX_TORRENTS_PER_USER) || 2,
  // Disk budget for torrent data, in bytes. 0 means unlimited.
  maxDiskBytes: (Number(env.MAX_DISK_GB) || 0) * 1024 ** 3,
  // Disk budget for one torrent's data, shared by everyone watching it. 0 means unlimited.
  maxDiskPerStreamBytes: (Number(env.MAX_DISK_PER_STREAM_MB) || 0) * 1024 ** 2,
  // How far ahead of the playback position a stream downloads.
  readaheadBytes: (Number(env.READAHEAD_MB) || 256) * 1024 ** 2,
  // When a stream list loads, fetch metadata for this many top results in the background and
  // download the first and last megabytes of the file that would play, so clicking one starts
  // fast. 0 turns it off. Prefetched torrents are dropped after PREFETCH_TTL_MS if unused.
  prefetchCount: env.PREFETCH_COUNT !== undefined ? Number(env.PREFETCH_COUNT) : 2,
  prefetchMax: Number(env.PREFETCH_MAX) || 6,
  prefetchTtlMs: Number(env.PREFETCH_TTL_MS) || 2 * 60 * 1000,
  prefetchHeadBytes: (env.PREFETCH_HEAD_MB !== undefined ? Number(env.PREFETCH_HEAD_MB) : 8) * 1024 ** 2,
  prefetchTailBytes: (env.PREFETCH_TAIL_MB !== undefined ? Number(env.PREFETCH_TAIL_MB) : 4) * 1024 ** 2,
  // Port for incoming BitTorrent connections. 0 picks a random port.
  torrentPort: Number(env.TORRENT_PORT) || 0,
  scraperTimeoutMs: Number(env.SCRAPER_TIMEOUT_MS) || 10000,
  cacheTtlMs: Number(env.CACHE_TTL_MS) || 30 * 60 * 1000,
  maxResults: Number(env.MAX_RESULTS) || 30,
  userAgent: env.USER_AGENT ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
}
