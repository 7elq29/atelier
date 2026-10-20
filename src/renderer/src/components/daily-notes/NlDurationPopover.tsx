import { useEffect, useRef } from 'react'
import { NL_DUR_STEPS_MIN, nearestDurIdx } from '../../../../shared/task-nl-parse'

interface NlDurationPopoverProps {
  durationMin: number
  anchor: DOMRect
  onChange: (durationMin: number) => void
  onCommit: () => void
  onCancel: () => void
  /** Called on option mousedown so the parent can shield row Delete immediately. */
  onArmShield?: () => void
  steps?: readonly number[]
}

function labelFor(min: number): string {
  if (min < 60) return `${min} min`
  if (min % 60 === 0) {
    const h = min / 60
    return h === 1 ? '1 hour' : `${h} hours`
  }
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${h}h ${m}m`
}

export default function NlDurationPopover({
  durationMin,
  anchor,
  onChange,
  onCommit,
  onCancel,
  onArmShield,
  steps = NL_DUR_STEPS_MIN,
}: NlDurationPopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  const onCommitRef = useRef(onCommit)
  const onCancelRef = useRef(onCancel)
  const onArmShieldRef = useRef(onArmShield)
  onChangeRef.current = onChange
  onCommitRef.current = onCommit
  onCancelRef.current = onCancel
  onArmShieldRef.current = onArmShield
  const activeIdx = nearestDurIdx(durationMin, steps)

  useEffect(() => {
    function onDoc(e: MouseEvent): void {
      if (ref.current?.contains(e.target as Node)) return
      onCommitRef.current()
    }
    const t = setTimeout(() => document.addEventListener('mousedown', onDoc, true), 60)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDoc, true)
    }
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onCancelRef.current()
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        onCommitRef.current()
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        const next = Math.min(steps.length - 1, activeIdx + 1)
        onChangeRef.current(steps[next]!)
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.max(0, activeIdx - 1)
        onChangeRef.current(steps[next]!)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [activeIdx, steps])

  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - 90), window.innerWidth - 196)
  const top = Math.min(anchor.bottom + 8, window.innerHeight - 280)

  return (
    <div
      ref={ref}
      className="dn-nl-dur-pop"
      data-testid="nl-duration-popover"
      style={{ left, top }}
      role="dialog"
      aria-label="Adjust duration"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const next = Math.max(
          0,
          Math.min(steps.length - 1, activeIdx + (e.deltaY < 0 ? 1 : -1))
        )
        onChange(steps[next]!)
      }}
    >
      <div className="dn-nl-pop-label dn-nl-pop-label--dur">Duration</div>
      <div className="dn-nl-dur-list">
        {steps.map((min, i) => (
          <button
            key={min}
            type="button"
            className={i === activeIdx ? 'is-on' : undefined}
            onMouseDown={(e) => {
              // Arm shield before mouseup/click so Delete is gone/inert even
              // if the popover unmounts mid-gesture.
              e.preventDefault()
              e.stopPropagation()
              onArmShieldRef.current?.()
            }}
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onChange(min)
              onCommit()
            }}
          >
            {labelFor(min)}
          </button>
        ))}
      </div>
    </div>
  )
}
