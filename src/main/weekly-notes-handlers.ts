import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ipcMain } from 'electron'
import { loadConfig } from './config'
import { logger } from './logger'
import {
  assertCreatePayload,
  buildWeeklyNoteMarkdown,
  loadWeeklyPlanWizardContext,
  loadWeeklyTemplate,
  resolveWeeklyNotePath,
  weeklyStatusForDate
} from './weekly-note-io'
import type { WeeklyPlanCreatePayload } from '../shared/weekly-plan-types'

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
    const root = resolveVaultRoot()
    if (!root) return null
    const date = resolveDefaultDate()
    return weeklyStatusForDate(root, date)
  })

  ipcMain.handle('weekly-plan:loadContext', async () => {
    const scan = resolveVaultScan()
    if (!scan) throw new Error('no vault root configured')
    const date = resolveDefaultDate()
    return loadWeeklyPlanWizardContext(scan.root, date, scan)
  })

  ipcMain.handle('weekly-plan:create', async (_event, payload: WeeklyPlanCreatePayload) => {
    assertCreatePayload(payload)
    const scan = resolveVaultScan()
    if (!scan) throw new Error('no vault root configured')
    const path = resolveWeeklyNotePath(scan.root, payload.isoWeek)
    const template = await loadWeeklyTemplate(scan.root)
    const markdown = buildWeeklyNoteMarkdown(template, payload.isoWeek, payload.data)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, markdown, 'utf-8')
    logger.info('weekly-plan created', { path, isoWeek: payload.isoWeek })
    return { path, relativePath: `02.weeklynotes/${payload.isoWeek}.md` }
  })
}
