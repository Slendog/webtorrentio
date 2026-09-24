// Where the server runs, for messages that tell the user what to type, and how to fail.
// The Docker image sets WEBTORRENTIO_DOCKER=1.

export const inDocker = process.env.WEBTORRENTIO_DOCKER === '1'

export const commands = inDocker
  ? { dashboard: 'docker compose exec addon node src/index.js dashboard', stop: 'docker compose stop addon' }
  : { dashboard: 'npm start dashboard', stop: 'npm stop' }

// Stop because of a setup problem (bad configuration, port in use). In Docker the restart
// policy starts the container again at once, which would repeat the same error several times
// a second; waiting first keeps the log readable. Blocking on purpose: during startup nothing
// else may run.
export function fatal (message) {
  console.error(message)
  if (inDocker) {
    console.error('Waiting 30 s before exiting, so a restart loop does not flood the log. Fix the setting and restart the container.')
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000)
  }
  process.exit(1)
}
