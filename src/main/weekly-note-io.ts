/**
 * weekly-note-io.ts — Vault paths and markdown assembly for the weekly plan wizard.
 * Disk I/O is performed by weekly-notes-handlers.ts.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getISOWeek, getISOWeekYear, parseDailyNote, resolveNotePath } from './daily-note-io'
import type {
  WeeklyPlanCarrySuggestion,
  WeeklyPlanContextLine,
  WeeklyPlanCreatePayload,
  WeeklyPlanScheduleEntry,
  WeeklyPlanStatus,
  WeeklyPlanWizardContext,
  WeeklyPlanWizardData
} from '../shared/weekly-plan-types'

export const WEEKLY_NOTES_FOLDER = '02.weeklynotes'
export const WEEKLY_TEMPLATE_REL = '92.templates/Weekly Notes Template.md'

const DEFAULT_WEEKLY_TEMPLATE = `---
week: {{date:gggg-[W]WW}}
type: weekly
---

## AFTER ACTION REVIEW

## Last week Big Three

## Reflection

## REJUVENATION

## Ideas

## Weekly Big Three

## Q2 Blocks
`

export function formatIsoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, '0')}`
}

export function parseIsoWeekKey(key: string): { year: number; week: number } {
  const m = key.match(/^(\d{4})-W(\d{2})$/)
  if (!m) throw new Error(`invalid iso week key: ${key}`)
  return { year: parseInt(m[1]!, 10), week: parseInt(m[2]!, 10) }
}

/** Monday 00:00 local for the given ISO week. */
export function mondayOfIsoWeek(year: number, week: number): Date {
  const jan4 = new Date(year, 0, 4)
  const dayOfWeek = jan4.getDay() || 7
  const mondayWeek1 = new Date(jan4)
  mondayWeek1.setDate(jan4.getDate() - dayOfWeek + 1)
  const monday = new Date(mondayWeek1)
  monday.setDate(mondayWeek1.getDate() + (week - 1) * 7)
  monday.setHours(0, 0, 0, 0)
  return monday
}

export function dateKeyFromLocal(d: Date): string {
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function datesInIsoWeek(isoWeek: string): string[] {
  const { year, week } = parseIsoWeekKey(isoWeek)
  const monday = mondayOfIsoWeek(year, week)
  const out: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    out.push(dateKeyFromLocal(d))
  }
  return out
}

export function prevIsoWeekKey(isoWeek: string): string {
  const { year, week } = parseIsoWeekKey(isoWeek)
  const monday = mondayOfIsoWeek(year, week)
  monday.setDate(monday.getDate() - 7)
  return formatIsoWeekKey(dateKeyFromLocal(monday))
}

export function resolveWeeklyNotePath(vaultRoot: string, isoWeek: string): string {
  return join(vaultRoot, WEEKLY_NOTES_FOLDER, `${isoWeek}.md`)
}

export function weeklyStatusForDate(vaultRoot: string | null, date: string): WeeklyPlanStatus {
  const isoWeek = formatIsoWeekKey(date)
  const relativePath = `${WEEKLY_NOTES_FOLDER}/${isoWeek}.md`
  const fileExists = vaultRoot ? existsSync(resolveWeeklyNotePath(vaultRoot, isoWeek)) : false
  return {
    isoWeek,
    prevWeek: prevIsoWeekKey(isoWeek),
    relativePath,
    fileExists
  }
}

function fillWeeklyTemplateTokens(template: string, isoWeek: string): string {
  const { year, week } = parseIsoWeekKey(isoWeek)
  const monday = mondayOfIsoWeek(year, week)
  const date = dateKeyFromLocal(monday)
  return template
    .replace(/\{\{date:gggg-\[W\]WW\}\}/g, isoWeek)
    .replace(/\{\{date:gggg\}\}/g, String(year))
    .replace(/\{\{date:\[W\]WW\}\}/g, String(week).padStart(2, '0'))
    .replace(/\{\{date:YYYY-MM-DD\}\}/g, date)
}

export async function loadWeeklyTemplate(vaultRoot: string): Promise<string> {
  const path = join(vaultRoot, WEEKLY_TEMPLATE_REL)
  if (!existsSync(path)) return DEFAULT_WEEKLY_TEMPLATE
  return readFile(path, 'utf-8')
}

function replaceSection(body: string, heading: string, content: string): string {
  const re = new RegExp(`(^## ${heading}\\s*\\n)([\\s\\S]*?)(?=^## |\\Z)`, 'm')
  if (re.test(body)) {
    return body.replace(re, `$1${content}\n`)
  }
  return `${body.trim()}\n\n## ${heading}\n${content}\n`
}

function bulletLines(lines: string[]): string {
  const trimmed = lines.map((l) => l.trim()).filter(Boolean)
  if (!trimmed.length) return '- \n'
  return trimmed.map((l) => `- ${l}`).join('\n') + '\n'
}

function formatLastBigThreeRetro(rows: WeeklyPlanWizardData['lastBigThree']): string {
  if (!rows.length) return '- \n'
  return (
    rows
      .map((r, i) => {
        const text = r.text.trim() || `Big Three #${i + 1}`
        const pct = String(r.pct).trim().toLowerCase() === 'n/a' ? 'n/a' : `${parseInt(r.pct, 10) || 0}%`
        return `- ${text} — completion: ${pct}`
      })
      .join('\n') + '\n'
  )
}

function formatScheduledBlocks(entries: WeeklyPlanScheduleEntry[]): { all: string; q2: string } {
  const timed = entries.filter((e) => e.day.trim() && e.slot.trim())
  timed.sort((a, b) => a.day.localeCompare(b.day) || a.slot.localeCompare(b.slot))
  const allLines: string[] = []
  const q2Lines: string[] = []
  for (const e of timed) {
    const line = `- [ ] ${e.slot} ${e.text.trim()}`
    allLines.push(line)
    if (/#q2/i.test(e.text)) q2Lines.push(line)
  }
  return {
    all: allLines.length ? allLines.join('\n') + '\n' : '- \n',
    q2: q2Lines.length ? q2Lines.join('\n') + '\n' : '- \n'
  }
}

export function buildWeeklyNoteMarkdown(template: string, isoWeek: string, data: WeeklyPlanWizardData): string {
  let body = fillWeeklyTemplateTokens(template, isoWeek)
  body = replaceSection(body, 'AFTER ACTION REVIEW', bulletLines(data.wins))
  body = replaceSection(body, 'Last week Big Three', formatLastBigThreeRetro(data.lastBigThree))
  body = replaceSection(body, 'Reflection', data.retroReflect.trim() ? `${data.retroReflect.trim()}\n` : '- \n')
  body = replaceSection(body, 'REJUVENATION', bulletLines(data.rejuvenation))
  body = replaceSection(body, 'Ideas', bulletLines(data.ideas))
  body = replaceSection(body, 'Weekly Big Three', bulletLines(data.bigThree))
  const sched = formatScheduledBlocks(data.scheduleEntries)
  body = replaceSection(body, 'Q2 Blocks', sched.q2)
  if (sched.all.trim() !== '-') {
    body = replaceSection(body, 'Schedule', sched.all)
  }
  return body.endsWith('\n') ? body : `${body}\n`
}

export function parseWeeklyBigThreeFromMarkdown(content: string): string[] {
  const m = content.match(/^## Weekly Big Three\s*\n([\s\S]*?)(?=^## |\Z)/im)
  if (!m) return ['', '', '']
  const lines = m[1]!
    .split('\n')
    .map((l) => l.replace(/^-\s+/, '').trim())
    .filter(Boolean)
  while (lines.length < 3) lines.push('')
  return lines.slice(0, 3)
}

export function parseLastBigThreeRetroFromMarkdown(content: string): WeeklyPlanWizardData['lastBigThree'] {
  const m = content.match(/^## Last week Big Three\s*\n([\s\S]*?)(?=^## |\Z)/im)
  if (!m) {
    return [
      { text: '', pct: '0' },
      { text: '', pct: '0' },
      { text: '', pct: '0' }
    ]
  }
  const rows: WeeklyPlanWizardData['lastBigThree'] = []
  for (const line of m[1]!.split('\n')) {
    const trimmed = line.replace(/^-\s+/, '').trim()
    if (!trimmed) continue
    const pctMatch = trimmed.match(/—\s*completion:\s*(n\/a|\d+%?)\s*$/i)
    if (pctMatch) {
      const text = trimmed.slice(0, pctMatch.index).trim()
      const raw = pctMatch[1]!.toLowerCase()
      const pct = raw === 'n/a' ? 'n/a' : String(parseInt(raw, 10) || 0)
      rows.push({ text, pct })
    } else {
      rows.push({ text: trimmed, pct: '0' })
    }
  }
  while (rows.length < 3) rows.push({ text: '', pct: '0' })
  return rows.slice(0, 3)
}

type VaultScanSettings = {
  root: string
  dailyNotesFolder: string
  notePathPattern: string
}

async function scanDailyNotesInWeek(
  isoWeek: string,
  settings: VaultScanSettings
): Promise<{ completed: WeeklyPlanContextLine[]; open: WeeklyPlanContextLine[]; carry: WeeklyPlanCarrySuggestion[] }> {
  const completed: WeeklyPlanContextLine[] = []
  const open: WeeklyPlanContextLine[] = []
  const carry: WeeklyPlanCarrySuggestion[] = []
  let carryIdx = 0

  for (const date of datesInIsoWeek(isoWeek)) {
    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
    if (!existsSync(path)) continue
    const content = await readFile(path, 'utf-8')
    const { note } = parseDailyNote(content, date)
    for (const task of note.tasks) {
      if (task.isNote || task.section === 'tracker') continue
      const text = task.text.trim()
      if (!text) continue
      const source = `${date} daily`
      if (task.status === 'done') {
        completed.push({ text, source })
      } else if (task.status === 'open' || task.status === 'in-progress') {
        open.push({ text, source })
        carry.push({
          id: `carry_${carryIdx++}`,
          text,
          source
        })
      }
    }
  }

  return { completed, open, carry }
}

export async function loadWeeklyPlanWizardContext(
  vaultRoot: string,
  date: string,
  vaultScan: VaultScanSettings
): Promise<WeeklyPlanWizardContext & { initialData: WeeklyPlanWizardData }> {
  const status = weeklyStatusForDate(vaultRoot, date)
  const prevPath = resolveWeeklyNotePath(vaultRoot, status.prevWeek)
  let lastBigThree: WeeklyPlanWizardData['lastBigThree'] = [
    { text: '', pct: '0' },
    { text: '', pct: '0' },
    { text: '', pct: '0' }
  ]

  if (existsSync(prevPath)) {
    const prevContent = await readFile(prevPath, 'utf-8')
    const prevThree = parseWeeklyBigThreeFromMarkdown(prevContent)
    lastBigThree = prevThree.map((text) => ({ text, pct: '0' }))
    const retro = parseLastBigThreeRetroFromMarkdown(prevContent)
    if (retro.some((r) => r.text.trim())) lastBigThree = retro
  }

  const { completed, open, carry } = await scanDailyNotesInWeek(status.prevWeek, vaultScan)

  const context: WeeklyPlanWizardContext = {
    ...status,
    carrySuggestions: carry,
    lastWeekCompleted: completed,
    lastWeekOpen: open
  }

  return {
    ...context,
    initialData: defaultWizardData(lastBigThree)
  }
}

export function defaultWizardData(lastBigThree: WeeklyPlanWizardData['lastBigThree']): WeeklyPlanWizardData {
  return {
    wins: ['', '', ''],
    lastBigThree,
    retroReflect: '',
    rejuvenation: ['', '', ''],
    ideas: ['', '', '', '', '', ''],
    bigThree: ['', '', ''],
    scheduleEntries: []
  }
}

export function assertCreatePayload(payload: WeeklyPlanCreatePayload): void {
  if (!payload.isoWeek.match(/^\d{4}-W\d{2}$/)) {
    throw new Error('invalid isoWeek')
  }
}
