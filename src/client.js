import http from 'node:http'
import { socketPath } from './paths.js'

// Talks to a running server's admin socket (see admin.js).
export function adminRequest (method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const req = http.request({
      socketPath,
      path,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 5000
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(text) } catch {}
        if (res.statusCode >= 400) return reject(new Error(json?.error || `HTTP ${res.statusCode}`))
        resolve(json)
      })
    })
    req.on('timeout', () => req.destroy(new Error('Admin request timed out')))
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

export async function serverRunning () {
  try {
    return await adminRequest('GET', '/state?since=999999999')
  } catch {
    return null
  }
}
