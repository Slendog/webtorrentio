// Reads the keyframe index of an MP4 or MKV file without reading the video data: the MP4
// "moov" box (sample tables) or the Matroska "Cues" element. The audio conversion cuts its
// HLS segments at these keyframes, so segment n always starts at the same time, no matter
// where a conversion (re)starts.
//
// `read(start, end)` returns a Buffer with bytes start..end (inclusive) of the file.
// Result: { container, videoCodec, duration (s), keyframes: [s, ...] }, or null when the file
// has no usable index (fragmented MP4, MKV without Cues, another container).

const MAX_INDEX_BYTES = 64 * 1024 ** 2

export async function readKeyframeIndex (read, size) {
  const head = await read(0, Math.min(size, 64 * 1024) - 1)
  if (head.length >= 8 && head.toString('latin1', 4, 8) === 'ftyp') return mp4Index(read, size)
  if (head.readUInt32BE(0) === 0x1A45DFA3) return mkvIndex(read, size, head)
  return null
}

// ---- MP4

function boxHeader (buf, at) {
  let size = buf.readUInt32BE(at)
  const type = buf.toString('latin1', at + 4, at + 8)
  let header = 8
  if (size === 1) {
    size = Number(buf.readBigUInt64BE(at + 8))
    header = 16
  }
  return { size, type, header }
}

// Child boxes of a container box's payload.
function * boxes (buf, start = 0, end = buf.length) {
  let at = start
  while (at + 8 <= end) {
    const { size, type, header } = boxHeader(buf, at)
    const boxEnd = size === 0 ? end : at + size
    if (size !== 0 && size < header) return
    yield { type, start: at + header, end: Math.min(boxEnd, end) }
    at = boxEnd
  }
}

const child = (buf, parent, type) => {
  for (const b of boxes(buf, parent.start, parent.end)) if (b.type === type) return b
  return null
}

async function mp4Index (read, size) {
  // Top-level boxes: ftyp, moov, mdat, ... The moov box is at the start or the end.
  let at = 0
  let moov = null
  while (at < size) {
    const h = await read(at, Math.min(at + 16, size) - 1)
    if (h.length < 8) break
    const { size: boxSize, type } = boxHeader(h, 0)
    const boxEnd = boxSize === 0 ? size : at + boxSize
    if (type === 'moov') {
      if (boxEnd - at > MAX_INDEX_BYTES) return null
      moov = await read(at, boxEnd - 1)
      break
    }
    if (type === 'moof') return null // fragmented MP4: no sample tables in moov
    if (boxSize !== 0 && boxSize < 8) return null
    at = boxEnd
  }
  if (!moov) return null
  const root = { start: 8, end: moov.length }

  const mvhd = child(moov, root, 'mvhd')
  const movieScale = mvhd ? fullBoxTimes(moov, mvhd.start).timescale : 1000
  const movieDuration = mvhd ? fullBoxTimes(moov, mvhd.start).duration / movieScale : 0

  for (const trak of boxes(moov, root.start, root.end)) {
    if (trak.type !== 'trak') continue
    const mdia = child(moov, trak, 'mdia')
    const hdlr = mdia && child(moov, mdia, 'hdlr')
    if (!hdlr || moov.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue
    const mdhd = child(moov, mdia, 'mdhd')
    const stbl = child(moov, child(moov, mdia, 'minf') || { start: 0, end: 0 }, 'stbl')
    if (!mdhd || !stbl) return null
    const { timescale } = fullBoxTimes(moov, mdhd.start)

    const stsd = child(moov, stbl, 'stsd')
    const videoCodec = stsd ? moov.toString('latin1', stsd.start + 12, stsd.start + 16) : null

    // Decoding time of every sample (stts), then its presentation time (ctts).
    const stts = child(moov, stbl, 'stts')
    if (!stts) return null
    const dts = []
    let t = 0
    for (let i = 0, n = moov.readUInt32BE(stts.start + 4); i < n; i++) {
      const count = moov.readUInt32BE(stts.start + 8 + i * 8)
      const delta = moov.readUInt32BE(stts.start + 12 + i * 8)
      for (let k = 0; k < count; k++) { dts.push(t); t += delta }
    }
    const pts = dts.slice()
    const ctts = child(moov, stbl, 'ctts')
    if (ctts) {
      let s = 0
      for (let i = 0, n = moov.readUInt32BE(ctts.start + 4); i < n; i++) {
        const count = moov.readUInt32BE(ctts.start + 8 + i * 8)
        const offset = moov.readInt32BE(ctts.start + 12 + i * 8)
        for (let k = 0; k < count && s < pts.length; k++) pts[s++] += offset
      }
    }

    // Edit list: an empty edit delays the track, the first real edit's media time is where
    // playback starts. ffmpeg applies both the same way.
    let shift = 0
    const elst = child(moov, child(moov, trak, 'edts') || { start: 0, end: 0 }, 'elst')
    if (elst) {
      const v1 = moov[elst.start] === 1
      let p = elst.start + 8
      for (let i = 0, n = moov.readUInt32BE(elst.start + 4); i < n; i++) {
        const segDuration = v1 ? Number(moov.readBigUInt64BE(p)) : moov.readUInt32BE(p)
        const mediaTime = v1 ? Number(moov.readBigInt64BE(p + 8)) : moov.readInt32BE(p + 4)
        p += v1 ? 20 : 12
        if (mediaTime === -1) { shift += segDuration / movieScale * timescale; continue }
        shift -= mediaTime
        break
      }
    }

    // Sync samples (stss); without the box every sample is a keyframe.
    const stss = child(moov, stbl, 'stss')
    const sync = []
    if (stss) {
      for (let i = 0, n = moov.readUInt32BE(stss.start + 4); i < n; i++) sync.push(moov.readUInt32BE(stss.start + 8 + i * 4) - 1)
    } else {
      for (let i = 0; i < pts.length; i++) sync.push(i)
    }
    const keyframes = sync.filter(i => i < pts.length).map(i => (pts[i] + shift) / timescale).sort((a, b) => a - b)
    const duration = movieDuration || fullBoxTimes(moov, mdhd.start).duration / timescale
    return { container: 'mp4', videoCodec, duration, keyframes }
  }
  return null
}

// timescale and duration of an mvhd or mdhd box (version 0 or 1).
function fullBoxTimes (buf, at) {
  return buf[at] === 1
    ? { timescale: buf.readUInt32BE(at + 20), duration: Number(buf.readBigUInt64BE(at + 24)) }
    : { timescale: buf.readUInt32BE(at + 12), duration: buf.readUInt32BE(at + 16) }
}

// ---- Matroska

const ID = {
  Segment: 0x18538067,
  SeekHead: 0x114D9B74,
  Seek: 0x4DBB,
  SeekID: 0x53AB,
  SeekPosition: 0x53AC,
  Info: 0x1549A966,
  TimecodeScale: 0x2AD7B1,
  Duration: 0x4489,
  Tracks: 0x1654AE6B,
  TrackEntry: 0xAE,
  TrackNumber: 0xD7,
  TrackType: 0x83,
  CodecID: 0x86,
  Cues: 0x1C53BB6B,
  CuePoint: 0xBB,
  CueTime: 0xB3,
  CueTrackPositions: 0xB7,
  CueTrack: 0xF7,
  Cluster: 0x1F43B675
}

// Element ID (marker bits kept) and data size (marker bit removed) at `at`.
function ebmlHeader (buf, at) {
  const first = buf[at]
  let idLen = 1
  while (idLen <= 4 && !(first & (0x80 >> (idLen - 1)))) idLen++
  if (idLen > 4 || at + idLen > buf.length) return null
  let id = 0
  for (let i = 0; i < idLen; i++) id = id * 256 + buf[at + i]
  const s = buf[at + idLen]
  let sizeLen = 1
  while (sizeLen <= 8 && !(s & (0x80 >> (sizeLen - 1)))) sizeLen++
  if (sizeLen > 8 || at + idLen + sizeLen > buf.length) return null
  let size = s & (0xFF >> sizeLen)
  let unknown = size === (0xFF >> sizeLen)
  for (let i = 1; i < sizeLen; i++) {
    const b = buf[at + idLen + i]
    size = size * 256 + b
    if (b !== 0xFF) unknown = false
  }
  return { id, size: unknown ? -1 : size, header: idLen + sizeLen }
}

function * elements (buf, start = 0, end = buf.length) {
  let at = start
  while (at < end) {
    const h = ebmlHeader(buf, at)
    if (!h) return
    const dataStart = at + h.header
    const dataEnd = h.size < 0 ? end : dataStart + h.size
    yield { id: h.id, start: dataStart, end: dataEnd, at }
    if (h.size < 0) return
    at = dataEnd
  }
}

const uint = (buf, e) => { let v = 0; for (let i = e.start; i < e.end; i++) v = v * 256 + buf[i]; return v }
const float = (buf, e) => e.end - e.start === 4 ? buf.readFloatBE(e.start) : buf.readDoubleBE(e.start)

async function mkvIndex (read, size, head) {
  // EBML header, then the Segment. Positions in SeekHead are relative to the segment data.
  let segment = null
  for (const e of elements(head, 0, head.length)) {
    if (e.id === ID.Segment) { segment = e; break }
  }
  if (!segment) return null
  const segStart = segment.start

  let timecodeScale = 1_000_000
  let duration = 0
  let videoTrack = null
  let videoCodec = null
  const seeks = new Map()

  const parseTop = (buf, e) => {
    if (e.id === ID.SeekHead) {
      for (const s of elements(buf, e.start, e.end)) {
        if (s.id !== ID.Seek) continue
        let sid = null
        let pos = null
        for (const f of elements(buf, s.start, s.end)) {
          if (f.id === ID.SeekID) sid = uint(buf, f)
          if (f.id === ID.SeekPosition) pos = uint(buf, f)
        }
        if (sid != null && pos != null && !seeks.has(sid)) seeks.set(sid, pos)
      }
    } else if (e.id === ID.Info) {
      for (const f of elements(buf, e.start, e.end)) {
        if (f.id === ID.TimecodeScale) timecodeScale = uint(buf, f)
        if (f.id === ID.Duration) duration = float(buf, f)
      }
    } else if (e.id === ID.Tracks) {
      for (const t of elements(buf, e.start, e.end)) {
        if (t.id !== ID.TrackEntry) continue
        let number = null
        let type = null
        let codec = null
        for (const f of elements(buf, t.start, t.end)) {
          if (f.id === ID.TrackNumber) number = uint(buf, f)
          if (f.id === ID.TrackType) type = uint(buf, f)
          if (f.id === ID.CodecID) codec = buf.toString('latin1', f.start, f.end).replace(/\0+$/, '')
        }
        if (type === 1 && videoTrack == null) { videoTrack = number; videoCodec = codec }
      }
    }
  }

  // Read one top-level element at an absolute file offset (when it is not in `head`).
  const readElement = async at => {
    const h = ebmlHeader(await read(at, Math.min(at + 16, size) - 1), 0)
    if (!h || h.size < 0 || h.size > MAX_INDEX_BYTES) return null
    const buf = await read(at, Math.min(at + h.header + h.size, size) - 1)
    return { buf, e: { id: h.id, start: h.header, end: buf.length } }
  }

  // Elements before the first Cluster are usually all in the first 64 KB.
  const seen = new Set()
  for (const e of elements(head, segStart, head.length)) {
    if (e.id === ID.Cluster) break
    if (e.end > head.length) {
      const el = await readElement(e.at)
      if (el) { parseTop(el.buf, el.e); seen.add(e.id) }
      continue
    }
    parseTop(head, e)
    seen.add(e.id)
  }
  // Anything still missing, including a second SeekHead, via the SeekHead positions.
  for (const id of [ID.SeekHead, ID.Info, ID.Tracks]) {
    if (seen.has(id) || !seeks.has(id)) continue
    const el = await readElement(segStart + seeks.get(id))
    if (el && el.e.id === id) { parseTop(el.buf, el.e); seen.add(id) }
  }
  if (videoTrack == null || !seeks.has(ID.Cues)) return null

  const cues = await readElement(segStart + seeks.get(ID.Cues))
  if (!cues || cues.e.id !== ID.Cues) return null
  const keyframes = []
  for (const p of elements(cues.buf, cues.e.start, cues.e.end)) {
    if (p.id !== ID.CuePoint) continue
    let time = null
    let video = false
    for (const f of elements(cues.buf, p.start, p.end)) {
      if (f.id === ID.CueTime) time = uint(cues.buf, f)
      if (f.id === ID.CueTrackPositions) {
        for (const g of elements(cues.buf, f.start, f.end)) if (g.id === ID.CueTrack && uint(cues.buf, g) === videoTrack) video = true
      }
    }
    if (time != null && video) keyframes.push(time * timecodeScale / 1e9)
  }
  if (!keyframes.length) return null
  keyframes.sort((a, b) => a - b)
  return { container: 'mkv', videoCodec, duration: duration * timecodeScale / 1e9, keyframes }
}
