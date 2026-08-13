/**
 * Obsidian / Dataview-style task priority inline fields: `[priority:: high]`.
 * Shared by the vault parser (main) and task UI (renderer).
 */

import type { DailyTask, ExternalLink } from './daily-note-types'
import { formatTaskTextWithInlineTags } from './daily-note-tags'

export interface TaskPriorityOption {
  value: string
  /** Shown in autocomplete menus (Obsidian-style). */
  menuLabel: string
}

export const TASK_PRIORITY_OPTIONS: TaskPriorityOption[] = [
  { value: 'high', menuLabel: 'high priority' },
  { value: 'medium', menuLabel: 'medium priority' },
  { value: 'low', menuLabel: 'low priority' },
  { value: 'highest', menuLabel: 'highest priority' },
  { value: 'lowest', menuLabel: 'lowest priority' }
]

export function formatPriorityInlineField(value: string): string {
  return `[priority:: ${value}]`
}

const EXTERNAL_LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g

export function parseExternalLinksFromTaskText(input: string): {
  text: string
  externalLinks: ExternalLink[]
} {
  const externalLinks: ExternalLink[] = []
  const text = input
    .replace(EXTERNAL_LINK_RE, (_m, label: string, url: string) => {
      externalLinks.push({ label, url })
      return ''
    })
    .replace(/\s+/g, ' ')
    .trim()
  return { text, externalLinks }
}

export function mergeExternalLinks(...lists: readonly ExternalLink[][]): ExternalLink[] {
  const seen = new Set<string>()
  const merged: ExternalLink[] = []
  for (const list of lists) {
    for (const link of list) {
      const key = `${link.label}\0${link.url}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(link)
    }
  }
  return merged
}

export function externalLinksEqual(a: readonly ExternalLink[], b: readonly ExternalLink[]): boolean {
  if (a.length !== b.length) return false
  return a.every((link, index) => {
    const other = b[index]
    return other !== undefined && link.label === other.label && link.url === other.url
  })
}

/** Task rename buffer: plain text, inline `#tags`, markdown links, and `[priority:: …]`. */
export function formatTaskEditBuffer(
  task: Pick<DailyTask, 'text' | 'tags' | 'priority' | 'externalLinks'>
): string {
  const { text: textWithoutEmbeddedLinks, externalLinks: embeddedLinks } =
    parseExternalLinksFromTaskText(task.text)
  const links = mergeExternalLinks(embeddedLinks, task.externalLinks)
  let line = formatTaskTextWithInlineTags(textWithoutEmbeddedLinks, task.tags)
  for (const link of links) {
    line = `${line} [${link.label}](${link.url})`.trim()
  }
  if (task.priority?.trim()) {
    line = `${line} ${formatPriorityInlineField(task.priority)}`.trim()
  }
  return line
}

const PRIORITY_FIELD_PREFIX = 'priority::'

/**
 * When the caret is inside an unclosed `[…` segment, decide whether the priority
 * autocomplete should stay open. Returns `{ open: true }` only while the segment
 * is empty or still typing the `priority::` prefix/field; `[xxx` closes the menu.
 */
export function getPriorityFieldDraft(
  value: string,
  cursor: number
): { open: boolean; start: number } | null {
  const before = value.slice(0, cursor)
  const start = before.lastIndexOf('[')
  if (start === -1) return null

  const segment = before.slice(start + 1)
  if (segment.includes(']')) return null

  // `[label](https://…)` markdown links are not priority fields.
  if (/^\[[^\]]*\]\(https?:\/\//.test(value.slice(start))) return null

  if (segment.length === 0) {
    return { open: true, start }
  }
  if (PRIORITY_FIELD_PREFIX.startsWith(segment) || segment.startsWith(PRIORITY_FIELD_PREFIX)) {
    return { open: true, start }
  }
  return { open: false, start }
}

/** Strip inline priority fields, markdown links, and dangling `[` from an edit buffer. */
export function parseTaskEditContent(input: string): {
  text: string
  priority?: string
  priorityTouched: boolean
  externalLinks: ExternalLink[]
} {
  let remaining = input
  let priority: string | undefined
  let priorityTouched = false
  remaining = remaining.replace(/\[(\w+)::\s*([^\]]*)\]/g, (_m, key: string, value: string) => {
    const v = value.trim()
    if (key === 'priority') {
      priorityTouched = true
      if (v) priority = v
    }
    return ''
  })
  const { text: withoutLinks, externalLinks } = parseExternalLinksFromTaskText(remaining)
  remaining = withoutLinks
  // Drop a dangling `[` left when the picker opened but no field was chosen.
  remaining = remaining.replace(/\s*\[(?:[^\]]*)?$/, '')
  return {
    text: remaining.replace(/\s+/g, ' ').trim(),
    priority,
    priorityTouched,
    externalLinks
  }
}

export function formatTaskEditLine(text: string, priority?: string): string {
  return formatTaskEditBuffer({ text, tags: [], externalLinks: [], priority })
}

/** Timeline block left-accent class from Dataview priority. */
export function priorityTimelineAccentClass(priority?: string): string {
  if (!priority?.trim()) return ''
  const p = priority.trim().toLowerCase()
  if (p === 'high' || p === 'highest') return ' dn-tblock-pri-high'
  if (p === 'low' || p === 'lowest') return ' dn-tblock-pri-low'
  return ''
}

export function priorityDisplayLabel(value: string): string {
  return value.trim()
}
