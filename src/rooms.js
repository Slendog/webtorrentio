import crypto from 'node:crypto'
import { config } from './config.js'
import { activeConversions, conversionAvailable, endSharedSession } from './convert.js'
import { oneLine } from './logbuffer.js'

// Watch together: rooms whose members play the same file in a browser page (watch-page.js),
// kept at the same position by the server.
//
// The room holds one shared playback state: playing, position (seconds of the video),
// updatedAt (server clock) and rate. While playing, the expected position at time t is
// position + (t - updatedAt) * rate. Clients correct their own drift against it (see the page).
// Every action (play, pause, seek, rate) is stamped with the server time and broadcast over
// Server-Sent Events; the last action wins.
//
// "Wait for everyone" (default on): when a member's video stalls, the room pauses until every
// member can play again, then everyone resumes together.
//
// All members stream the room's own conversion (convert.js, keyed by the room id), so a room
// costs one ffmpeg process however many people are in it. It counts against the host's limits.

// A room nobody is connected to is closed after this long.
const EMPTY_ROOM_MS = 10 * 60 * 1000
const PING_MS = 15_000
const MAX_MEMBERS = 20

export class RoomError extends Error {
  constructor (message, status = 400) {
    super(message)
    this.status = status
  }
}

const rooms = new Map() // id -> room

export const roomsAvailable = () => config.maxRooms > 0 && conversionAvailable()

export const getRoom = id => rooms.get(id) || null

// Whether a new room can start now: a free room slot, and a free audio conversion for it.
// Returns null when it can, else the reason.
export function roomUnavailable () {
  if (rooms.size >= config.maxRooms) return `All rooms are in use (limit ${config.maxRooms}).`
  if (activeConversions() >= config.audioConversions) return `All audio conversions are in use (limit ${config.audioConversions}).`
  return null
}

// The open room this user hosts for a torrent (and episode), if any.
export const hostedRoom = (host, infoHash, season, episode) =>
  [...rooms.values()].find(r => r.host === host && r.infoHash === infoHash && r.season === season && r.episode === episode) || null

export function createRoom ({ host, infoHash, fileIdx, season, episode, type, stremioId, name }) {
  if (!conversionAvailable()) throw new RoomError('Watch together needs the stereo audio conversion (AUDIO_CONVERSIONS) to be on.', 503)
  if (!config.maxRooms) throw new RoomError('Watch together is turned off on this server.', 503)
  // The host clicked "Together" again for the same file: back to the open room.
  for (const r of rooms.values()) {
    if (r.host === host && r.infoHash === infoHash.toLowerCase() && r.fileIdx === fileIdx && r.season === season && r.episode === episode) return r
  }
  if (rooms.size >= config.maxRooms) throw new RoomError(`All ${config.maxRooms} watch-together rooms are in use. Try again later.`, 503)
  const id = crypto.randomBytes(8).toString('base64url').slice(0, 10)
  const now = Date.now()
  const room = {
    id,
    host,
    infoHash: infoHash.toLowerCase(),
    fileIdx,
    season,
    episode,
    type,
    stremioId,
    name: name || null,
    createdAt: now,
    settings: { waitForAll: true, hostOnly: false },
    state: { playing: false, position: 0, updatedAt: now, rate: 1 },
    // Paused only because someone buffers: resume when everyone is ready.
    resumeWhenReady: false,
    members: new Map(), // clientId -> member
    emptySince: now,
    lastAction: null,
    subtitles: null
  }
  rooms.set(id, room)
  console.log(`[room] ${host} opened room ${id} for ${oneLine(room.name || room.infoHash.slice(0, 8))}`)
  return room
}

export function closeRoom (id, reason = 'closed') {
  const room = rooms.get(id)
  if (!room) return false
  rooms.delete(id)
  for (const m of room.members.values()) {
    send(m, 'closed', { reason })
    m.res.end()
  }
  room.members.clear()
  endSharedSession(id)
  console.log(`[room] room ${id} ${reason}`)
  return true
}

export const expectedPosition = (state, t = Date.now()) =>
  state.playing ? state.position + (t - state.updatedAt) / 1000 * state.rate : state.position

// ---- Members (one per open page, identified by a random client id)

function send (member, event, data) {
  member.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function memberList (room) {
  const now = Date.now()
  return [...room.members.values()].map(m => ({
    clientId: m.clientId,
    user: m.user,
    name: m.name,
    host: m.user === room.host,
    buffering: m.buffering,
    // Seconds ahead (+) or behind (-) of the room, from the member's last report.
    drift: m.reportedAt ? Math.round((m.position - expectedPosition(room.state, m.reportedAt)) * 10) / 10 : null,
    stale: m.reportedAt ? now - m.reportedAt > 15_000 : true
  }))
}

function snapshot (room) {
  return {
    state: room.state,
    settings: room.settings,
    host: room.host,
    members: memberList(room),
    waitingFor: room.resumeWhenReady ? [...room.members.values()].filter(m => m.buffering).map(m => m.name) : [],
    lastAction: room.lastAction,
    serverTime: Date.now()
  }
}

function broadcast (room) {
  const data = snapshot(room)
  for (const m of room.members.values()) send(m, 'state', data)
}

// Open the Server-Sent Events stream of a member. `res` stays open until the page closes.
export function join (room, { user, clientId, name, res }) {
  if (!/^[\w-]{8,40}$/.test(clientId || '')) throw new RoomError('Bad client id')
  if (!room.members.has(clientId) && room.members.size >= MAX_MEMBERS) throw new RoomError(`Room is full (${MAX_MEMBERS} people).`, 429)
  const old = room.members.get(clientId)
  if (old) old.res.end()
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Proxies that buffer responses (nginx) must pass events through at once.
    'X-Accel-Buffering': 'no'
  })
  res.write(': connected\n\n')
  const member = {
    clientId,
    user,
    name: String(name || user).replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 24) || user,
    res,
    buffering: false,
    position: 0,
    reportedAt: 0,
    joinedAt: Date.now()
  }
  room.members.set(clientId, member)
  const ping = setInterval(() => res.write(': ping\n\n'), PING_MS)
  res.on('close', () => {
    clearInterval(ping)
    if (room.members.get(clientId) !== member) return
    room.members.delete(clientId)
    if (!room.members.size) {
      // Nobody left: stop the clock, so the next person continues where the last one left.
      room.emptySince = Date.now()
      room.resumeWhenReady = false
      if (room.state.playing) applyState(room, { playing: false })
      // Free the conversion for others; the next member to join starts it again.
      endSharedSession(room.id)
    }
    releaseIfReady(room)
    broadcast(room)
  })
  broadcast(room)
}

// ---- Actions

function applyState (room, change) {
  const now = Date.now()
  room.state = { ...room.state, position: expectedPosition(room.state, now), updatedAt: now, ...change }
}

export function act (room, { user, clientId, type, position, rate, settings }) {
  const member = room.members.get(clientId)
  if (!member || member.user !== user) throw new RoomError('Join the room first.', 403)
  const isHost = user === room.host
  if (type === 'settings') {
    if (!isHost) throw new RoomError('Only the host can change room settings.', 403)
    if (typeof settings?.waitForAll === 'boolean') room.settings.waitForAll = settings.waitForAll
    if (typeof settings?.hostOnly === 'boolean') room.settings.hostOnly = settings.hostOnly
    if (!room.settings.waitForAll && room.resumeWhenReady) {
      room.resumeWhenReady = false
      applyState(room, { playing: true })
    }
    room.lastAction = { type, by: member.name, at: Date.now() }
    return broadcast(room)
  }
  if (room.settings.hostOnly && !isHost) throw new RoomError('Only the host controls playback in this room.', 403)

  if (type === 'play') {
    if (room.settings.waitForAll && [...room.members.values()].some(m => m.buffering)) {
      room.resumeWhenReady = true
      applyState(room, { playing: false })
    } else {
      room.resumeWhenReady = false
      applyState(room, { playing: true })
    }
  } else if (type === 'pause') {
    room.resumeWhenReady = false
    applyState(room, { playing: false, ...(Number.isFinite(position) ? { position: Math.max(0, position) } : {}) })
  } else if (type === 'seek') {
    if (!Number.isFinite(position) || position < 0) throw new RoomError('Bad position')
    applyState(room, { position })
  } else if (type === 'rate') {
    if (!Number.isFinite(rate) || rate < 0.25 || rate > 3) throw new RoomError('Rate must be between 0.25 and 3')
    applyState(room, { rate })
  } else {
    throw new RoomError('Unknown action')
  }
  room.lastAction = { type, by: member.name, at: Date.now(), position: room.state.position }
  broadcast(room)
}

// A member's periodic report: playback position, and whether its video is stalled.
export function report (room, { user, clientId, buffering, position }) {
  const member = room.members.get(clientId)
  if (!member || member.user !== user) throw new RoomError('Join the room first.', 403)
  if (Number.isFinite(position)) {
    member.position = position
    member.reportedAt = Date.now()
  }
  const was = member.buffering
  member.buffering = Boolean(buffering)
  if (member.buffering && !was && room.settings.waitForAll && room.state.playing) {
    // Hold the room where it is until this member can play again.
    room.resumeWhenReady = true
    applyState(room, { playing: false })
    room.lastAction = { type: 'wait', by: member.name, at: Date.now(), position: room.state.position }
    return broadcast(room)
  }
  if (was && !member.buffering) releaseIfReady(room)
  broadcast(room)
}

function releaseIfReady (room) {
  if (!room.resumeWhenReady) return
  if ([...room.members.values()].some(m => m.buffering)) return
  room.resumeWhenReady = false
  applyState(room, { playing: true })
  room.lastAction = { type: 'resume', by: 'everyone ready', at: Date.now(), position: room.state.position }
}

// ---- Housekeeping and dashboards

setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) {
    if (!room.members.size && now - room.emptySince > EMPTY_ROOM_MS) closeRoom(room.id, 'closed (nobody left)')
  }
  // Keep drift and "stale" in the member lists fresh.
  for (const room of rooms.values()) if (room.members.size) broadcast(room)
}, 5000).unref()

export function roomStatus () {
  return [...rooms.values()].map(r => ({
    id: r.id,
    host: r.host,
    name: r.name,
    infoHash: r.infoHash,
    playing: r.state.playing,
    waiting: r.resumeWhenReady,
    position: Math.round(expectedPosition(r.state)),
    members: memberList(r).map(m => ({ name: m.name, user: m.user, buffering: m.buffering, drift: m.drift })),
    createdAt: r.createdAt
  }))
}

export function closeAllRooms () {
  for (const id of [...rooms.keys()]) closeRoom(id, 'closed (server stopping)')
}
