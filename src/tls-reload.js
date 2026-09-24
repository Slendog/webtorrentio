import crypto from 'node:crypto'
import fs from 'node:fs'
import tls from 'node:tls'

// Certificates are replaced from outside (a renewal by a certificate manager, `npm run certs`,
// a mounted folder). Watch the files and swap the certificate into the running HTTPS server:
// new connections get it at once, open ones keep theirs. A pair that does not load (half
// written, key and certificate not matching) is ignored until the next change, and the old
// certificate stays in use. SIGHUP forces a reload.

const CHECK_EVERY_MS = 10_000
const SETTLE_MS = 2_000 // wait for the other file of the pair after the first one changes

const describe = pem => {
  const c = new crypto.X509Certificate(pem)
  return `serial ${c.serialNumber.slice(-8)}, expires ${new Date(c.validTo).toISOString().slice(0, 10)}`
}

export function loadPair ({ cert, key }) {
  const pair = { cert: fs.readFileSync(cert), key: fs.readFileSync(key) }
  tls.createSecureContext(pair) // throws when the pair does not load or does not match
  return pair
}

export function watchCertificate (server, files) {
  let current = describe(fs.readFileSync(files.cert))
  let timer = null
  console.log(`[tls] certificate ${files.cert} (${current}); reloaded automatically when replaced`)

  const reload = reason => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        const pair = loadPair(files)
        const next = describe(pair.cert)
        server.setSecureContext(pair)
        console.log(`[tls] certificate reloaded (${reason}): ${next}${next === current ? ' (unchanged)' : `, was ${current}`}`)
        current = next
      } catch (err) {
        console.warn(`[tls] new certificate files do not load (${err.message}); still serving ${current}`)
      }
    }, reason === 'SIGHUP' ? 0 : SETTLE_MS)
  }

  for (const file of [files.cert, files.key]) {
    fs.watchFile(file, { interval: CHECK_EVERY_MS }, (now, before) => {
      if (now.mtimeMs !== before.mtimeMs || now.size !== before.size || now.ino !== before.ino) reload('file changed')
    })
  }
  process.on('SIGHUP', () => reload('SIGHUP'))
}
