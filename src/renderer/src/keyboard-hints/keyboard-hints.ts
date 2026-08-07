/** Home-row-first charset (26 letters) for hint labels. */
export const HINT_CHARS = 'asdfghjklqwertyuiopzxcvbnm'

const INTERACTIVE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]:not([aria-disabled="true"])',
  '[role="link"]',
  '[role="tab"]:not([aria-disabled="true"])',
  '[role="menuitem"]:not([aria-disabled="true"])',
  'summary'
].join(',')

export type HintEntry = {
  element: HTMLElement
  label: string
}

export function generateHintLabels(count: number): string[] {
  const chars = [...HINT_CHARS]
  const labels: string[] = []
  if (count <= chars.length) {
    for (let i = 0; i < count; i++) labels.push(chars[i]!)
    return labels
  }
  for (const a of chars) {
    for (const b of chars) {
      labels.push(a + b)
      if (labels.length >= count) return labels
    }
  }
  return labels
}

function isHintExcluded(el: Element): boolean {
  return !!el.closest('[data-hint-exclude], [data-hint-exclude-root], [data-keyboard-hints-root]')
}

function isElementVisible(el: HTMLElement): boolean {
  if (!el.isConnected) return false
  const style = getComputedStyle(el)
  if (style.visibility === 'hidden' || style.display === 'none') return false
  if (parseFloat(style.opacity) === 0) return false

  let node: HTMLElement | null = el
  while (node) {
    if (node.getAttribute('aria-hidden') === 'true') return false
    if (node.hasAttribute('inert')) return false
    node = node.parentElement
  }

  const rect = el.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return false
  if (rect.bottom < 0 || rect.right < 0) return false
  if (rect.top > window.innerHeight || rect.left > window.innerWidth) return false
  return true
}

/** Prefer the innermost interactive element when nested (e.g. icon inside button). */
function dedupeNestedInteractives(elements: HTMLElement[]): HTMLElement[] {
  const set = new Set(elements)
  return elements.filter((el) => {
    let parent = el.parentElement
    while (parent) {
      if (set.has(parent as HTMLElement) && parent.matches(INTERACTIVE_SELECTOR)) return false
      parent = parent.parentElement
    }
    return true
  })
}

function sortByVisualPosition(a: HTMLElement, b: HTMLElement): number {
  const ra = a.getBoundingClientRect()
  const rb = b.getBoundingClientRect()
  if (Math.abs(ra.top - rb.top) > 6) return ra.top - rb.top
  return ra.left - rb.left
}

export function collectSessionRowTargets(root: HTMLElement): HTMLElement[] {
  const rows = [...root.querySelectorAll<HTMLElement>('[data-hint-session-row]')].filter((el) => {
    if (isHintExcluded(el) || !isElementVisible(el)) return false
    if (el.getAttribute('data-status') === 'creating-worktree') return false
    return true
  })
  rows.sort(sortByVisualPosition)
  return rows
}

export function collectHintTargets(root: HTMLElement): HTMLElement[] {
  const found = [...root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)].filter(
    (el) =>
      !isHintExcluded(el) &&
      isElementVisible(el) &&
      !el.closest('[data-hint-session-row]')
  )
  const unique = dedupeNestedInteractives(found)
  unique.sort(sortByVisualPosition)
  return unique
}

export function buildHintEntries(root: HTMLElement): HintEntry[] {
  const sessionRows = collectSessionRowTargets(root)
  const sessionEntries: HintEntry[] = sessionRows.map((element, i) => ({
    element,
    label: String(i + 1)
  }))

  const otherTargets = collectHintTargets(root)
  const letterLabels = generateHintLabels(otherTargets.length)
  const otherEntries: HintEntry[] = otherTargets.map((element, i) => ({
    element,
    label: letterLabels[i]!
  }))

  return [...sessionEntries, ...otherEntries]
}

export function activateHintTarget(el: HTMLElement): void {
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    el.isContentEditable
  ) {
    el.focus()
    return
  }
  el.focus({ preventScroll: true })
  el.click()
}

export function setHintLabelAttributes(entries: HintEntry[]): void {
  for (const { element, label } of entries) {
    element.setAttribute('data-keyboard-hint-label', label)
  }
}

export function clearHintLabelAttributes(entries: HintEntry[]): void {
  for (const { element } of entries) {
    element.removeAttribute('data-keyboard-hint-label')
  }
}

export function matchHintEntries(entries: HintEntry[], buffer: string): HintEntry[] {
  if (!buffer) return entries
  return entries.filter((e) => e.label.startsWith(buffer))
}

export function findExactHintMatch(entries: HintEntry[], buffer: string): HintEntry | null {
  const matches = entries.filter((e) => e.label.startsWith(buffer))
  if (matches.length === 1 && matches[0]!.label === buffer) return matches[0]!
  return null
}

const HINT_BADGE_VIEWPORT_MARGIN = 4
const HINT_BADGE_GAP = 2
/** Matches `.keyboard-hint-badge` (11px mono, padding 2×5, line-height 1). */
const HINT_BADGE_HEIGHT = 15

/** Approximate rendered width for viewport clamping (`.keyboard-hint-badge`). */
export function estimateHintBadgeWidth(label: string): number {
  return 10 + label.length * 6.6
}

/** Fixed-position top/left for a hint badge anchored to `rect`, kept inside the viewport. */
export function layoutHintBadge(rect: DOMRect, label: string): { top: number; left: number } {
  const w = estimateHintBadgeWidth(label)
  const h = HINT_BADGE_HEIGHT
  const maxLeft = window.innerWidth - HINT_BADGE_VIEWPORT_MARGIN - w
  const maxTop = window.innerHeight - HINT_BADGE_VIEWPORT_MARGIN - h

  let left = Math.min(Math.max(HINT_BADGE_VIEWPORT_MARGIN, rect.left - HINT_BADGE_GAP), maxLeft)
  let top = rect.top - HINT_BADGE_GAP - h

  if (top < HINT_BADGE_VIEWPORT_MARGIN) {
    top = rect.bottom + HINT_BADGE_GAP
  }
  top = Math.min(Math.max(HINT_BADGE_VIEWPORT_MARGIN, top), maxTop)

  return { top, left }
}

/** Single character accepted while hint mode is active (digits for sessions, letters for chrome). */
export function isMetaModifierDown(): boolean {
  return new KeyboardEvent('keydown').getModifierState('Meta')
}

export function normalizeHintKeyChar(key: string): string | null {
  if (key.length !== 1) return null
  if (/^[0-9]$/.test(key)) return key
  if (/^[a-zA-Z]$/.test(key)) return key.toLowerCase()
  return null
}
