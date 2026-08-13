const STORAGE_KEY = 'atelier.dailyNotes.dismissedCarry'

function loadAll(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Record<string, string[]>
  } catch {
    return {}
  }
}

function saveAll(data: Record<string, string[]>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    // best-effort only
  }
}

export function carrySuggestionKey(sourceDate: string, gid: string): string {
  return `${sourceDate}:${gid}`
}

export function listDismissedCarryKeys(viewDate: string): string[] {
  return loadAll()[viewDate] ?? []
}

export function dismissCarrySuggestion(viewDate: string, sourceDate: string, gid: string): void {
  const key = carrySuggestionKey(sourceDate, gid)
  const all = loadAll()
  const list = new Set(all[viewDate] ?? [])
  list.add(key)
  all[viewDate] = [...list]
  saveAll(all)
}
