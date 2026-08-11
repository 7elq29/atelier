/**
 * Shared Obsidian daily-note tag suggestions and inline-tag parsing for
 * renderer task creation/editing and main-process round-trip normalization.
 */

/** Predefined tags offered when the user types `#` while creating/editing a task. */
export const DAILY_NOTE_TAG_SUGGESTIONS = [
  '#p0',
  '#p1',
  '#meeting',
  '#delegated',
  '#project/spark',
  '#project/unstructured',
  '#project/logging',
  '#ktlo',
  '#q2'
] as const

const STRUCTURAL_DAILY_NOTE_TAGS = new Set(['#tracker', '#delegated'])

/** Task text plus inline `#tags` for edit fields (excludes section-managed tags). */
export function formatTaskTextWithInlineTags(text: string, tags: readonly string[]): string {
  const visible = tags.filter((tag) => !STRUCTURAL_DAILY_NOTE_TAGS.has(tag))
  if (visible.length === 0) return text
  return `${text} ${visible.join(' ')}`.trim()
}

/** Tags that make a Tasks/Backlog line a plain bullet (`- text`) rather than a checkbox. */
export const DAILY_NOTE_BULLET_TAGS = new Set<string>(['#meeting'])

export function normalizeDailyNoteTag(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

/** Extract inline `#tags` from free text; returns cleaned task text + tag list. */
export function parseInlineTagsFromTaskText(input: string): { text: string; tags: string[] } {
  const tags: string[] = []
  const text = input
    .replace(/#[\w/]+/g, (tag) => {
      tags.push(tag)
      return ''
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { text, tags }
}

export function isDailyNoteBulletFromTags(tags: readonly string[]): boolean {
  return tags.some((tag) => DAILY_NOTE_BULLET_TAGS.has(tag))
}

export function filterDailyNoteTagSuggestions(partial: string, exclude: readonly string[]): string[] {
  const raw = partial.trim().toLowerCase()
  const withoutHash = raw.startsWith('#') ? raw.slice(1) : raw
  return DAILY_NOTE_TAG_SUGGESTIONS.filter(
    (tag) => !exclude.includes(tag) && tag.slice(1).toLowerCase().includes(withoutHash)
  ).slice(0, 6)
}

/** `#` fragment being typed at `cursor`, or null when not in tag-entry mode. */
export function inlineTagQueryAtCursor(
  value: string,
  cursor: number
): { start: number; query: string } | null {
  const before = value.slice(0, cursor)
  const match = before.match(/(?:^|\s)#([\w/]*)$/)
  if (!match) return null
  const fragment = match[0]
  const start = before.length - fragment.length + (fragment.startsWith(' ') ? 1 : 0)
  return { start, query: match[1] ?? '' }
}

export function extractInlineTagsFromText(value: string): string[] {
  return value.match(/#[\w/]+/g) ?? []
}
