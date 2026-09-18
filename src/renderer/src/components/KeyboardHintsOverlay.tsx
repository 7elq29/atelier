import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  activateHintTarget,
  buildHintEntries,
  clearHintLabelAttributes,
  findCompletedHintMatch,
  findExactHintMatch,
  hintBadgeDisplayLabel,
  type HintEntry,
  layoutHintBadge,
  matchHintEntries,
  normalizeHintKeyChar,
  collectSessionTabShortcutBadges,
  SESSION_TAB_HINT_KEYS,
  type SessionTabShortcut,
  setHintLabelAttributes,
  shouldBypassHintKeydown
} from '../keyboard-hints/keyboard-hints'

/** Hold ⌘ this long before badges appear — quick ⌘K / other chords stay unaffected. */
const HINT_HOLD_DELAY_MS = 200

type BadgeState = 'normal' | 'matched' | 'dimmed'

type BadgeLayout = {
  label: string
  top: number
  left: number
  kind: 'hint' | 'tab'
  state: BadgeState
}

type Props = {
  /** When true, hint mode cannot start (modals / onboarding). */
  disabled: boolean
  /** Root scanned for interactives (main app shell). */
  scanRootId?: string
  /** ⌘+h/d/f/t/p while hints are active — reserved session tab shortcuts (not c/v/a). */
  onSessionTabShortcut?: (tab: SessionTabShortcut) => void
  /** Key codes (e.g. 'KeyL') that must never be consumed as hint chars, even when hint mode
   *  is active, so that global ⌘+key shortcuts can still be handled by their own listeners. */
  reservedMetaCodes?: ReadonlySet<string>
}

/**
 * Vimium-style keyboard hints: hold ⌘ to label visible controls, then press
 * the badge letter(s) while ⌘ is still held to focus or activate them.
 */
export default function KeyboardHintsOverlay({
  disabled,
  scanRootId = 'app',
  onSessionTabShortcut,
  reservedMetaCodes
}: Props): JSX.Element | null {
  const [active, setActive] = useState(false)
  const [buffer, setBuffer] = useState('')
  const [badges, setBadges] = useState<BadgeLayout[]>([])

  const entriesRef = useRef<HintEntry[]>([])
  const metaHeldRef = useRef(false)
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bufferRef = useRef('')
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled

  const clearActivationTimer = useCallback(() => {
    if (activationTimerRef.current !== null) {
      clearTimeout(activationTimerRef.current)
      activationTimerRef.current = null
    }
  }, [])

  const teardown = useCallback(() => {
    clearActivationTimer()
    clearHintLabelAttributes(entriesRef.current)
    entriesRef.current = []
    bufferRef.current = ''
    setBuffer('')
    setBadges([])
    setActive(false)
  }, [clearActivationTimer])

  const refreshBadges = useCallback(() => {
    const buf = bufferRef.current
    const next: BadgeLayout[] = []

    // Show ALL entries — matched ones get accent fill, others dim.
    // When no buffer is typed every badge is neutral ('normal').
    for (const { element, label } of entriesRef.current) {
      const isMatch = buf.length === 0 || label.startsWith(buf)
      const displayLabel = isMatch ? hintBadgeDisplayLabel(label, buf) : label
      const state: BadgeState =
        buf.length === 0 ? 'normal' : isMatch ? 'matched' : 'dimmed'
      const rect = element.getBoundingClientRect()
      const { top, left } = layoutHintBadge(rect, displayLabel)
      next.push({ label: displayLabel, top, left, kind: 'hint' as const, state })
    }

    // Session tab shortcut badges — always normal (dedicated shortcuts, not navigational)
    const root = document.getElementById(scanRootId)
    if (root) {
      for (const { element, label } of collectSessionTabShortcutBadges(root)) {
        const rect = element.getBoundingClientRect()
        const { top, left } = layoutHintBadge(rect, label)
        next.push({ label, top, left, kind: 'tab', state: 'normal' })
      }
    }

    setBadges(next)
  }, [scanRootId])

  const beginHintMode = useCallback(() => {
    if (disabledRef.current) return
    const root = document.getElementById(scanRootId)
    if (!root) return

    const entries = buildHintEntries(root)
    if (entries.length === 0) return

    clearHintLabelAttributes(entriesRef.current)
    entriesRef.current = entries
    setHintLabelAttributes(entries)
    bufferRef.current = ''
    setBuffer('')
    setActive(true)
    refreshBadges()
  }, [refreshBadges, scanRootId])

  const scheduleHintMode = useCallback(() => {
    clearActivationTimer()
    activationTimerRef.current = setTimeout(() => {
      activationTimerRef.current = null
      if (metaHeldRef.current && entriesRef.current.length === 0) beginHintMode()
    }, HINT_HOLD_DELAY_MS)
  }, [beginHintMode, clearActivationTimer])

  const dropHintModeIfMetaReleased = useCallback(
    (metaStillDown: boolean) => {
      if (metaStillDown) return
      metaHeldRef.current = false
      clearActivationTimer()
      if (entriesRef.current.length > 0) teardown()
    },
    [clearActivationTimer, teardown]
  )

  /**
   * ⌘ came up: a buffer that already names a target is a finished choice, not an abandoned one.
   *
   * Row labels run past nine, so "1" stays ambiguous with "10" for as long as more digits could
   * arrive. Releasing ⌘ is what says none will.
   */
  const commitPendingHintOnRelease = useCallback(() => {
    const pending = findCompletedHintMatch(entriesRef.current, bufferRef.current)
    if (pending) activateHintTarget(pending.element)
    teardown()
  }, [teardown])

  const abandonHintModeOnFocusLoss = useCallback(() => {
    metaHeldRef.current = false
    clearActivationTimer()
    if (entriesRef.current.length > 0) teardown()
  }, [clearActivationTimer, teardown])

  const tryConsumeHintKey = useCallback(
    (key: string): boolean => {
      if (!metaHeldRef.current || entriesRef.current.length === 0) return false
      const hintChar = normalizeHintKeyChar(key)
      if (!hintChar) return false

      const nextBuffer = bufferRef.current + hintChar
      const exact = findExactHintMatch(entriesRef.current, nextBuffer)
      if (exact) {
        activateHintTarget(exact.element)
        teardown()
        return true
      }

      const partial = matchHintEntries(entriesRef.current, nextBuffer)
      if (partial.length === 0) {
        // No hint starts with this char — reset buffer but don't consume the event
        // so reserved shortcuts (e.g. ⌘L) can still be handled by their own listeners.
        bufferRef.current = ''
        setBuffer('')
        refreshBadges()
        return false
      }

      bufferRef.current = nextBuffer
      setBuffer(nextBuffer)
      refreshBadges()
      return true
    },
    [refreshBadges, teardown]
  )

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Meta') {
        if (e.repeat || disabledRef.current) return
        metaHeldRef.current = true
        if (entriesRef.current.length === 0) scheduleHintMode()
        return
      }

      if (!e.getModifierState('Meta') && entriesRef.current.length > 0) {
        dropHintModeIfMetaReleased(false)
      }

      if (metaHeldRef.current && entriesRef.current.length === 0) {
        clearActivationTimer()
      }

      if (e.key === 'Escape' && entriesRef.current.length > 0) {
        e.preventDefault()
        teardown()
        return
      }

      if (shouldBypassHintKeydown(e)) return

      if (
        entriesRef.current.length > 0 &&
        onSessionTabShortcut &&
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const tab = SESSION_TAB_HINT_KEYS[e.key.toLowerCase()]
        if (tab) {
          e.preventDefault()
          e.stopPropagation()
          onSessionTabShortcut(tab)
          teardown()
          return
        }
      }

      // Don't consume digit keys when no numbered rows exist in hint mode —
      // those digits are reserved for the collapsed-sidebar session shortcuts.
      const isDigit = /^[0-9]$/.test(e.key)
      const hasNumberedRows = entriesRef.current.some((entry) => /^[0-9]/.test(entry.label))
      if (isDigit && !hasNumberedRows) return

      // Don't consume keys that are globally reserved as ⌘+key shortcuts.
      if (e.metaKey && reservedMetaCodes?.has(e.code)) return

      if (tryConsumeHintKey(e.key)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    function onKeyUp(e: KeyboardEvent): void {
      if (e.key === 'Meta') {
        clearActivationTimer()
        metaHeldRef.current = false
        if (entriesRef.current.length > 0) commitPendingHintOnRelease()
        return
      }
      // macOS withholds keyup for most keys while ⌘ is down, so trust the event's own state
      // rather than assuming a released key means a released ⌘ — that dropped the typed buffer.
      if (entriesRef.current.length > 0) dropHintModeIfMetaReleased(e.getModifierState('Meta'))
    }

    function onWindowBlur(): void {
      // Cmd+Tab (and similar) often skips Meta keyup while this window is unfocused.
      abandonHintModeOnFocusLoss()
    }

    function onWindowFocus(): void {
      // No event to read ⌘ from here; a refocus is never mid-chord, so end hint mode.
      abandonHintModeOnFocusLoss()
    }

    function onVisibilityChange(): void {
      if (document.hidden) abandonHintModeOnFocusLoss()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('scroll', refreshBadges, true)
    window.addEventListener('resize', refreshBadges)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('scroll', refreshBadges, true)
      window.removeEventListener('resize', refreshBadges)
      clearActivationTimer()
    }
  }, [
    abandonHintModeOnFocusLoss,
    clearActivationTimer,
    commitPendingHintOnRelease,
    dropHintModeIfMetaReleased,
    refreshBadges,
    scheduleHintMode,
    teardown,
    tryConsumeHintKey,
    onSessionTabShortcut
  ])

  useEffect(() => {
    if (disabled && entriesRef.current.length > 0) teardown()
  }, [disabled, teardown])

  useLayoutEffect(() => {
    if (active) refreshBadges()
  }, [active, buffer, refreshBadges])

  if (!active) return null

  return createPortal(
    <>
      <div
        className="keyboard-hints-layer"
        data-testid="keyboard-hints-overlay"
        data-keyboard-hints-root=""
        aria-hidden="true"
      >
        {badges.map((b) => {
          const stateClass =
            b.state === 'matched'
              ? ' keyboard-hint-badge--matched'
              : b.state === 'dimmed'
                ? ' keyboard-hint-badge--dimmed'
                : ''
          const kindClass =
            b.kind === 'tab'
              ? ' keyboard-hint-badge--tab'
              : /^[0-9]+$/.test(b.label)
                ? ' keyboard-hint-badge--session'
                : ''
          return (
            <span
              key={`${b.kind}-${b.label}-${b.top}-${b.left}`}
              className={`keyboard-hint-badge${stateClass}${kindClass}`}
              data-testid={
                b.kind === 'tab'
                  ? `keyboard-hint-tab-badge-${b.label}`
                  : `keyboard-hint-badge-${b.label}`
              }
              style={{ top: b.top, left: b.left }}
            >
              {b.label}
            </span>
          )
        })}
      </div>
      <div className="keyboard-hints-status-bar" aria-hidden="true">
        <span>⌘ held</span>
        <span className="keyboard-hints-sep">·</span>
        <span className={`keyboard-hints-buffer${buffer ? '' : ' keyboard-hints-buffer--empty'}`}>
          {buffer || '_'}
        </span>
        <span className="keyboard-hints-sep">·</span>
        <span>{buffer ? 'continue…' : 'type a letter'}</span>
      </div>
    </>,
    document.body
  )
}
