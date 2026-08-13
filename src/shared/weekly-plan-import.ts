import type {
  WeeklyPlanScheduleEntry,
  WeeklyPlanScheduleKind,
  WeeklyPlanWizardData
} from './weekly-plan-types'
import { isWeeklyPlanInstructionLine } from './weekly-plan-filters'

type SectionSlice = { heading: string; body: string }

function normalizeSectionHeading(raw: string): string {
  return raw.replace(/<sub>[\s\S]*?<\/sub>/gi, '').trim()
}

function splitMarkdownSections(content: string): SectionSlice[] {
  const lines = content.split('\n')
  const out: SectionSlice[] = []
  let currentHeading = ''
  let body: string[] = []

  const flush = (): void => {
    if (!currentHeading) return
    out.push({ heading: currentHeading, body: body.join('\n') })
  }

  for (const line of lines) {
    const h = line.match(/^##\s+(.+?)\s*$/)
    if (h) {
      flush()
      currentHeading = normalizeSectionHeading(h[1]!.trim())
      body = []
      continue
    }
    if (currentHeading) body.push(line)
  }
  flush()
  return out
}

function sectionScore(body: string): number {
  let score = 0
  for (const line of body.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('%%')) continue
    if (/^>\s*\[!/.test(t)) continue
    if (/^\d+\.\s*\[\s*\]\s*$/.test(t)) continue
    if (/^\d+\.\s*\[Completion:\s*%?\]\s*$/i.test(t.replace(/^>\s*/, ''))) continue
    if (t === '-' || t === '- [ ]') continue
    score++
  }
  return score
}

function pickBestSection(sections: SectionSlice[], headingPattern: RegExp): string {
  const matches = sections.filter((s) => headingPattern.test(s.heading))
  if (!matches.length) return ''
  matches.sort((a, b) => sectionScore(b.body) - sectionScore(a.body))
  return matches[0]!.body
}

function pickBestBulletSection(sections: SectionSlice[], headingPattern: RegExp): string {
  const matches = sections.filter((s) => headingPattern.test(s.heading))
  if (!matches.length) return ''
  matches.sort((a, b) => {
    const bulletsA = bulletTexts(a.body).length
    const bulletsB = bulletTexts(b.body).length
    if (bulletsB !== bulletsA) return bulletsB - bulletsA
    return sectionScore(b.body) - sectionScore(a.body)
  })
  return matches[0]!.body
}

function bulletTexts(body: string): string[] {
  const out: string[] = []
  for (const line of body.split('\n')) {
    let t = line.trim()
    if (!t) continue
    while (t.startsWith('>')) t = t.replace(/^>\s*/, '').trim()
    const task = t.match(/^-\s*\[\s*\]\s*(.+)$/)
    if (task) {
      const text = task[1]!.trim()
      if (text && !isWeeklyPlanInstructionLine(text)) out.push(text)
      continue
    }
    const plain = t.match(/^-\s+(.+)$/)
    if (plain) {
      const text = plain[1]!.trim()
      if (text && !isWeeklyPlanInstructionLine(text)) out.push(text)
      continue
    }
    const numbered = t.match(/^\d+\.\s*(.+)$/)
    if (numbered) {
      let text = numbered[1]!.trim()
      text = text.replace(/^\[\s*\]\s*/, '').trim()
      if (text && !isWeeklyPlanInstructionLine(text)) out.push(text)
    }
  }
  return out
}

function parseRetroSection(body: string): WeeklyPlanWizardData['lastBigThree'] {
  const rows: WeeklyPlanWizardData['lastBigThree'] = []
  for (const line of body.split('\n')) {
    let t = line.trim()
    if (!t) continue
    while (t.startsWith('>')) t = t.replace(/^>\s*/, '').trim()
    const numbered = t.match(/^(\d+)\.\s*(.+)$/)
    if (numbered) t = numbered[2]!.trim()

    const completionBracket = t.match(/^\[Completion:\s*(n\/a|\d+%?)\]\s*(.*)$/i)
    if (completionBracket) {
      const raw = completionBracket[1]!.toLowerCase()
      const pct = raw === 'n/a' ? 'n/a' : String(parseInt(raw, 10) || 0)
      const text = completionBracket[2]!.trim()
      if (text && !isWeeklyPlanInstructionLine(text)) rows.push({ text, pct })
      continue
    }
    const pctMatch = t.match(/^(.+?)\s*(?:—|–|-)\s*completion:\s*(n\/a|\d+%?)\s*$/i)
    if (pctMatch) {
      const text = pctMatch[1]!.trim()
      if (!text || isWeeklyPlanInstructionLine(text)) continue
      const raw = pctMatch[2]!.toLowerCase()
      const pct = raw === 'n/a' ? 'n/a' : String(parseInt(raw, 10) || 0)
      rows.push({ text, pct })
    }
  }
  while (rows.length < 3) rows.push({ text: '', pct: '0' })
  return rows.slice(0, 3)
}

function parseReflection(body: string): string {
  const parts: string[] = []
  for (const line of body.split('\n')) {
    let t = line.trim()
    if (!t) continue
    while (t.startsWith('>')) t = t.replace(/^>\s*/, '').trim()
    if (/^\[!/.test(t)) continue
    if (/\(write something\)/i.test(t)) continue
    if (t.startsWith('-')) {
      const m = t.match(/^-\s+(.+)$/)
      if (m?.[1]?.trim()) parts.push(m[1].trim())
      continue
    }
    const numbered = t.match(/^\d+\.\s*(.+)$/)
    if (numbered?.[1]?.trim()) {
      parts.push(numbered[1].trim())
      continue
    }
    parts.push(t)
  }
  return parts.join('\n').trim()
}

function padSlots(values: string[], count: number): string[] {
  const out = [...values]
  while (out.length < count) out.push('')
  return out.slice(0, count)
}

function scheduleItems(data: WeeklyPlanWizardData): { key: string; text: string; kind: WeeklyPlanScheduleKind }[] {
  const items: { key: string; text: string; kind: WeeklyPlanScheduleKind }[] = []
  data.rejuvenation.forEach((t, i) => {
    const text = t.trim()
    if (text) items.push({ key: `rej_${i}`, text, kind: 'Rejuvenation' })
  })
  data.bigThree.forEach((t, i) => {
    const text = t.trim()
    if (text) items.push({ key: `b3_${i}`, text, kind: 'Big Three' })
  })
  data.ideas.forEach((t, i) => {
    const text = t.trim()
    if (text) items.push({ key: `idea_${i}`, text, kind: 'Idea' })
  })
  return items
}

function syncScheduleEntries(data: WeeklyPlanWizardData): WeeklyPlanScheduleEntry[] {
  const entries = [...(data.scheduleEntries ?? [])]
  scheduleItems(data).forEach((it) => {
    const primaryId = `ent_${it.key}`
    let primary = entries.find((x) => x.id === primaryId)
    if (!primary) {
      entries.push({
        id: primaryId,
        sourceKey: it.key,
        text: it.text,
        kind: it.kind,
        day: '',
        slot: ''
      })
    } else {
      primary.text = it.text
      primary.kind = it.kind
    }
  })
  return entries
}

function normalizeMatchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+\(\d+\)$/, '')
    .replace(/\s*-\s*make plan\s*$/i, '')
    .trim()
}

function matchScheduleToEntry(text: string, entries: WeeklyPlanScheduleEntry[]): WeeklyPlanScheduleEntry | null {
  const norm = normalizeMatchText(text)
  for (const e of entries) {
    const base = normalizeMatchText(e.text)
    if (norm === base || norm.includes(base) || base.includes(norm)) return e
  }
  for (const e of entries) {
    const base = normalizeMatchText(e.text)
    const firstWord = norm.split(/\s+/)[0]
    if (firstWord && firstWord.length > 4 && base.startsWith(firstWord)) return e
  }
  return null
}

function parseScheduleLines(body: string): { slot: string; text: string }[] {
  const out: { slot: string; text: string }[] = []
  for (const line of body.split('\n')) {
    const t = line.trim()
    const m = t.match(/^-\s*\[\s*\]\s*(\d{1,2}:\d{2}[–-]\d{1,2}:\d{2})\s+(.+)$/)
    if (m) out.push({ slot: m[1]!.replace(/\s+/g, ''), text: m[2]!.trim() })
  }
  return out
}

function attachImportedSchedule(data: WeeklyPlanWizardData, scheduleBody: string): WeeklyPlanWizardData {
  const lines = parseScheduleLines(scheduleBody)
  if (!lines.length) return { ...data, scheduleEntries: syncScheduleEntries(data) }

  let entries = syncScheduleEntries(data)
  for (const { slot, text } of lines) {
    let entry = matchScheduleToEntry(text, entries)
    if (!entry) {
      const ideas = [...data.ideas]
      const ideaIndex = ideas.length
      ideas.push(text)
      data = { ...data, ideas: padSlots(ideas, 6).slice(0, Math.max(6, ideas.length)) }
      entries = syncScheduleEntries(data)
      entry = entries.find((e) => e.sourceKey === `idea_${ideaIndex}`) ?? null
    }
    if (entry) {
      entry.text = text
      entry.slot = slot
      entry.day = ''
    }
  }
  return { ...data, scheduleEntries: entries }
}

/** Parse a vault backup / mixed template markdown file into wizard draft data. */
export function parseWeeklyPlanWizardDataFromMarkdown(content: string): WeeklyPlanWizardData {
  const sections = splitMarkdownSections(content)

  const winsBody = pickBestBulletSection(sections, /^AFTER ACTION REVIEW/i)
  const wins = padSlots(bulletTexts(winsBody), 3)

  const retroBody = pickBestSection(sections, /^Last Week'?s Big Three|^Last week Big Three/i)
  const lastBigThree = parseRetroSection(retroBody)

  const reflectBody = pickBestSection(sections, /^Reflection|^What worked/i)
  const retroReflect = parseReflection(reflectBody)

  const rejBody = pickBestSection(sections, /^REJUVENATION/i)
  const rejuvenation = padSlots(bulletTexts(rejBody), 3)

  const ideasBody = pickBestSection(sections, /^Ideas/i)
  const ideas = padSlots(bulletTexts(ideasBody), 6)

  const b3Body = pickBestSection(sections, /^WEEKLY BIG THREE|^Weekly Big Three/i)
  const bigThree = padSlots(bulletTexts(b3Body), 3)

  let data: WeeklyPlanWizardData = {
    wins,
    lastBigThree,
    retroReflect,
    rejuvenation,
    ideas,
    bigThree,
    scheduleEntries: []
  }

  const scheduleBody = pickBestSection(sections, /^Schedule/i)
  data = attachImportedSchedule(data, scheduleBody)

  // Ensure stable ids on any ad-hoc entries
  for (const e of data.scheduleEntries) {
    if (!e.id) e.id = `ent_import_${globalThis.crypto.randomUUID()}`
  }

  return data
}
