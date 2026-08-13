/**
 * Writes weekly-plan schedule placements into vault daily notes (create note from template if missing).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DailyNote, DailyTask } from '../shared/daily-note-types'
import type { WeeklyPlanScheduleEntry } from '../shared/weekly-plan-types'
import {
  generateNewNote,
  getTaskIds,
  mintTaskId,
  parseDailyNote,
  resolveNotePath,
  serializeDailyNote
} from './daily-note-io'
import { datesInIsoWeek } from './weekly-note-io'
import { logger } from './logger'

const WP_WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

const DAILY_TEMPLATE_REL = '92.templates/Daily Note Template.md'

export type WeeklyPlanDailySyncSettings = {
  root: string
  dailyNotesFolder: string
  notePathPattern: string
  templatePath?: string
}

function loadDailyTemplate(vaultRoot: string, templatePath: string): string | null {
  const fullPath = `${vaultRoot}/${templatePath}`
  if (!existsSync(fullPath)) return null
  return readFileSync(fullPath, 'utf-8')
}

function dayAbbrevToDate(isoWeek: string, day: string): string | null {
  const idx = WP_WEEK_DAYS.indexOf(day as (typeof WP_WEEK_DAYS)[number])
  if (idx < 0) return null
  return datesInIsoWeek(isoWeek)[idx] ?? null
}

function scheduleEntryTargetsDaily(entry: WeeklyPlanScheduleEntry): boolean {
  return Boolean(entry.text.trim() && String(entry.day).trim())
}

function taskDedupeKey(task: DailyTask): string {
  const slot = task.timeBlock ?? ''
  return `${task.scheduled ?? ''}|${slot}|${task.text.trim().toLowerCase()}`
}

function entryToDailyTask(text: string, date: string, slot: string): DailyTask {
  const gid = mintTaskId()
  const timeBlock = slot.trim() ? slot.replace(/\s+/g, '') : undefined
  return {
    id: gid,
    gid,
    text: text.trim(),
    status: 'open',
    section: timeBlock ? 'day-plan' : 'unscheduled',
    tags: [],
    scheduled: date,
    timeBlock,
    externalLinks: [],
    isTracker: false,
    isNote: false
  }
}

async function ensureDailyNote(
  date: string,
  settings: WeeklyPlanDailySyncSettings
): Promise<{ note: DailyNote; raw: ReturnType<typeof parseDailyNote>['raw']; path: string }> {
  const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
  if (existsSync(path)) {
    const content = await readFile(path, 'utf-8')
    const parsed = parseDailyNote(content, date)
    return { note: parsed.note, raw: parsed.raw, path }
  }

  const templatePath = settings.templatePath ?? DAILY_TEMPLATE_REL
  const template = loadDailyTemplate(settings.root, templatePath)
  const content = generateNewNote(date, [], template)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  const parsed = parseDailyNote(content, date)
  logger.info('weekly-plan daily sync: created daily note', { path, date })
  return { note: parsed.note, raw: parsed.raw, path }
}

function writeDailyNote(path: string, note: DailyNote, raw: ReturnType<typeof parseDailyNote>['raw']): void {
  const serialized = serializeDailyNote(note, raw)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, serialized, 'utf-8')
  renameSync(tmp, path)
}

/** Apply wizard schedule rows with a day set to the matching ISO-week daily notes. */
export async function applyWeeklyScheduleToDailyNotes(
  isoWeek: string,
  entries: WeeklyPlanScheduleEntry[],
  settings: WeeklyPlanDailySyncSettings
): Promise<{ datesUpdated: string[] }> {
  const byDate = new Map<string, WeeklyPlanScheduleEntry[]>()
  for (const entry of entries) {
    if (!scheduleEntryTargetsDaily(entry)) continue
    const date = dayAbbrevToDate(isoWeek, entry.day)
    if (!date) continue
    const list = byDate.get(date) ?? []
    list.push(entry)
    byDate.set(date, list)
  }

  const datesUpdated: string[] = []

  for (const [date, dayEntries] of byDate) {
    const { note, raw, path } = await ensureDailyNote(date, settings)
    const existing = new Set(note.tasks.map(taskDedupeKey))
    const toAdd: DailyTask[] = []

    for (const entry of dayEntries) {
      const candidate = entryToDailyTask(entry.text, date, entry.slot)
      const key = taskDedupeKey(candidate)
      if (existing.has(key)) continue
      existing.add(key)
      toAdd.push(candidate)
    }

    if (!toAdd.length) continue

    const updated: DailyNote = { ...note, tasks: [...note.tasks, ...toAdd] }
    writeDailyNote(path, updated, raw)
    getTaskIds(updated)
    datesUpdated.push(date)
    logger.info('weekly-plan daily sync: appended scheduled tasks', {
      path,
      date,
      count: toAdd.length,
      taskIds: toAdd.map((t) => t.id)
    })
  }

  return { datesUpdated }
}
