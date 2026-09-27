// Readable titles from release names: "Mayday.2026.1080p.BluRay.x264-[YTS].mp4" -> "Mayday 2026",
// "Reacher.S01E08.1080p.BluRay.x265-RARBG.mp4" -> "Reacher S01E08". Falls back to the name.
const clean = s => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '')

export function prettyTitle (name) {
  const base = clean(name).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()
  const cut = base.search(/\b(19|20)\d{2}\b|\bS\d{1,2}E\d{1,3}\b|\b(480|576|720|1080|2160)p\b/i)
  if (cut <= 0) return base
  const m = base.slice(cut).match(/^((19|20)\d{2}|S\d{1,2}E\d{1,3})/i)
  const prefix = base.slice(0, cut).replace(/[\s([{-]+$/, '')
  return (m ? `${prefix} ${m[0]}` : prefix).trim() || base
}
