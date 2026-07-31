/**
 * Shared time-range helpers for Timeline.tsx. DAY_START_MIN/DAY_END_MIN
 * bound the window in which the "now" marker is shown (a flat list has no
 * pixel-per-minute scale to derive positioning from — see Timeline.tsx for
 * the flat-list/no-grid layout).
 */
export const DAY_START_MIN = 6 * 60 // 06:00
export const DAY_END_MIN = 23 * 60 // 23:00

export function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

export function minutesToTime(mins: number): string {
  const clamped = Math.max(0, Math.min(24 * 60 - 1, Math.round(mins)))
  const h = Math.floor(clamped / 60)
  const m = clamped % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Round to the nearest 15-minute slot. */
export function roundToSlot(mins: number, slot = 15): number {
  return Math.round(mins / slot) * slot
}

export function parseTimeBlock(timeBlock: string | undefined): { start: number; end: number } | null {
  if (!timeBlock) return null
  const [start, end] = timeBlock.split(/[–-]/)
  if (!start || !end) return null
  return { start: timeToMinutes(start), end: timeToMinutes(end) }
}
