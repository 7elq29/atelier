import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ipcMain } from 'electron'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { logger } from './logger'
import { getWeeklyPlanDraftStore } from './weekly-plan-draft/store'
import { applyWeeklyScheduleToDailyNotes } from './weekly-plan-daily-sync'
import {
  assertCreatePayload,
  buildWeeklyNoteMarkdown,
  formatIsoWeekDateRange,
  formatIsoWeekKey,
  loadWeeklyPlanWizardContext,
  loadWeeklyTemplate,
  mergeWeeklyPlanDraftRetro,
  resolveWeeklyNotePath,
  weeklyStatusForDate
} from './weekly-note-io'
import type { WeeklyPlanCreatePayload, WeeklyPlanDraftPayload, WeeklyPlanScheduleEntry, WeeklyPlanViewResult } from '../shared/weekly-plan-types'
import { parseWeeklyPlanWizardDataFromMarkdown } from '../shared/weekly-plan-import'
import { loadWeeklyPlanScheduleFromDailyNotes } from './weekly-plan-view-load'
import { syncWeeklyPlanScheduleToDailyNotes } from './weekly-plan-schedule-sync'

function resolveVaultRoot(): string | null {
  const envRoot = process.env.ATELIER_TEST_VAULT_ROOT ?? process.env.ATELIER_VAULT_ROOT ?? null
  if (envRoot) return envRoot
  const root = loadConfig().vault.root
  return root || null
}

function resolveDefaultDate(): string {
  if (process.env.ATELIER_TEST_DATE) return process.env.ATELIER_TEST_DATE
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function resolveVaultScan() {
  const root = resolveVaultRoot()
  if (!root) return null
  const cfg = loadConfig().vault
  return {
    root,
    dailyNotesFolder: cfg.dailyNotesFolder,
    notePathPattern: cfg.notePathPattern
  }
}

export function registerWeeklyPlanHandlers(): void {
  ipcMain.handle('weekly-plan:getStatus', () => {
    const date = resolveDefaultDate()
    return weeklyStatusForDate(resolveVaultRoot(), date)
  })

  ipcMain.handle('weekly-plan:readNote', async (_event, isoWeekArg?: string) => {
    const root = resolveVaultRoot()
    if (!root) throw new Error('no vault root configured')
    const date = resolveDefaultDate()
    const isoWeek = (typeof isoWeekArg === 'string' && isoWeekArg.trim()) || formatIsoWeekKey(date)
    const path = resolveWeeklyNotePath(root, isoWeek)
    if (!existsSync(path)) throw new Error(`weekly note not found: ${isoWeek}`)
    const markdown = await readFile(path, 'utf-8')
    const parsed = parseWeeklyPlanWizardDataFromMarkdown(markdown)
    const cfg = loadConfig().vault
    const scheduleEntries = await loadWeeklyPlanScheduleFromDailyNotes(
      isoWeek,
      parsed.bigThree,
      parsed.rejuvenation,
      {
        root,
        dailyNotesFolder: cfg.dailyNotesFolder,
        notePathPattern: cfg.notePathPattern
      }
    )
    const result: WeeklyPlanViewResult = {
      isoWeek,
      relativePath: `02.weeklynotes/${isoWeek}.md`,
      markdown,
      weekDateRange: formatIsoWeekDateRange(isoWeek),
      bigThree: parsed.bigThree.filter((t) => t.trim()),
      rejuvenation: parsed.rejuvenation.filter((t) => t.trim()),
      scheduleEntries
    }
    return result
  })

  ipcMain.handle(
    'weekly-plan:syncSchedule',
    async (_event, payload: { isoWeek: string; scheduleEntries: WeeklyPlanScheduleEntry[]; removedDailySourceKeys?: string[] }) => {
      const root = resolveVaultRoot()
      if (!root) throw new Error('no vault root configured')
      const isoWeek = payload.isoWeek?.trim()
      if (!isoWeek) throw new Error('isoWeek required')
      const cfg = loadConfig().vault
      await syncWeeklyPlanScheduleToDailyNotes(
        isoWeek,
        payload.scheduleEntries ?? [],
        {
          root,
          dailyNotesFolder: cfg.dailyNotesFolder,
          notePathPattern: cfg.notePathPattern,
          templatePath: cfg.templatePath
        },
        payload.removedDailySourceKeys ?? []
      )
      const markdown = await readFile(resolveWeeklyNotePath(root, isoWeek), 'utf-8')
      const parsed = parseWeeklyPlanWizardDataFromMarkdown(markdown)
      const scheduleEntries = await loadWeeklyPlanScheduleFromDailyNotes(
        isoWeek,
        parsed.bigThree,
        parsed.rejuvenation,
        {
          root,
          dailyNotesFolder: cfg.dailyNotesFolder,
          notePathPattern: cfg.notePathPattern
        }
      )
      return { ok: true as const, scheduleEntries }
    }
  )

  ipcMain.handle(
    'weekly-plan:writeNote',
    async (_event, payload: { isoWeek: string; markdown: string }) => {
      const root = resolveVaultRoot()
      if (!root) throw new Error('no vault root configured')
      const isoWeek = payload.isoWeek?.trim()
      if (!isoWeek) throw new Error('isoWeek required')
      const path = resolveWeeklyNotePath(root, isoWeek)
      if (!existsSync(path)) throw new Error(`weekly note not found: ${isoWeek}`)
      mkdirSync(dirname(path), { recursive: true })
      const tmp = `${path}.tmp`
      await writeFile(tmp, payload.markdown, 'utf-8')
      renameSync(tmp, path)
      return { ok: true as const }
    }
  )

  ipcMain.handle('weekly-plan:loadContext', async () => {
    const scan = resolveVaultScan()
    if (!scan) throw new Error('no vault root configured')
    const date = resolveDefaultDate()
    const ctx = await loadWeeklyPlanWizardContext(scan.root, date, scan)
    const draft = getWeeklyPlanDraftStore(openDatabase()).get(ctx.isoWeek)
    if (draft) {
      return {
        ...ctx,
        initialData: {
          ...draft.data,
          lastBigThree: mergeWeeklyPlanDraftRetro(draft.data, ctx.initialData.lastBigThree)
        },
        draftStep: draft.step
      }
    }
    return { ...ctx, draftStep: 0 }
  })

  ipcMain.handle('weekly-plan:saveDraft', (_event, payload: WeeklyPlanDraftPayload) => {
    if (!payload?.isoWeek || typeof payload.step !== 'number' || !payload.data) {
      throw new Error('invalid weekly plan draft payload')
    }
    getWeeklyPlanDraftStore(openDatabase()).save(payload.isoWeek, payload.step, payload.data)
    return { ok: true }
  })

  ipcMain.handle('weekly-plan:clearDraft', (_event, isoWeek: string) => {
    if (!isoWeek) throw new Error('isoWeek required')
    getWeeklyPlanDraftStore(openDatabase()).clear(isoWeek)
    return { ok: true }
  })

  ipcMain.handle(
    'weekly-plan:importDraftFromFile',
    async (_event, payload: { filePath: string; isoWeek?: string; step?: number }) => {
      if (!payload?.filePath?.trim()) throw new Error('filePath required')
      const scan = resolveVaultScan()
      if (!scan) throw new Error('no vault root configured')
      const { readFile } = await import('node:fs/promises')
      const content = await readFile(payload.filePath, 'utf-8')
      const data = parseWeeklyPlanWizardDataFromMarkdown(content)
      const date = resolveDefaultDate()
      const isoWeek = payload.isoWeek?.trim() || formatIsoWeekKey(date)
      const step = typeof payload.step === 'number' ? payload.step : 0
      getWeeklyPlanDraftStore(openDatabase()).save(isoWeek, step, data)
      logger.info('weekly-plan draft imported from file', { filePath: payload.filePath, isoWeek, step })
      return { ok: true as const, isoWeek, step }
    }
  )

  ipcMain.handle('weekly-plan:create', async (_event, payload: WeeklyPlanCreatePayload) => {
    assertCreatePayload(payload)
    const scan = resolveVaultScan()
    if (!scan) throw new Error('no vault root configured')
    const path = resolveWeeklyNotePath(scan.root, payload.isoWeek)
    const template = await loadWeeklyTemplate(scan.root)
    const markdown = buildWeeklyNoteMarkdown(template, payload.isoWeek, payload.data)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, markdown, 'utf-8')
    const cfg = loadConfig().vault
    await applyWeeklyScheduleToDailyNotes(payload.isoWeek, payload.data.scheduleEntries, {
      root: scan.root,
      dailyNotesFolder: cfg.dailyNotesFolder,
      notePathPattern: cfg.notePathPattern,
      templatePath: cfg.templatePath
    })
    getWeeklyPlanDraftStore(openDatabase()).clear(payload.isoWeek)
    logger.info('weekly-plan created', { path, isoWeek: payload.isoWeek })
    return { path, relativePath: `02.weeklynotes/${payload.isoWeek}.md` }
  })
}
