import type { WeeklyPlanCarrySuggestion, WeeklyPlanContextLine } from './weekly-plan-types'

function taskKey(text: string): string {
  return text.trim().toLowerCase()
}

/** Merge daily-note context lines that share the same task text (different days). */
export function dedupeContextLines(lines: WeeklyPlanContextLine[]): WeeklyPlanContextLine[] {
  const byKey = new Map<string, { text: string; dates: string[] }>()
  for (const line of lines) {
    const key = taskKey(line.text)
    if (!key) continue
    const datePart = line.source.replace(/\s+daily\s*$/i, '').trim()
    const cur = byKey.get(key)
    if (cur) {
      if (datePart && !cur.dates.includes(datePart)) cur.dates.push(datePart)
    } else {
      byKey.set(key, { text: line.text, dates: datePart ? [datePart] : [] })
    }
  }
  return [...byKey.values()].map(({ text, dates }) => ({
    text,
    source:
      dates.length === 0
        ? 'daily'
        : dates.length === 1
          ? `${dates[0]} daily`
          : `${dates.join(', ')} daily`
  }))
}

export function dedupeCarrySuggestions(items: WeeklyPlanCarrySuggestion[]): WeeklyPlanCarrySuggestion[] {
  const out: WeeklyPlanCarrySuggestion[] = []
  const seen = new Set<string>()
  let idx = 0
  for (const item of items) {
    const key = taskKey(item.text)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push({ id: `carry_${idx++}`, text: item.text, source: item.source })
  }
  return out
}
