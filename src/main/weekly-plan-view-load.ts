/**
 * Load weekly plan schedule placements from ISO-week daily notes (wizard sync target).
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseDailyNote, resolveNotePath } from './daily-note-io'
import { datesInIsoWeek } from './weekly-note-io'
import type { WeeklyPlanScheduleEntry, WeeklyPlanScheduleKind } from '../shared/weekly-plan-types'
import { isDailyNoteScheduleItem } from '../shared/weekly-plan-filters'

const WP_WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export type WeeklyPlanDailyLoadSettings = {
  root: string
  dailyNotesFolder: string
  notePathPattern: string
}

function dateToDayAbbrev(isoWeek: string, date: string): string | null {
  const dates = datesInIsoWeek(isoWeek)
  const idx = dates.indexOf(date)
  if (idx < 0) return null
  return WP_WEEK_DAYS[idx] ?? null
}

function normalizeMatchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+\(\d+\)$/, '')
    .trim()
}

function inferScheduleKind(
  text: string,
  bigThree: string[],
  rejuvenation: string[]
): WeeklyPlanScheduleKind {
  const norm = normalizeMatchText(text)
  for (const item of bigThree) {
    const base = normalizeMatchText(item)
    if (!base) continue
    if (norm === base || norm.includes(base) || base.includes(norm)) return 'Big Three'
  }
  for (const item of rejuvenation) {
    const base = normalizeMatchText(item)
    if (!base) continue
    if (norm === base || norm.includes(base) || base.includes(norm)) return 'Rejuvenation'
  }
  return 'Idea'
}

export async function loadWeeklyPlanScheduleFromDailyNotes(
  isoWeek: string,
  bigThree: string[],
  rejuvenation: string[],
  settings: WeeklyPlanDailyLoadSettings
): Promise<WeeklyPlanScheduleEntry[]> {
  const entries: WeeklyPlanScheduleEntry[] = []

  for (const date of datesInIsoWeek(isoWeek)) {
    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
    if (!existsSync(path)) continue
    const content = await readFile(path, 'utf-8')
    const { note } = parseDailyNote(content, date)
    const day = dateToDayAbbrev(isoWeek, date)
    if (!day) continue

    for (const task of note.tasks) {
      if (!isDailyNoteScheduleItem(task)) continue
      const text = task.text.trim()
      if (!text) continue

      // Match daily sidebar: tasks render on the day of the note file they
      // live in, regardless of [scheduled::] metadata.
      const timeBlock = task.timeBlock?.trim() ?? ''
      entries.push({
        id: `view_${task.id}`,
        sourceKey: `daily_${date}_${task.id}`,
        text,
        kind: inferScheduleKind(text, bigThree, rejuvenation),
        day,
        slot: timeBlock,
        status: task.isNote ? undefined : task.status,
        isNote: task.isNote || undefined
      })
    }
  }

  return entries
}
