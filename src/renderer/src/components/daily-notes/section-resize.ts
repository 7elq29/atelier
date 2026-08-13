/**
 * Resizable-section weights for the Daily Notes sidebar's four stacked
 * sections (Timeline / Unscheduled / Carry-over / Trackers). Each section gets a
 * `flex-grow` weight; dragging a handle between two sections transfers
 * weight between them proportional to the pixel delta. Weights persist to
 * localStorage (mirroring Playground's persistence pattern) so a resize
 * survives reload.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const STORAGE_KEY = 'atelier.dailyNotes.sectionWeights'
const MIN_WEIGHT = 0.4

export type SectionKey = 'timeline' | 'unscheduled' | 'carry' | 'trackers'

export type SectionWeights = Record<SectionKey, number>

const DEFAULT_WEIGHTS: SectionWeights = { timeline: 2, unscheduled: 2, carry: 1, trackers: 1 }

function loadWeights(): SectionWeights {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_WEIGHTS }
    const parsed = JSON.parse(raw) as Partial<SectionWeights>
    return {
      timeline: parsed.timeline ?? DEFAULT_WEIGHTS.timeline,
      unscheduled: parsed.unscheduled ?? DEFAULT_WEIGHTS.unscheduled,
      carry: parsed.carry ?? DEFAULT_WEIGHTS.carry,
      trackers: parsed.trackers ?? DEFAULT_WEIGHTS.trackers
    }
  } catch {
    return { ...DEFAULT_WEIGHTS }
  }
}

function saveWeights(weights: SectionWeights): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(weights))
  } catch {
    // best-effort persistence only
  }
}

export interface UseSectionResizeResult {
  weights: SectionWeights
  /** Attach to a resize handle's `onMouseDown`. */
  startResize: (upper: SectionKey, lower: SectionKey) => (e: React.MouseEvent) => void
}

export function useSectionResize(containerRef: React.RefObject<HTMLElement>): UseSectionResizeResult {
  const [weights, setWeights] = useState<SectionWeights>(() => loadWeights())
  const dragRef = useRef<{
    upper: SectionKey
    lower: SectionKey
    startY: number
    startUpper: number
    startLower: number
    totalAllWeights: number
    containerHeight: number
  } | null>(null)

  const startResize = useCallback(
    (upper: SectionKey, lower: SectionKey) =>
      (e: React.MouseEvent): void => {
        e.preventDefault()
        const containerHeight = containerRef.current?.clientHeight ?? 1
        dragRef.current = {
          upper,
          lower,
          startY: e.clientY,
          startUpper: weights[upper],
          startLower: weights[lower],
          totalAllWeights: weights.timeline + weights.unscheduled + weights.carry + weights.trackers,
          containerHeight
        }
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'row-resize'
      },
    [containerRef, weights]
  )

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const deltaPx = e.clientY - drag.startY
      const deltaWeight = (deltaPx / drag.containerHeight) * drag.totalAllWeights
      const nextUpper = Math.max(MIN_WEIGHT, drag.startUpper + deltaWeight)
      const nextLower = Math.max(MIN_WEIGHT, drag.startLower - deltaWeight)
      setWeights((prev) => ({ ...prev, [drag.upper]: nextUpper, [drag.lower]: nextLower }))
    }
    const onUp = (): void => {
      if (dragRef.current) {
        dragRef.current = null
        document.body.style.userSelect = ''
        document.body.style.cursor = ''
        setWeights((current) => {
          saveWeights(current)
          return current
        })
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return { weights, startResize }
}
