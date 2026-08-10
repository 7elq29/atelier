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
import { dedupeCarrySuggestions, dedupeContextLines } from '../shared/weekly-plan-dedupe'
import {
  isDailyNoteActionTask,
  isDailyNoteNoteLine,
  isWeeklyPlanInstructionLine
} from '../shared/weekly-plan-filters'

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

const LAST_WEEK_BIG_THREE_HEADING = /^Last Week'?s Big Three|^Last week Big Three/i
const WEEKLY_BIG_THREE_HEADING = /^WEEKLY BIG THREE|^Weekly Big Three/i

function extractWeeklySectionByHeadingPattern(content: string, headingPattern: RegExp): string {
  const lines = content.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^##\s+(.+?)\s*(?:<|$)/)
    if (!m) continue
    const title = m[1]!.trim()
    if (headingPattern.test(title)) {
      start = i + 1
      break
    }
  }
  if (start < 0) return ''
  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) break
    body.push(lines[i]!)
  }
  return body.join('\n')
}

/** Strip callout markers, numbering, and task checkboxes from a weekly-note line. */
function normalizeWeeklyNoteLine(raw: string): string {
  let line = raw.trim()
  if (!line || line.startsWith('%%')) return ''
  while (line.startsWith('>')) {
    line = line.replace(/^>\s*/, '').trim()
  }
  line = line.replace(/^\[!?\w+\]\s*/, '').trim()
  const numbered = line.match(/^\d+\.\s*(.+)$/)
  if (numbered) line = numbered[1]!.trim()
  line = line.replace(/^\[\s*[ xX]?\s*\]\s*/, '').trim()
  line = line.replace(/^-\s+/, '').trim()
  return line
}

function parseRetroLine(line: string): WeeklyPlanWizardData['lastBigThree'][number] | null {
  const normalized = normalizeWeeklyNoteLine(line)
  if (!normalized) return null

  const completionBracket = normalized.match(/^\[Completion:\s*(n\/a|\d+%?)\]\s*(.*)$/i)
  if (completionBracket) {
    const raw = completionBracket[1]!.toLowerCase()
    if (raw === 'n/a') return null
    const pct = String(parseInt(raw, 10) || 0)
    let text = completionBracket[2]!.trim()
    text = text.replace(/^[—–-]\s*/, '').trim()
    if (!text || isWeeklyPlanInstructionLine(text)) return null
    return { text, pct }
  }

  const pctMatch = normalized.match(/(?:—|–|-)\s*completion:\s*(n\/a|\d+%?)\s*$/i)
  if (pctMatch) {
    const text = normalized.slice(0, pctMatch.index).trim()
    if (!text || isWeeklyPlanInstructionLine(text)) return null
    const raw = pctMatch[1]!.toLowerCase()
    const pct = raw === 'n/a' ? 'n/a' : String(parseInt(raw, 10) || 0)
    return { text, pct }
  }

  if (isWeeklyPlanInstructionLine(normalized)) return null
  return { text: normalized, pct: '0' }
}

function parseWeeklyBigThreeLines(section: string): string[] {
  const lines: string[] = []
  for (const raw of section.split('\n')) {
    const text = normalizeWeeklyNoteLine(raw)
    if (!text || isWeeklyPlanInstructionLine(text)) continue
    lines.push(text)
  }
  while (lines.length < 3) lines.push('')
  return lines.slice(0, 3)
}

function extractWeeklySectionBody(content: string, heading: string): string {
  const re = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*)`, 'im')
  const m = content.match(re)
  if (!m) return ''
  const rest = m[1]!
  const nextHeading = rest.search(/^## /m)
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading)
}

function replaceSection(body: string, heading: string, content: string): string {
  const re = new RegExp(`(^## ${heading}\\s*\\n)([\\s\\S]*?)(?=^## )`, 'm')
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
  const section =
    extractWeeklySectionByHeadingPattern(content, WEEKLY_BIG_THREE_HEADING) ||
    extractWeeklySectionBody(content, 'Weekly Big Three')
  if (!section.trim()) return ['', '', '']
  return parseWeeklyBigThreeLines(section)
}

export function parseLastBigThreeRetroFromMarkdown(content: string): WeeklyPlanWizardData['lastBigThree'] {
  const section =
    extractWeeklySectionByHeadingPattern(content, LAST_WEEK_BIG_THREE_HEADING) ||
    extractWeeklySectionBody(content, 'Last week Big Three')
  if (!section.trim()) {
    return [
      { text: '', pct: '0' },
      { text: '', pct: '0' },
      { text: '', pct: '0' }
    ]
  }
  const rows: WeeklyPlanWizardData['lastBigThree'] = []
  for (const line of section.split('\n')) {
    const row = parseRetroLine(line)
    if (row) rows.push(row)
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
      const text = task.text.trim()
      if (!text) continue
      const source = `${date} daily`
      if (isDailyNoteActionTask(task)) {
        if (task.status === 'done') {
          completed.push({ text, source })
        } else if (task.status === 'open' || task.status === 'in-progress') {
          open.push({ text, source })
        }
      } else if (isDailyNoteNoteLine(task)) {
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

async function findLatestWeeklyBigThreeOutcomes(
  vaultRoot: string,
  startWeek: string
): Promise<{ isoWeek: string; outcomes: string[] } | null> {
  let week = startWeek
  for (let i = 0; i < 52; i++) {
    const path = resolveWeeklyNotePath(vaultRoot, week)
    if (existsSync(path)) {
      const content = await readFile(path, 'utf-8')
      const parsed = parseWeeklyBigThreeFromMarkdown(content)
      const outcomes = parsed.filter((t) => t.trim() && !isWeeklyPlanInstructionLine(t))
      if (outcomes.length) {
        while (outcomes.length < 3) outcomes.push('')
        return { isoWeek: week, outcomes: outcomes.slice(0, 3) }
      }
    }
    week = prevIsoWeekKey(week)
  }
  return null
}

export async function loadWeeklyPlanWizardContext(
  vaultRoot: string,
  date: string,
  vaultScan: VaultScanSettings
): Promise<WeeklyPlanWizardContext & { initialData: WeeklyPlanWizardData }> {
  const status = weeklyStatusForDate(vaultRoot, date)
  const prevPath = resolveWeeklyNotePath(vaultRoot, status.prevWeek)
  let lastWeekWeeklyBigThree: string[] = ['', '', '']
  let bigThreeSuggestionWeek = status.prevWeek
  let lastBigThree: WeeklyPlanWizardData['lastBigThree'] = [
    { text: '', pct: '0' },
    { text: '', pct: '0' },
    { text: '', pct: '0' }
  ]

  if (existsSync(prevPath)) {
    const prevContent = await readFile(prevPath, 'utf-8')
    lastWeekWeeklyBigThree = parseWeeklyBigThreeFromMarkdown(prevContent)
    lastBigThree = lastWeekWeeklyBigThree.map((text) => ({ text, pct: '0' }))
    const retro = parseLastBigThreeRetroFromMarkdown(prevContent).filter(
      (r) => !isWeeklyPlanInstructionLine(r.text)
    )
    if (retro.some((r) => r.text.trim())) lastBigThree = retro
  }

  if (!lastWeekWeeklyBigThree.some((t) => t.trim())) {
    const found = await findLatestWeeklyBigThreeOutcomes(vaultRoot, status.prevWeek)
    if (found) {
      lastWeekWeeklyBigThree = found.outcomes
      bigThreeSuggestionWeek = found.isoWeek
    }
  }

  lastBigThree = lastBigThree.filter((r) => !isWeeklyPlanInstructionLine(r.text))
  while (lastBigThree.length < 3) lastBigThree.push({ text: '', pct: '0' })
  if (lastBigThree.length > 3) lastBigThree = lastBigThree.slice(0, 3)

  const { completed, open, carry } = await scanDailyNotesInWeek(status.prevWeek, vaultScan)

  const context: WeeklyPlanWizardContext = {
    ...status,
    carrySuggestions: dedupeCarrySuggestions(carry),
    lastWeekCompleted: dedupeContextLines(completed),
    lastWeekOpen: dedupeContextLines(open),
    lastWeekWeeklyBigThree,
    bigThreeSuggestionWeek
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
