import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'
import { stateFile } from './paths.js'

// Users and limits that can change while the server runs (from the TUI dashboard).
// Changes are saved to STATE_FILE and override the environment on the next start.
// Users from ACCESS_TOKENS are always loaded; users added at runtime live in the state file.

const MB = 1024 ** 2
const GB = 1024 ** 3

// Editable limits: config key, label, unit shown to the user, and the allowed range.
export const LIMITS = [
  { key: 'maxActiveTorrents', label: 'Torrents total', unit: '', scale: 1, min: 1, max: 100 },
  { key: 'maxTorrentsPerUser', label: 'Torrents per user', unit: '', scale: 1, min: 1, max: 100 },
  { key: 'maxDiskBytes', label: 'Disk total', unit: 'GB', scale: GB, min: 0, max: 100_000, zero: 'unlimited' },
  { key: 'maxDiskPerStreamBytes', label: 'Disk per stream', unit: 'MB', scale: MB, min: 0, max: 10_000_000, zero: 'unlimited', minNonZero: 128 },
  { key: 'readaheadBytes', label: 'Readahead', unit: 'MB', scale: MB, min: 16, max: 100_000 },
  { key: 'idleTimeoutMs', label: 'Idle timeout', unit: 'min', scale: 60_000, min: 0.1, max: 1440 }
]

const users = new Map() // name -> { token, source: 'env' | 'runtime', createdAt }
const listeners = new Set()

export const onChange = fn => listeners.add(fn)
const changed = () => { for (const fn of listeners) fn() }

function save () {
  const limits = {}
  for (const { key } of LIMITS) limits[key] = config[key]
  const runtimeUsers = [...users].filter(([, u]) => u.source === 'runtime')
    .map(([user, u]) => ({ user, token: u.token, createdAt: u.createdAt }))
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 })
  // Tokens are secrets: keep the file readable by the owner only.
  fs.writeFileSync(stateFile, JSON.stringify({ users: runtimeUsers, limits }, null, 2) + '\n', { mode: 0o600 })
}

function load () {
  for (const { user, token } of config.accessTokens) users.set(user, { token, source: 'env', createdAt: null })
  if (!fs.existsSync(stateFile)) return
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    for (const u of state.users || []) {
      if (!users.has(u.user)) users.set(u.user, { token: u.token, source: 'runtime', createdAt: u.createdAt })
    }
    for (const { key } of LIMITS) {
      if (typeof state.limits?.[key] === 'number') config[key] = state.limits[key]
    }
    console.log(`Loaded ${state.users?.length || 0} user(s) and saved limits from ${stateFile}`)
  } catch (err) {
    console.error(`Cannot read ${stateFile}: ${err.message}`)
  }
}

load()

export const statePath = stateFile

export function listUsers () {
  return [...users].map(([user, u]) => ({ user, ...u }))
}

export const authRequired = () => users.size > 0

const digest = s => crypto.createHash('sha256').update(String(s)).digest()

// Constant-time lookup of the user that owns a token. Hashing first gives equal-length buffers.
export function userForToken (token) {
  const hash = digest(token || '')
  let found = null
  for (const [user, u] of users) if (crypto.timingSafeEqual(digest(u.token), hash)) found = user
  return found
}

export function addUser (name) {
  name = String(name || '').trim()
  if (!/^[\w.-]{1,32}$/.test(name)) throw new Error('Name: 1-32 letters, digits, ".", "-" or "_"')
  if (users.has(name)) throw new Error(`User ${name} already exists`)
  const token = crypto.randomBytes(24).toString('base64url')
  users.set(name, { token, source: 'runtime', createdAt: new Date().toISOString() })
  save()
  changed()
  return token
}

export function removeUser (name) {
  const u = users.get(name)
  if (!u) throw new Error(`No user ${name}`)
  if (u.source === 'env') throw new Error(`${name} comes from ACCESS_TOKENS; remove it there and restart`)
  users.delete(name)
  save()
  changed()
}

// Value shown to the user, in the limit's unit.
export const limitValue = l => config[l.key] / l.scale

export function formatLimit (l) {
  const v = limitValue(l)
  if (v === 0 && l.zero) return l.zero
  return `${Number(v.toFixed(2))}${l.unit ? ' ' + l.unit : ''}`
}

export function setLimit (key, input) {
  const l = LIMITS.find(x => x.key === key)
  if (!l) throw new Error(`Unknown limit ${key}`)
  const v = Number(String(input).trim())
  if (!Number.isFinite(v) || v < l.min || v > l.max) throw new Error(`${l.label}: enter a number from ${l.min} to ${l.max}${l.zero ? ` (0 = ${l.zero})` : ''}`)
  if (l.minNonZero && v !== 0 && v < l.minNonZero) throw new Error(`${l.label}: 0 or at least ${l.minNonZero}`)
  if (l.scale === 1 && !Number.isInteger(v)) throw new Error(`${l.label}: whole numbers only`)
  config[key] = Math.round(v * l.scale)
  save()
  changed()
}
