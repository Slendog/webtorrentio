// Stop a running addon server. First asks it over the admin socket (works for servers started
// in the background, on any port); falls back to SIGTERM for whatever listens on the ports.
// Both let the server destroy its torrents and delete their data before exiting.
import { execFileSync } from 'node:child_process'
import { adminRequest } from '../src/client.js'

try {
  const state = await adminRequest('GET', '/state?since=999999999')
  await adminRequest('POST', '/shutdown', { by: 'npm stop' })
  console.log(`Stopping server (pid ${state.pid})`)
  process.exit(0)
} catch {
  // No admin socket: an older server, or none at all.
}

const ports = [Number(process.env.PORT) || 7000, Number(process.env.HTTPS_PORT) || 7443]

const pids = new Set()
for (const port of ports) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    out.split('\n').filter(Boolean).forEach(pid => pids.add(Number(pid)))
  } catch {
    // lsof exits with status 1 when nothing listens on the port.
  }
}

if (!pids.size) {
  console.log(`No server running (no admin socket, nothing listening on ports ${ports.join(', ')})`)
  process.exit(0)
}

for (const pid of pids) {
  process.kill(pid, 'SIGTERM')
  console.log(`Sent SIGTERM to ${pid}`)
}
