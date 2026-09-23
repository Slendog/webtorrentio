import path from 'node:path'

// Files next to the state file: the admin socket the dashboard connects to, and the log of a
// server started in the background.
export const stateFile = path.resolve(process.env.STATE_FILE || 'state/state.json')
export const stateDir = path.dirname(stateFile)
export const socketPath = process.env.ADMIN_SOCKET || path.join(stateDir, 'admin.sock')
export const logFile = path.join(stateDir, 'server.log')
