import type { WeeklyPlanScheduleEntry, WeeklyPlanScheduleKind, WeeklyPlanWizardData } from '../../../../../shared/weekly-plan-types'

export const WP_WEEK_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export const WP_SCHEDULE_START_HOUR = 7
export const WP_SCHEDULE_END_HOUR = 21

const DAY_START = WP_SCHEDULE_START_HOUR * 60
const DAY_END = WP_SCHEDULE_END_HOUR * 60

export function wpEntryInPool(e: WeeklyPlanScheduleEntry): boolean {
  return Boolean(e) && !String(e.day).trim()
}

export function wpEntryDayUnsched(e: WeeklyPlanScheduleEntry): boolean {
  return Boolean(e) && String(e.day).trim() !== '' && !String(e.slot).trim()
}

export function wpEntryOnTimeline(e: WeeklyPlanScheduleEntry): boolean {
  return Boolean(e) && String(e.day).trim() !== '' && String(e.slot).trim() !== ''
}

export function wpEntryIsDone(e: WeeklyPlanScheduleEntry): boolean {
  return e.status === 'done'
}

export function wpSlotStartMinutes(slot: string): number {
  const m = String(slot).match(/(\d{1,2}):(\d{2})/)
  if (!m) return 9 * 60
  return parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10)
}

export function wpMinutesToSlot(startMin: number, endMin: number): string {
  const fmt = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
  return `${fmt(startMin)}–${fmt(endMin)}`
}

export function wpSlotFromDropY(bodyEl: HTMLElement, clientY: number): string {
  const rect = bodyEl.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(rect.height, 1)))
  const min = Math.round((DAY_START + ratio * (DAY_END - DAY_START)) / 30) * 30
  const clamped = Math.max(DAY_START, Math.min(DAY_END - 30, min))
  return wpMinutesToSlot(clamped, clamped + 30)
}

export function wpTimelineBlockStyle(slot: string): { top: string; height: string } {
  const start = wpSlotStartMinutes(slot)
  const endMatch = String(slot).match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/)
  const end = endMatch
    ? parseInt(endMatch[3]!, 10) * 60 + parseInt(endMatch[4]!, 10)
    : start + 30
  const topPct = ((start - DAY_START) / (DAY_END - DAY_START)) * 100
  const heightPct = ((Math.max(30, end - start) / (DAY_END - DAY_START)) * 100)
  return { top: `${topPct}%`, height: `${heightPct}%` }
}

export function wpSetSlotEnd(entry: WeeklyPlanScheduleEntry, endMin: number): void {
  if (!entry.slot) return
  const startMin = wpSlotStartMinutes(entry.slot)
  const end = Math.max(startMin + 30, Math.min(DAY_END, Math.round(endMin / 30) * 30))
  entry.slot = wpMinutesToSlot(startMin, end)
}

export function wpStripSplitSuffix(text: string): string {
  return String(text).replace(/\s+\(\d+\)$/, '').trim()
}

export function weeklyPlanScheduleItems(data: WeeklyPlanWizardData): { key: string; text: string; kind: WeeklyPlanScheduleKind }[] {
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

export function syncScheduleEntries(data: WeeklyPlanWizardData): WeeklyPlanScheduleEntry[] {
  const entries = [...(data.scheduleEntries ?? [])]
  weeklyPlanScheduleItems(data).forEach((it) => {
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
    } else if (primary.splitGroup) {
      primary.kind = it.kind
      const siblings = entries.filter(
        (x) => x.splitGroup === primary!.splitGroup || x.id === primary!.splitGroup
      )
      for (const s of siblings) {
        s.kind = it.kind
      }
    } else {
      primary.text = it.text
      primary.kind = it.kind
    }
  })
  return entries
}

/** Append a schedulable task (Ideas pool) and return the new primary entry id. */
export function addScheduleTask(data: WeeklyPlanWizardData, text = 'New task'): { data: WeeklyPlanWizardData; entryId: string } {
  const ideas = [...data.ideas]
  const ideaIndex = ideas.length
  ideas.push(text)
  const sourceKey = `idea_${ideaIndex}`
  const entryId = `ent_${sourceKey}`
  const next: WeeklyPlanWizardData = { ...data, ideas, scheduleEntries: syncScheduleEntries({ ...data, ideas }) }
  const synced = syncScheduleEntries(next)
  if (!synced.some((e) => e.id === entryId)) {
    synced.push({
      id: entryId,
      sourceKey,
      text,
      kind: 'Idea',
      day: '',
      slot: ''
    })
  }
  return { data: { ...next, scheduleEntries: synced }, entryId }
}

export function splitScheduleEntry(entries: WeeklyPlanScheduleEntry[], id: string): WeeklyPlanScheduleEntry[] {
  const next = [...entries]
  const src = next.find((e) => e.id === id)
  if (!src) return next
  const groupId = src.splitGroup || src.id
  if (!src.splitGroup) src.splitGroup = groupId
  next.push({
    id: `ent_split_${Date.now()}`,
    sourceKey: src.sourceKey,
    text: wpStripSplitSuffix(src.text),
    kind: src.kind,
    day: '',
    slot: '',
    splitGroup: groupId
  })
  renumberSplitGroup(next, groupId)
  return next
}

export function renumberSplitGroup(entries: WeeklyPlanScheduleEntry[], groupId: string): void {
  const siblings = entries
    .filter((e) => e.splitGroup === groupId || e.id === groupId)
    .sort((a, b) => a.id.localeCompare(b.id))
  if (siblings.length <= 1) return
  const base = wpStripSplitSuffix(siblings[0]!.text)
  siblings.forEach((e, i) => {
    e.splitGroup = groupId
    e.text = `${base} (${i + 1})`
  })
}

function setWizardSourceText(data: WeeklyPlanWizardData, sourceKey: string, text: string): WeeklyPlanWizardData {
  if (sourceKey.startsWith('rej_')) {
    const i = parseInt(sourceKey.slice(4), 10)
    if (Number.isNaN(i)) return data
    const rejuvenation = [...data.rejuvenation]
    while (rejuvenation.length <= i) rejuvenation.push('')
    rejuvenation[i] = text
    return { ...data, rejuvenation }
  }
  if (sourceKey.startsWith('b3_')) {
    const i = parseInt(sourceKey.slice(3), 10)
    if (Number.isNaN(i)) return data
    const bigThree = [...data.bigThree]
    while (bigThree.length <= i) bigThree.push('')
    bigThree[i] = text
    return { ...data, bigThree }
  }
  if (sourceKey.startsWith('idea_')) {
    const i = parseInt(sourceKey.slice(5), 10)
    if (Number.isNaN(i)) return data
    const ideas = [...data.ideas]
    while (ideas.length <= i) ideas.push('')
    ideas[i] = text
    return { ...data, ideas }
  }
  return data
}

/** Update schedule entry label and keep wizard source fields in sync (fixes edit being overwritten by sync). */
export function applyScheduleEntryText(
  data: WeeklyPlanWizardData,
  entryId: string,
  text: string
): WeeklyPlanWizardData {
  const trimmed = text.trim()
  if (!trimmed) return data

  const before = syncScheduleEntries(data)
  const entries = before.map((e) => ({ ...e }))
  const entry = entries.find((e) => e.id === entryId)
  if (!entry) return data

  if (entry.splitGroup) {
    const target = entries.find((e) => e.id === entryId)
    if (target) target.text = trimmed
    const base = wpStripSplitSuffix(trimmed)
    let next = setWizardSourceText({ ...data, scheduleEntries: entries }, entry.sourceKey, base)
    next = {
      ...next,
      scheduleEntries: preserveSchedulePlacements(before, syncScheduleEntries(next))
    }
    return next
  }

  let next = setWizardSourceText(data, entry.sourceKey, trimmed)
  next = {
    ...next,
    scheduleEntries: preserveSchedulePlacements(before, syncScheduleEntries(next))
  }
  return next
}

function preserveSchedulePlacements(
  before: WeeklyPlanScheduleEntry[],
  after: WeeklyPlanScheduleEntry[]
): WeeklyPlanScheduleEntry[] {
  const prevById = new Map(before.map((e) => [e.id, e]))
  return after.map((e) => {
    const prev = prevById.get(e.id)
    if (!prev) return e
    return {
      ...e,
      day: prev.day,
      slot: prev.slot,
      splitGroup: prev.splitGroup
    }
  })
}

/** Remove a scheduled task (and its source line when removing the primary entry). */
export function removeScheduleEntry(data: WeeklyPlanWizardData, entryId: string): WeeklyPlanWizardData {
  let entries = syncScheduleEntries(data).map((e) => ({ ...e }))
  const entry = entries.find((e) => e.id === entryId)
  if (!entry) return data

  if (entry.splitGroup && entry.id !== entry.splitGroup) {
    const groupId = entry.splitGroup
    entries = entries.filter((e) => e.id !== entryId)
    const remaining = entries.filter((e) => e.splitGroup === groupId || e.id === groupId)
    if (remaining.length === 1) {
      remaining[0]!.splitGroup = undefined
    }
    return { ...data, scheduleEntries: entries }
  }

  if (entry.splitGroup) {
    const groupId = entry.splitGroup
    entries = entries.filter((e) => e.splitGroup !== groupId && e.id !== groupId)
    let next = setWizardSourceText({ ...data, scheduleEntries: entries }, entry.sourceKey, '')
    next = { ...next, scheduleEntries: syncScheduleEntries(next) }
    return next
  }

  entries = entries.filter((e) => e.sourceKey !== entry.sourceKey)
  let next = setWizardSourceText({ ...data, scheduleEntries: entries }, entry.sourceKey, '')
  next = { ...next, scheduleEntries: syncScheduleEntries(next) }
  return next
}
