import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  activateHintTarget,
  buildHintEntries,
  clearHintLabelAttributes,
  findExactHintMatch,
  type HintEntry,
  isMetaModifierDown,
  layoutHintBadge,
  matchHintEntries,
  normalizeHintKeyChar,
  setHintLabelAttributes
} from '../keyboard-hints/keyboard-hints'

/** Hold ⌘ this long before badges appear — quick ⌘K / other chords stay unaffected. */
const HINT_HOLD_DELAY_MS = 200

type BadgeLayout = {
  label: string
  top: number
  left: number
}

type Props = {
  /** When true, hint mode cannot start (modals / onboarding). */
  disabled: boolean
  /** Root scanned for interactives (main app shell). */
  scanRootId?: string
}

/**
 * Vimium-style keyboard hints: hold ⌘ to label visible controls, then press
 * the badge letter(s) while ⌘ is still held to focus or activate them.
 */
export default function KeyboardHintsOverlay({ disabled, scanRootId = 'app' }: Props): JSX.Element | null {
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
    const filtered = matchHintEntries(entriesRef.current, bufferRef.current)
    const next: BadgeLayout[] = filtered.map(({ element, label }) => {
      const rect = element.getBoundingClientRect()
      const { top, left } = layoutHintBadge(rect, label)
      return { label, top, left }
    })
    setBadges(next)
  }, [])

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

  const dropHintModeIfMetaReleased = useCallback(() => {
    if (isMetaModifierDown()) return
    metaHeldRef.current = false
    clearActivationTimer()
    if (entriesRef.current.length > 0) teardown()
  }, [clearActivationTimer, teardown])

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
        bufferRef.current = ''
        setBuffer('')
        refreshBadges()
        return true
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
        dropHintModeIfMetaReleased()
      }

      if (metaHeldRef.current && entriesRef.current.length === 0) {
        clearActivationTimer()
      }

      if (e.key === 'Escape' && entriesRef.current.length > 0) {
        e.preventDefault()
        teardown()
        return
      }

      if (tryConsumeHintKey(e.key)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    function onKeyUp(e: KeyboardEvent): void {
      if (e.key === 'Meta') {
        clearActivationTimer()
        metaHeldRef.current = false
        if (entriesRef.current.length > 0) teardown()
        return
      }
      if (entriesRef.current.length > 0) dropHintModeIfMetaReleased()
    }

    function onWindowBlur(): void {
      // Cmd+Tab (and similar) often skips Meta keyup while this window is unfocused.
      abandonHintModeOnFocusLoss()
    }

    function onWindowFocus(): void {
      if (entriesRef.current.length > 0) dropHintModeIfMetaReleased()
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
    dropHintModeIfMetaReleased,
    refreshBadges,
    scheduleHintMode,
    teardown,
    tryConsumeHintKey
  ])

  useEffect(() => {
    if (disabled && entriesRef.current.length > 0) teardown()
  }, [disabled, teardown])

  useLayoutEffect(() => {
    if (active) refreshBadges()
  }, [active, buffer, refreshBadges])

  if (!active) return null

  return createPortal(
    <div
      className="keyboard-hints-layer"
      data-testid="keyboard-hints-overlay"
      data-keyboard-hints-root=""
      aria-hidden="true"
    >
      {badges.map((b) => (
        <span
          key={`${b.label}-${b.top}-${b.left}`}
          className={'keyboard-hint-badge' + (/^[0-9]+$/.test(b.label) ? ' keyboard-hint-badge--session' : '')}
          data-testid={`keyboard-hint-badge-${b.label}`}
          style={{ top: b.top, left: b.left }}
        >
          {b.label}
        </span>
      ))}
    </div>,
    document.body
  )
}
