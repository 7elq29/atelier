/**
 * Natural-language parse for agenda task create/edit.
 * Extracts start time, duration, and #tags from a freeform sentence.
 * Kept free of DOM/React so main + renderer (and tests) can share it.
 */

export type NlEntityKind = 'tag' | 'time' | 'duration'

export interface NlSegment {
  text: string
  kind?: NlEntityKind
}

export interface NlParseResult {
  raw: string
  /** Title + tags suitable for addTask / update (time & duration phrases removed). */
  content: string
  tags: string[]
  startMin: number | null
  durationMin: number | null
  segments: NlSegment[]
}

export const NL_DUR_STEPS_MIN = [15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240] as const

const TAG_RE = /#([\w/-]+)/g

/** Duration: "for 1 h", "1h", "30 minutes", "for 1.5 hours" */
const DUR_RE =
  /\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi

/**
 * Start time. Prefer "at …"; also bare clock with am/pm or HH:MM (24h).
 * Minutes must be two digits when a colon is present (avoids "1:1").
 */
const TIME_AT_RE =
  /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/gi
const TIME_BARE_RE =
  /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/gi
const TIME_24_RE =
  /\b([01]?\d|2[0-3]):([0-5]\d)\b/g

export function nearestDurIdx(minutes: number, steps: readonly number[] = NL_DUR_STEPS_MIN): number {
  let best = 0
  for (let i = 1; i < steps.length; i++) {
    if (Math.abs(steps[i]! - minutes) < Math.abs(steps[best]! - minutes)) best = i
  }
  return best
}

export function formatClock12(totalMin: number): string {
  const hour = Math.floor(totalMin / 60)
  const minute = totalMin % 60
  const hour12 = hour % 12 || 12
  const suffix = hour < 12 ? 'am' : 'pm'
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`
}

export function formatStartPhrase(startMin: number): string {
  return `at ${formatClock12(startMin)}`
}

export function formatDurationPhrase(durationMin: number): string {
  if (durationMin < 60) return `for ${durationMin} minutes`
  if (durationMin % 60 === 0) {
    const h = durationMin / 60
    return h === 1 ? 'for 1 h' : `for ${h} h`
  }
  const h = Math.floor(durationMin / 60)
  const m = durationMin % 60
  return `for ${h} h ${m} min`
}

function clockToMinutes(h: number, min: number, ampm?: string | null): number | null {
  if (min < 0 || min > 59 || h < 0) return null
  let hour = h
  if (ampm) {
    const ap = ampm.toLowerCase()
    if (ap === 'pm' && hour < 12) hour += 12
    if (ap === 'am' && hour === 12) hour = 0
    if (hour > 23) return null
  } else if (hour > 23) {
    return null
  }
  return hour * 60 + min
}

function parseDurationToken(amount: number, unit: string): number | null {
  const u = unit.toLowerCase()
  if (u.startsWith('h')) {
    const mins = Math.round(amount * 60)
    return mins > 0 ? mins : null
  }
  if (u.startsWith('m')) {
    const mins = Math.round(amount)
    return mins > 0 ? mins : null
  }
  return null
}

interface SpanHit {
  start: number
  end: number
  kind: NlEntityKind
  startMin?: number
  durationMin?: number
  tag?: string
}

function collectHits(raw: string): SpanHit[] {
  const hits: SpanHit[] = []
  const occupied = (a: number, b: number): boolean =>
    hits.some((h) => a < h.end && b > h.start)

  // Tags
  TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = TAG_RE.exec(raw)) !== null) {
    hits.push({ start: m.index, end: m.index + m[0].length, kind: 'tag', tag: m[1] })
  }

  // Duration first (so "for 1 h" isn't partially eaten by time)
  DUR_RE.lastIndex = 0
  while ((m = DUR_RE.exec(raw)) !== null) {
    const durationMin = parseDurationToken(parseFloat(m[1]!), m[2]!)
    if (durationMin == null) continue
    const start = m.index
    const end = start + m[0].length
    if (occupied(start, end)) continue
    hits.push({ start, end, kind: 'duration', durationMin })
  }

  // "at 9:00 am"
  TIME_AT_RE.lastIndex = 0
  while ((m = TIME_AT_RE.exec(raw)) !== null) {
    const h = parseInt(m[1]!, 10)
    const min = m[2] != null ? parseInt(m[2], 10) : 0
    const startMin = clockToMinutes(h, min, m[3] ?? null)
    if (startMin == null) continue
    const start = m.index
    const end = start + m[0].length
    if (occupied(start, end)) continue
    hits.push({ start, end, kind: 'time', startMin })
  }

  // "9:00 am" without at
  TIME_BARE_RE.lastIndex = 0
  while ((m = TIME_BARE_RE.exec(raw)) !== null) {
    const h = parseInt(m[1]!, 10)
    const min = parseInt(m[2]!, 10)
    const startMin = clockToMinutes(h, min, m[3]!)
    if (startMin == null) continue
    const start = m.index
    const end = start + m[0].length
    if (occupied(start, end)) continue
    hits.push({ start, end, kind: 'time', startMin })
  }

  // 24h "14:00" — only if not already covered
  TIME_24_RE.lastIndex = 0
  while ((m = TIME_24_RE.exec(raw)) !== null) {
    const h = parseInt(m[1]!, 10)
    const min = parseInt(m[2]!, 10)
    const startMin = clockToMinutes(h, min, null)
    if (startMin == null) continue
    const start = m.index
    const end = start + m[0].length
    if (occupied(start, end)) continue
    hits.push({ start, end, kind: 'time', startMin })
  }

  hits.sort((a, b) => a.start - b.start)
  return hits
}

export function parseTaskNl(raw: string): NlParseResult {
  const hits = collectHits(raw)
  const segments: NlSegment[] = []
  let cursor = 0
  for (const hit of hits) {
    if (hit.start > cursor) {
      segments.push({ text: raw.slice(cursor, hit.start) })
    }
    segments.push({ text: raw.slice(hit.start, hit.end), kind: hit.kind })
    cursor = hit.end
  }
  if (cursor < raw.length) segments.push({ text: raw.slice(cursor) })

  const timeHit = [...hits].reverse().find((h) => h.kind === 'time')
  const durHit = [...hits].reverse().find((h) => h.kind === 'duration')
  const tags = hits.filter((h) => h.kind === 'tag' && h.tag).map((h) => h.tag!)

  // Content = raw minus time/duration spans (keep tags for addTask)
  let content = raw
  const strip = hits
    .filter((h) => h.kind === 'time' || h.kind === 'duration')
    .sort((a, b) => b.start - a.start)
  for (const h of strip) {
    content = content.slice(0, h.start) + content.slice(h.end)
  }
  content = content.replace(/\s{2,}/g, ' ').trim()

  return {
    raw,
    content,
    tags,
    startMin: timeHit?.startMin ?? null,
    durationMin: durHit?.durationMin ?? null,
    segments: segments.length ? segments : [{ text: raw }],
  }
}

/** Rebuild a sentence from structured fields (edit-existing). */
export function formatTaskNl(parts: {
  title: string
  tags?: string[]
  startMin?: number | null
  durationMin?: number | null
}): string {
  const title = parts.title.trim()
  const tagPart = (parts.tags ?? [])
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`))
    .filter((t) => !title.includes(t))
    .join(' ')
  const chunks = [title, tagPart].filter(Boolean)
  if (parts.startMin != null) chunks.push(formatStartPhrase(parts.startMin))
  if (parts.durationMin != null && parts.durationMin > 0) {
    chunks.push(formatDurationPhrase(parts.durationMin))
  }
  return chunks.join(' ').replace(/\s{2,}/g, ' ').trim()
}

/** Replace the first time / duration / tag span text in `raw`. */
export function replaceNlEntity(
  raw: string,
  kind: NlEntityKind,
  nextPhrase: string
): string {
  const hits = collectHits(raw)
  const hit = kind === 'tag'
    ? hits.find((h) => h.kind === 'tag')
    : [...hits].reverse().find((h) => h.kind === kind)
  if (!hit) {
    const trimmed = raw.trimEnd()
    return trimmed ? `${trimmed} ${nextPhrase}` : nextPhrase
  }
  return (raw.slice(0, hit.start) + nextPhrase + raw.slice(hit.end)).replace(/\s{2,}/g, ' ')
}
