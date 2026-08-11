/**
 * Shared time-range helpers for Timeline.tsx, which renders an
 * absolute-positioned hour grid (06:00-22:00) rather than a flat list.
 * TIMELINE_START_HOUR/TIMELINE_END_HOUR bound the displayed grid window;
 * HOUR_HEIGHT_PX/SNAP_MINUTES/LABEL_WIDTH drive the px<->minutes conversion
 * and drag-snap behavior.
 */
export const TIMELINE_START_HOUR = 6
export const TIMELINE_END_HOUR = 22
export const HOUR_HEIGHT_PX = 60
export const SNAP_MINUTES = 15
export const LABEL_WIDTH = 36

// Kept for any remaining callers expecting the display-window bounds in
// minutes (equal to TIMELINE_START_HOUR*60 / TIMELINE_END_HOUR*60).
export const DAY_START_MIN = TIMELINE_START_HOUR * 60
export const DAY_END_MIN = TIMELINE_END_HOUR * 60

/** Convert a minutes offset into a pixel offset at HOUR_HEIGHT_PX px/hour. */
export function minutesToPx(minutes: number): number {
  return (minutes / 60) * HOUR_HEIGHT_PX
}

/** Convert a pixel offset back into a minutes offset at HOUR_HEIGHT_PX px/hour. */
export function pxToMinutes(px: number): number {
  return (px / HOUR_HEIGHT_PX) * 60
}

/** Snap a minutes value to the nearest SNAP_MINUTES increment. */
export function snapMinutes(minutes: number): number {
  return Math.round(minutes / SNAP_MINUTES) * SNAP_MINUTES
}

/** Snap a minutes value to the nearest half hour (:00 or :30). */
export function snapToHalfHour(minutes: number): number {
  return Math.round(minutes / 30) * 30
}

export interface LayoutEntry {
  taskId: string
  startMin: number
  endMin: number
  column: number
  totalColumns: number
}

/**
 * Overlap-column layout (UC-10): groups mutually-overlapping items and
 * assigns each a column index + the group's total column count, so the
 * caller can render side-by-side (rather than stacked) blocks for
 * overlapping time ranges.
 */
export function computeColumns(
  items: { taskId: string; startMin: number; endMin: number }[]
): Map<string, LayoutEntry> {
  if (items.length === 0) return new Map()
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  const groups: (typeof sorted)[] = []
  let currentGroup: typeof sorted = []
  let groupEnd = -1
  for (const item of sorted) {
    if (currentGroup.length === 0 || item.startMin < groupEnd) {
      currentGroup.push(item)
      groupEnd = Math.max(groupEnd, item.endMin)
    } else {
      groups.push(currentGroup)
      currentGroup = [item]
      groupEnd = item.endMin
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup)

  const result = new Map<string, LayoutEntry>()
  for (const group of groups) {
    const columns: number[] = new Array(group.length).fill(0)
    const endTimes: number[] = []
    for (let i = 0; i < group.length; i++) {
      const item = group[i]!
      let col = 0
      while (col < endTimes.length && endTimes[col]! > item.startMin) col++
      columns[i] = col
      endTimes[col] = item.endMin
    }
    const totalCols = Math.max(...columns) + 1
    for (let i = 0; i < group.length; i++) {
      const item = group[i]!
      result.set(item.taskId, {
        taskId: item.taskId,
        startMin: item.startMin,
        endMin: item.endMin,
        column: columns[i]!,
        totalColumns: totalCols
      })
    }
  }
  return result
}

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
