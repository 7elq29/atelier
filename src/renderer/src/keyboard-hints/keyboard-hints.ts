/** Home-row-first charset (26 letters) for hint labels. */
export const HINT_CHARS = 'asdfghjklqwertyuiopzxcvbnm'

/** Never assign these as chrome hint badges — reserved for ⌘+edit chords or ⌘+tab shortcuts. */
export const RESERVED_HINT_LETTERS = new Set(['a', 'c', 'v', 'x', 'h', 'd', 'f', 't', 'p', 'l'])

const HINT_LABEL_CHARS = [...HINT_CHARS].filter((c) => !RESERVED_HINT_LETTERS.has(c)).join('')

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

/** Prefix-free codes of a single fixed width — only needed past `k²` targets. */
function fixedWidthLabels(chars: string[], width: number, count: number): string[] {
  const labels: string[] = []
  const build = (prefix: string): boolean => {
    if (prefix.length === width) {
      labels.push(prefix)
      return labels.length >= count
    }
    for (const c of chars) {
      if (build(prefix + c)) return true
    }
    return false
  }
  build('')
  return labels
}

/**
 * Vimium-style labels: as many one-key targets as possible, two-key codes only for the overflow.
 *
 * Reserving the *last* `p` characters as two-key prefixes keeps every prefix disjoint from the
 * one-key labels, so no label is a prefix of another and each badge's next key is unambiguous.
 * Labelling everything two-key instead (the previous behaviour) meant that past 17 targets the
 * badges — which show only the next key — collapsed into walls of the same repeated letter and
 * nothing could be reached in a single keystroke.
 */
export function generateHintLabels(count: number): string[] {
  const chars = [...HINT_LABEL_CHARS]
  const k = chars.length
  if (count <= 0) return []
  if (count <= k) return chars.slice(0, count)
  if (count > k * k) return fixedWidthLabels(chars, 3, count)

  // `p` prefixes yield (k - p) one-key labels plus p * k two-key labels; take the smallest p
  // that covers `count` so the fewest targets pay for the second keystroke.
  let p = 1
  while (p < k && k - p + p * k < count) p += 1

  const labels = chars.slice(0, k - p)
  for (const prefix of chars.slice(k - p)) {
    for (const c of chars) {
      labels.push(prefix + c)
      if (labels.length >= count) return labels
    }
  }
  return labels
}

/**
 * Badge label shown on screen: the full code up front, then only what is left to type.
 *
 * Letter hints used to render just their next key, which made every two-key label sharing a
 * prefix paint the same character — a wall of identical badges with no way to tell the targets
 * apart. Since `generateHintLabels` keeps almost every label one key long, showing the whole
 * code costs nothing visually and stays unambiguous.
 */
export function hintBadgeDisplayLabel(fullLabel: string, typedBuffer: string): string {
  if (!typedBuffer || !fullLabel.startsWith(typedBuffer)) return fullLabel
  return fullLabel.slice(typedBuffer.length) || fullLabel
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
      if (['creating-worktree', 'cleaning-up'].includes(el.getAttribute('data-status') ?? '')) return false
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

/**
 * The target whose label *is* the buffer, even when longer labels extend it.
 *
 * Numbered row labels are not prefix-free — "1" is also the start of "10" — so `findExactHintMatch`
 * refuses to fire on "1" while a tenth row exists. Releasing ⌘ ends the input, which is the point
 * at which the shorter reading is the only one left.
 */
export function findCompletedHintMatch(entries: HintEntry[], buffer: string): HintEntry | null {
  if (!buffer) return null
  return entries.find((e) => e.label === buffer) ?? null
}

const HINT_BADGE_VIEWPORT_MARGIN = 4
const HINT_BADGE_GAP = 2
/** Matches `.keyboard-hint-badge` (11.5px mono, padding 3×7, line-height 1, 1px border top+bottom). */
const HINT_BADGE_HEIGHT = 19

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
export function normalizeHintKeyChar(key: string): string | null {
  if (key.length !== 1) return null
  if (/^[0-9]$/.test(key)) return key
  if (/^[a-zA-Z]$/.test(key)) return key.toLowerCase()
  return null
}

export type SessionTabShortcut = 'chat' | 'diff' | 'files' | 'terminal' | 'ports'

/** Reserved ⌘+letter session tab shortcuts while hint mode is active (not c/v/a — copy/paste/select-all). */
export const SESSION_TAB_HINT_KEYS: Readonly<Record<string, SessionTabShortcut>> = {
  h: 'chat',
  d: 'diff',
  f: 'files',
  t: 'terminal',
  p: 'ports'
}

/** Letter shown on each tab button while hint mode is active (tabs stay excluded from letter hints). */
export const SESSION_TAB_SHORTCUT_LABELS: Readonly<Record<SessionTabShortcut, string>> = {
  chat: 'h',
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

/** Copy, paste, select-all, cut — never hijack for hints or tab switching. */
export function isStandardEditChord(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>
): boolean {
  if (e.ctrlKey) return true
  const k = e.key.toLowerCase()
  if (e.metaKey && !e.altKey && (k === 'c' || k === 'v' || k === 'a' || k === 'x')) return true
  return false
}

/** Don't treat editing chords as hint letters while ⌘ hint mode is active. */
export function shouldBypassHintKeydown(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>
): boolean {
  return isStandardEditChord(e)
}
