import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serverRunning } from './client.js'
import { logFile, stateDir } from './paths.js'

// Command line entry point:
//   node src/index.js              run the server in the foreground
//   node src/index.js background   start the server detached, logging to state/server.log
//   node src/index.js dashboard    open the TUI on the running server (starts one if needed)

const START_TIMEOUT_MS = 20_000

async function startBackground () {
  const running = await serverRunning()
  if (running) {
    console.log(`Server already running (pid ${running.pid}).`)
    return running
  }

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(stateDir, 0o700)
  const out = fs.openSync(logFile, 'a', 0o600)
  fs.chmodSync(logFile, 0o600)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env
  })
  let exited = null
  child.once('exit', code => { exited = code })
  child.unref()

  // Wait until the admin socket answers, or the child dies (port in use, bad config, ...).
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    if (exited !== null) break
    const state = await serverRunning()
    if (state) {
      console.log(`Server started in the background (pid ${state.pid}).`)
      console.log(`  Log:       ${logFile}`)
      console.log('  Dashboard: npm start dashboard')
      console.log('  Stop:      npm stop')
      return state
    }
  }
  const tail = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-10).join('\n')
  console.error(`Server did not start${exited !== null ? ` (exit code ${exited})` : ''}. Last log lines:\n${tail}`)
  process.exit(1)
}

const mode = process.argv[2]

if (!mode || mode === 'server') {
  await import('./server.js')
} else if (mode === 'background') {
  await startBackground()
} else if (mode === 'dashboard') {
  if (!(await serverRunning())) {
    console.log('No server running; starting one in the background...')
    await startBackground()
  }
  const { startTui } = await import('./tui.js')
  await startTui()
} else {
  console.error(`Unknown command "${mode}". Use: npm start [background|dashboard]`)
  process.exit(1)
}
