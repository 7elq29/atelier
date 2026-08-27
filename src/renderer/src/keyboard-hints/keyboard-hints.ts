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
  if (count <= chars.length) {
    return chars.slice(0, count)
  }
  // More than 26 chrome targets: two-letter codes for all of them so no
  // single-letter label is a prefix of another (e.g. "a" vs "aa").
  const labels: string[] = []
  for (const a of chars) {
    for (const b of chars) {
      labels.push(a + b)
      if (labels.length >= count) return labels
    }
  }
  return labels
}

/** Badge label shown on screen — numeric session/note rows show the full code (e.g. 11, 12); letter hints show the next key only. */
export function hintBadgeDisplayLabel(fullLabel: string, typedBuffer: string): string {
  if (/^[0-9]+$/.test(fullLabel)) {
    if (!typedBuffer || !fullLabel.startsWith(typedBuffer)) return fullLabel
    return fullLabel.slice(typedBuffer.length) || fullLabel
  }
  if (!fullLabel.startsWith(typedBuffer)) return fullLabel.charAt(0) ?? fullLabel
  const remaining = fullLabel.slice(typedBuffer.length)
  return remaining.charAt(0) ?? fullLabel.charAt(fullLabel.length - 1) ?? fullLabel
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

export function collectNumberedRowTargets(root: HTMLElement): HTMLElement[] {
  const rows = [...root.querySelectorAll<HTMLElement>('[data-hint-session-row], [data-hint-note-row]')].filter(
    (el) => {
      if (isHintExcluded(el) || !isElementVisible(el)) return false
      if (el.getAttribute('data-status') === 'creating-worktree') return false
      return true
    }
  )
  rows.sort(sortByVisualPosition)
  return rows
}

export function collectHintTargets(root: HTMLElement): HTMLElement[] {
  const found = [...root.querySelectorAll<HTMLElement>(INTERACTIVE_SELECTOR)].filter(
    (el) =>
      !isHintExcluded(el) &&
      isElementVisible(el) &&
      !el.closest('[data-hint-session-row], [data-hint-note-row]')
  )
  const unique = dedupeNestedInteractives(found)
  unique.sort(sortByVisualPosition)
  return unique
}

export function buildHintEntries(root: HTMLElement): HintEntry[] {
  const numberedRows = collectNumberedRowTargets(root)
  const sessionEntries: HintEntry[] = numberedRows.map((element, i) => ({
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

export type SessionTabShortcut = 'chat' | 'diff' | 'files' | 'terminal' | 'ports'

/** Reserved ⌘+letter session tab shortcuts while hint mode is active. */
export const SESSION_TAB_HINT_KEYS: Readonly<Record<string, SessionTabShortcut>> = {
  c: 'chat',
  d: 'diff',
  f: 'files',
  t: 'terminal',
  p: 'ports'
}

/** Letter shown on each tab button while hint mode is active (tabs stay excluded from letter hints). */
export const SESSION_TAB_SHORTCUT_LABELS: Readonly<Record<SessionTabShortcut, string>> = {
  chat: 'c',
  diff: 'd',
  files: 'f',
  terminal: 't',
  ports: 'p'
}

export function collectSessionTabShortcutBadges(root: HTMLElement): HintEntry[] {
  return [...root.querySelectorAll<HTMLElement>('[data-session-tab-shortcut]')]
    .filter((el) => isElementVisible(el))
    .map((element) => ({
      element,
      label: element.getAttribute('data-session-tab-shortcut') ?? ''
    }))
    .filter((entry) => entry.label.length > 0)
}

/** Don't treat editing chords as hint letters (Ctrl+C/V on macOS). */
export function shouldBypassHintKeydown(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>
): boolean {
  if (e.ctrlKey) return true
  const k = e.key.toLowerCase()
  if (e.metaKey && !e.altKey && (k === 'v' || k === 'x' || k === 'a')) return true
  return false
}
