/**
 * Sync weekly plan view schedule edits back to vault daily notes.
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
import type { WeeklyPlanDailySyncSettings } from './weekly-plan-daily-sync'

const WP_WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const DAILY_TEMPLATE_REL = '92.templates/Daily Note Template.md'

function dayAbbrevToDate(isoWeek: string, day: string): string | null {
  const idx = WP_WEEK_DAYS.indexOf(day as (typeof WP_WEEK_DAYS)[number])
  if (idx < 0) return null
  return datesInIsoWeek(isoWeek)[idx] ?? null
}

function loadDailyTemplate(vaultRoot: string, templatePath: string): string | null {
  const fullPath = `${vaultRoot}/${templatePath}`
  if (!existsSync(fullPath)) return null
  return readFileSync(fullPath, 'utf-8')
}

function parseDailySourceKey(sourceKey: string): { date: string; taskId: string } | null {
  const m = sourceKey.match(/^daily_(\d{4}-\d{2}-\d{2})_(.+)$/)
  if (!m) return null
  return { date: m[1]!, taskId: m[2]! }
}

function writeDailyNote(path: string, note: DailyNote, raw: ReturnType<typeof parseDailyNote>['raw']): void {
  const serialized = serializeDailyNote(note, raw)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, serialized, 'utf-8')
  renameSync(tmp, path)
}

async function loadDailyNote(
  date: string,
  settings: WeeklyPlanDailySyncSettings
): Promise<{ note: DailyNote; raw: ReturnType<typeof parseDailyNote>['raw']; path: string } | null> {
  const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
  if (!existsSync(path)) return null
  const content = await readFile(path, 'utf-8')
  const parsed = parseDailyNote(content, date)
  return { note: parsed.note, raw: parsed.raw, path }
}

async function ensureDailyNote(
  date: string,
  settings: WeeklyPlanDailySyncSettings
): Promise<{ note: DailyNote; raw: ReturnType<typeof parseDailyNote>['raw']; path: string }> {
  const existing = await loadDailyNote(date, settings)
  if (existing) return existing

  const templatePath = settings.templatePath ?? DAILY_TEMPLATE_REL
  const template = loadDailyTemplate(settings.root, templatePath)
  const content = generateNewNote(date, [], template)
  const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  const parsed = parseDailyNote(content, date)
  return { note: parsed.note, raw: parsed.raw, path }
}

function placementTask(task: DailyTask, targetDate: string, slot: string): DailyTask {
  const timeBlock = slot.trim() ? slot.replace(/\s+/g, '') : undefined
  return {
    ...task,
    text: task.text.trim(),
    scheduled: targetDate,
    timeBlock,
    section: timeBlock ? 'day-plan' : 'unscheduled'
  }
}

function newTaskFromEntry(entry: WeeklyPlanScheduleEntry, targetDate: string): DailyTask {
  const gid = mintTaskId()
  return placementTask(
    {
      id: gid,
      gid,
      text: entry.text.trim(),
      status: 'open',
      section: 'unscheduled',
      tags: [],
      externalLinks: [],
      isTracker: false,
      isNote: entry.isNote ?? false
    },
    targetDate,
    entry.slot
  )
}

type NoteBundle = { note: DailyNote; raw: ReturnType<typeof parseDailyNote>['raw']; path: string; dirty: boolean }

/** Apply view-schedule drag/edit/remove to existing daily-note tasks (and append new ones). */
export async function syncWeeklyPlanScheduleToDailyNotes(
  isoWeek: string,
  entries: WeeklyPlanScheduleEntry[],
  settings: WeeklyPlanDailySyncSettings,
  removedDailySourceKeys: string[] = []
): Promise<{ datesUpdated: string[] }> {
  const weekDates = datesInIsoWeek(isoWeek)
  const bundles = new Map<string, NoteBundle>()

  for (const date of weekDates) {
    const loaded = await loadDailyNote(date, settings)
    if (loaded) {
      bundles.set(date, { ...loaded, dirty: false })
    }
  }

  const findTaskInWeek = (taskId: string): { date: string; bundle: NoteBundle; task: DailyTask } | null => {
    for (const date of weekDates) {
      const bundle = bundles.get(date)
      if (!bundle) continue
      const task = bundle.note.tasks.find((t) => t.id === taskId)
      if (task) return { date, bundle, task }
    }
    return null
  }

  const removeTaskFromBundle = (bundle: NoteBundle, taskId: string): void => {
    const next = bundle.note.tasks.filter((t) => t.id !== taskId)
    if (next.length !== bundle.note.tasks.length) {
      bundle.note = { ...bundle.note, tasks: next }
      bundle.dirty = true
    }
  }

  const addTaskToBundle = (date: string, task: DailyTask, bundle: NoteBundle): void => {
    bundle.note = { ...bundle.note, tasks: [...bundle.note.tasks, task] }
    bundle.dirty = true
  }

  const datesUpdated = new Set<string>()

  for (const sourceKey of removedDailySourceKeys) {
    const dailyRef = parseDailySourceKey(sourceKey)
    if (!dailyRef) continue
    const located = findTaskInWeek(dailyRef.taskId)
    if (!located) continue
    removeTaskFromBundle(located.bundle, dailyRef.taskId)
    datesUpdated.add(located.date)
  }

  const pendingNewByDate = new Map<string, DailyTask[]>()

  for (const entry of entries) {
    const text = entry.text.trim()
    if (!text) continue

    const dailyRef = parseDailySourceKey(entry.sourceKey)
    const targetDate = entry.day.trim() ? dayAbbrevToDate(isoWeek, entry.day) : null

    if (dailyRef) {
      const located = findTaskInWeek(dailyRef.taskId)
      if (!located?.task) continue

      if (!targetDate) {
        removeTaskFromBundle(located.bundle, dailyRef.taskId)
        datesUpdated.add(located.date)
        continue
      }

      const updated = placementTask({ ...located.task, text }, targetDate, entry.slot)
      removeTaskFromBundle(located.bundle, dailyRef.taskId)
      if (located.bundle.dirty) datesUpdated.add(located.date)

      let targetBundle = bundles.get(targetDate)
      if (!targetBundle) {
        const ensured = await ensureDailyNote(targetDate, settings)
        targetBundle = { ...ensured, dirty: false }
        bundles.set(targetDate, targetBundle)
      }
      addTaskToBundle(targetDate, updated, targetBundle)
      datesUpdated.add(targetDate)
      continue
    }

    if (!targetDate) continue

    const task = newTaskFromEntry(entry, targetDate)
    const list = pendingNewByDate.get(targetDate) ?? []
    list.push(task)
    pendingNewByDate.set(targetDate, list)
    datesUpdated.add(targetDate)
  }

  for (const [date, tasks] of pendingNewByDate) {
    let bundle = bundles.get(date)
    if (!bundle) {
      const ensured = await ensureDailyNote(date, settings)
      bundle = { ...ensured, dirty: false }
      bundles.set(date, bundle)
    }
    for (const task of tasks) {
      addTaskToBundle(date, task, bundle)
    }
  }

  for (const date of datesUpdated) {
    const bundle = bundles.get(date)
    if (!bundle?.dirty) continue
    writeDailyNote(bundle.path, bundle.note, bundle.raw)
    getTaskIds(bundle.note)
    logger.info('weekly-plan view sync: wrote daily note', { path: bundle.path, date })
  }

  return { datesUpdated: [...datesUpdated] }
}
