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

# Retro

---

## Review Projects

First review the projects under *03.projects* and *04.goals*.

%% Altitude check (Get Current): also scan the current Linear cycle. Confirm each Weekly Big Three ladders UP to a goal (03.projects / 04.goals / Linear initiative). No orphan goals, no orphan busywork. %%

## AFTER ACTION REVIEW

*List 3–5 of your biggest wins from the week.*

1. 
2. 
3. 

## Last Week's Big Three

1. [Completion: %] 
2. [Completion: %] 
3. [Completion: %] 

## What worked? What didn't? Why? How would you change?

> *(write something)*

# Plan

---

## REJUVENATION

*Three non-work resets for the week.*

1. 
2. 
3. 

## Ideas

- 
- 
- 
- 
- 
- 

## WEEKLY BIG THREE

%% At least ONE must be a #q2 (Important-not-urgent) item. Each should ladder to a goal/initiative. %%

1. [ ] 
2. [ ] 
3. [ ] 
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

/** Human-readable Mon–Sun range for an ISO week, e.g. "Jul 28 – Aug 3, 2026". */
export function formatIsoWeekDateRange(isoWeek: string): string {
  const dates = datesInIsoWeek(isoWeek)
  if (!dates.length) return isoWeek
  const startKey = dates[0]!
  const endKey = dates[dates.length - 1]!
  const start = new Date(`${startKey}T00:00:00`)
  const end = new Date(`${endKey}T00:00:00`)
  const monthDay = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const endWithYear = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${monthDay(start)} – ${end.getDate()}, ${end.getFullYear()}`
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${monthDay(start)} – ${endWithYear}`
  }
  const startWithYear = start.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  return `${startWithYear} – ${endWithYear}`
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
    weekDateRange: formatIsoWeekDateRange(isoWeek),
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

function sectionRange(lines: string[], headingPattern: RegExp): [number, number] | null {
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^##\s+(.+?)\s*(?:<|$)/)
    if (!m) continue
    if (headingPattern.test(m[1]!.trim())) {
      start = i + 1
      break
    }
  }
  if (start < 0) return null
  let end = lines.length
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i
      break
    }
  }
  return [start, end]
}

function usesObsidianCalloutWeeklyTemplate(template: string): boolean {
  return /> \[!letter\]/i.test(template) || /> \[!multi-column\]/i.test(template)
}

function usesStandardWeeklyTemplate(template: string): boolean {
  return /^#\s+Retro/m.test(template) && !usesObsidianCalloutWeeklyTemplate(template)
}

const AFTER_ACTION_HEADING = /^AFTER ACTION REVIEW/i
const LAST_WEEK_B3_HEADING = /^Last Week'?s Big Three|^Last week Big Three/i
const REFLECTION_HEADING = /^What worked|^Reflection/i
const REJUVENATION_HEADING = /^REJUVENATION/i
const IDEAS_HEADING = /^Ideas/i

function fillLetterNumberedLines(
  lines: string[],
  start: number,
  end: number,
  values: string[],
  maxSlot: number,
  formatLine: (slot: number, text: string) => string
): void {
  for (let i = start; i < end; i++) {
    const m = lines[i]!.match(/^>\s*(\d+)\.\s*(.*)$/)
    if (!m) continue
    const slot = parseInt(m[1]!, 10)
    if (slot < 1 || slot > maxSlot) continue
    const text = values[slot - 1]?.trim() ?? ''
    lines[i] = formatLine(slot, text)
  }
}

function fillPlainNumberedLines(
  lines: string[],
  start: number,
  end: number,
  values: string[],
  maxSlot: number,
  formatLine: (slot: number, text: string) => string
): void {
  for (let i = start; i < end; i++) {
    const m = lines[i]!.match(/^(\d+)\.\s*(.*)$/)
    if (!m) continue
    const slot = parseInt(m[1]!, 10)
    if (slot < 1 || slot > maxSlot) continue
    const text = values[slot - 1]?.trim() ?? ''
    lines[i] = formatLine(slot, text)
  }
}

function fillLastWeekBigThreeLines(
  lines: string[],
  start: number,
  end: number,
  rows: WeeklyPlanWizardData['lastBigThree']
): void {
  fillLetterNumberedLines(lines, start, end, rows.map((r) => r.text), 3, (slot, text) => {
    const row = rows[slot - 1]!
    const pctRaw = String(row.pct).trim().toLowerCase()
    const pct = pctRaw === 'n/a' ? 'n/a' : `${parseInt(row.pct, 10) || 0}%`
    const body = text.trim()
    if (!body) return `> ${slot}. [Completion: ${pct}]`
    return `> ${slot}. [Completion: ${pct}] ${body}`
  })
}

function fillReflectionCallout(lines: string[], start: number, end: number, reflect: string): void {
  const trimmed = reflect.trim()
  for (let i = start; i < end; i++) {
    if (!lines[i]!.startsWith('>')) continue
    if (/^>\s*\[!/.test(lines[i]!)) continue
    if (!/\(write something\)/i.test(lines[i]!) && !trimmed) continue
    if (!trimmed) {
      lines[i] = '> (write something)'
      return
    }
    const parts = trimmed.split('\n')
    lines[i] = `> ${parts[0]}`
    if (parts.length > 1) {
      lines.splice(i + 1, 0, ...parts.slice(1).map((p) => `> ${p}`))
    }
    return
  }
}

function fillRejuvenationLines(lines: string[], start: number, end: number, values: string[]): void {
  let idx = 0
  for (let i = start; i < end && idx < values.length; i++) {
    const m = lines[i]!.match(/^>>\s*(\d+)\.\s*(.*)$/)
    if (!m || m[1] !== '1') continue
    const text = values[idx]?.trim() ?? ''
    lines[i] = text ? `>> 1. ${text}` : '>> 1.'
    idx++
  }
}

function fillIdeasLines(lines: string[], start: number, end: number, ideas: string[]): void {
  const slots: { line: number; num: number }[] = []
  for (let i = start; i < end; i++) {
    const m = lines[i]!.match(/^>>\s*(\d+)\s*(.*)$/)
    if (m) slots.push({ line: i, num: parseInt(m[1]!, 10) })
  }
  slots.sort((a, b) => a.num - b.num)
  for (let i = 0; i < slots.length && i < ideas.length; i++) {
    const text = ideas[i]?.trim() ?? ''
    const { line, num } = slots[i]!
    lines[line] = text ? `>> ${num} ${text}` : `>> ${num} `
  }
}

function fillIdeasBullets(lines: string[], start: number, end: number, ideas: string[]): void {
  let idx = 0
  for (let i = start; i < end && idx < ideas.length; i++) {
    if (!/^-\s*/.test(lines[i]!)) continue
    const text = ideas[idx]?.trim() ?? ''
    lines[i] = text ? `- ${text}` : '- '
    idx++
  }
}

function fillLastWeekBigThreePlainLines(
  lines: string[],
  start: number,
  end: number,
  rows: WeeklyPlanWizardData['lastBigThree']
): void {
  fillPlainNumberedLines(lines, start, end, rows.map((r) => r.text), 3, (slot, text) => {
    const row = rows[slot - 1]!
    const pctRaw = String(row.pct).trim().toLowerCase()
    const pct = pctRaw === 'n/a' ? 'n/a' : `${parseInt(row.pct, 10) || 0}%`
    const body = text.trim()
    if (!body) return `${slot}. [Completion: ${pct}] `
    return `${slot}. [Completion: ${pct}] ${body}`
  })
}

function fillWeeklyBigThreeCheckboxes(lines: string[], start: number, end: number, values: string[]): void {
  for (let i = start; i < end; i++) {
    const m = lines[i]!.match(/^(\d+)\.\s*\[\s*\]\s*(.*)$/)
    if (!m) continue
    const slot = parseInt(m[1]!, 10)
    if (slot < 1 || slot > 3) continue
    const text = values[slot - 1]?.trim() ?? ''
    lines[i] = text ? `${slot}. [ ] ${text}` : `${slot}. [ ]`
  }
}

function fillVaultWeeklyTemplate(body: string, data: WeeklyPlanWizardData): string {
  const lines = body.split('\n')

  const winsRange = sectionRange(lines, AFTER_ACTION_HEADING)
  if (winsRange) {
    fillLetterNumberedLines(lines, winsRange[0], winsRange[1], data.wins, 5, (slot, text) =>
      text ? `> ${slot}. ${text}` : `> ${slot}. `
    )
  }

  const retroRange = sectionRange(lines, LAST_WEEK_B3_HEADING)
  if (retroRange) fillLastWeekBigThreeLines(lines, retroRange[0], retroRange[1], data.lastBigThree)

  const reflectRange = sectionRange(lines, REFLECTION_HEADING)
  if (reflectRange) fillReflectionCallout(lines, reflectRange[0], reflectRange[1], data.retroReflect)

  const rejRange = sectionRange(lines, REJUVENATION_HEADING)
  if (rejRange) fillRejuvenationLines(lines, rejRange[0], rejRange[1], data.rejuvenation)

  const ideasRange = sectionRange(lines, IDEAS_HEADING)
  if (ideasRange) fillIdeasLines(lines, ideasRange[0], ideasRange[1], data.ideas)

  const b3Range = sectionRange(lines, WEEKLY_BIG_THREE_HEADING)
  if (b3Range) fillWeeklyBigThreeCheckboxes(lines, b3Range[0], b3Range[1], data.bigThree)

  return lines.join('\n')
}

function fillStandardWeeklyTemplate(body: string, data: WeeklyPlanWizardData): string {
  const lines = body.split('\n')

  const winsRange = sectionRange(lines, AFTER_ACTION_HEADING)
  if (winsRange) {
    fillPlainNumberedLines(lines, winsRange[0], winsRange[1], data.wins, 5, (slot, text) =>
      text ? `${slot}. ${text}` : `${slot}. `
    )
  }

  const retroRange = sectionRange(lines, LAST_WEEK_B3_HEADING)
  if (retroRange) fillLastWeekBigThreePlainLines(lines, retroRange[0], retroRange[1], data.lastBigThree)

  const reflectRange = sectionRange(lines, REFLECTION_HEADING)
  if (reflectRange) fillReflectionCallout(lines, reflectRange[0], reflectRange[1], data.retroReflect)

  const rejRange = sectionRange(lines, REJUVENATION_HEADING)
  if (rejRange) {
    fillPlainNumberedLines(lines, rejRange[0], rejRange[1], data.rejuvenation, 3, (slot, text) =>
      text ? `${slot}. ${text}` : `${slot}. `
    )
  }

  const ideasRange = sectionRange(lines, IDEAS_HEADING)
  if (ideasRange) fillIdeasBullets(lines, ideasRange[0], ideasRange[1], data.ideas)

  const b3Range = sectionRange(lines, WEEKLY_BIG_THREE_HEADING)
  if (b3Range) fillWeeklyBigThreeCheckboxes(lines, b3Range[0], b3Range[1], data.bigThree)

  return lines.join('\n')
}

function replaceSectionByPattern(body: string, headingPattern: RegExp, content: string): string {
  const lines = body.split('\n')
  const range = sectionRange(lines, headingPattern)
  if (!range) return body
  const [start, end] = range
  const insert = content.trimEnd() ? content.trimEnd().split('\n') : ['- ']
  const next = [...lines.slice(0, start), ...insert, '', ...lines.slice(end)]
  return next.join('\n').replace(/\n{3,}/g, '\n\n')
}

function fillLegacyWeeklyTemplate(body: string, data: WeeklyPlanWizardData): string {
  let out = body
  out = replaceSectionByPattern(out, AFTER_ACTION_HEADING, bulletLines(data.wins))
  out = replaceSectionByPattern(out, LAST_WEEK_B3_HEADING, formatLastBigThreeRetro(data.lastBigThree))
  out = replaceSectionByPattern(
    out,
    REFLECTION_HEADING,
    data.retroReflect.trim() ? `${data.retroReflect.trim()}\n` : '- \n'
  )
  out = replaceSectionByPattern(out, REJUVENATION_HEADING, bulletLines(data.rejuvenation))
  out = replaceSectionByPattern(out, IDEAS_HEADING, bulletLines(data.ideas))
  out = replaceSectionByPattern(out, WEEKLY_BIG_THREE_HEADING, bulletLines(data.bigThree))
  return out
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

export function buildWeeklyNoteMarkdown(template: string, isoWeek: string, data: WeeklyPlanWizardData): string {
  const filled = fillWeeklyTemplateTokens(template, isoWeek)
  const body = usesObsidianCalloutWeeklyTemplate(template)
    ? fillVaultWeeklyTemplate(filled, data)
    : usesStandardWeeklyTemplate(template)
      ? fillStandardWeeklyTemplate(filled, data)
      : fillLegacyWeeklyTemplate(filled, data)
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
    // Retro step scores last week's planned outcomes (`## WEEKLY BIG THREE`), not the
    // previous file's `## Last Week's Big Three` section (that section is *its* retro of
    // the week before last).
    lastBigThree = lastWeekWeeklyBigThree.map((text) => ({ text, pct: '0' }))
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
    bigThreeSuggestionWeek,
    draftStep: 0
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
