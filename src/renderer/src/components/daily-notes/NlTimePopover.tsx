import { useEffect, useRef, useState } from 'react'
import { formatClock12 } from '../../../../shared/task-nl-parse'

interface NlTimePopoverProps {
  startMin: number
  anchor: DOMRect
  onChange: (startMin: number) => void
  onCommit: () => void
  onCancel: () => void
  /** When true, "Clear" sets unscheduled (create flow). */
  allowClear?: boolean
  onClear?: () => void
}

function snap15(min: number): number {
  return Math.max(0, Math.min(23 * 60 + 45, Math.round(min / 15) * 15))
}

export default function NlTimePopover({
  startMin,
  anchor,
  onChange,
  onCommit,
  onCancel,
  allowClear,
  onClear,
}: NlTimePopoverProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  const onCommitRef = useRef(onCommit)
  const onCancelRef = useRef(onCancel)
  onChangeRef.current = onChange
  onCommitRef.current = onCommit
  onCancelRef.current = onCancel
  const [typed, setTyped] = useState(formatClock12(startMin))

  useEffect(() => {
    setTyped(formatClock12(startMin))
  }, [startMin])

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
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const hour24 = Math.floor(startMin / 60)
  const minute = startMin % 60
  const hour12 = hour24 % 12 || 12
  const isAm = hour24 < 12

  function nudgeHour(dir: 1 | -1): void {
    onChange(snap15(startMin + dir * 60))
  }

  function nudgeMinute(dir: 1 | -1): void {
    onChange(snap15(startMin + dir * 15))
  }

  function setAmPm(am: boolean): void {
    if (am === isAm) return
    onChange(snap15(am ? startMin - 12 * 60 : startMin + 12 * 60))
  }

  function applyTyped(): void {
    const s = typed.trim().toLowerCase().replace(/\s+/g, ' ')
    const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/)
    if (m12) {
      let h = parseInt(m12[1]!, 10)
      const min = parseInt(m12[2]!, 10)
      if (m12[3] === 'pm' && h < 12) h += 12
      if (m12[3] === 'am' && h === 12) h = 0
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) onChange(snap15(h * 60 + min))
      return
    }
    const m24 = s.match(/^(\d{1,2}):(\d{2})$/)
    if (m24) {
      const h = parseInt(m24[1]!, 10)
      const min = parseInt(m24[2]!, 10)
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) onChange(snap15(h * 60 + min))
    }
  }

  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - 100), window.innerWidth - 216)
  const top = Math.min(anchor.bottom + 8, window.innerHeight - 260)

  return (
    <div
      ref={ref}
      className="dn-nl-time-pop"
      data-testid="nl-time-popover"
      style={{ left, top }}
      role="dialog"
      aria-label="Adjust start time"
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => {
        e.preventDefault()
        e.stopPropagation()
        nudgeMinute(e.deltaY < 0 ? 1 : -1)
      }}
    >
      <div className="dn-nl-pop-label">Start time</div>
      <div className="dn-nl-time-clock">
        <div className="dn-nl-time-col">
          <button type="button" aria-label="Hour up" onClick={() => nudgeHour(1)}>▲</button>
          <span className="dn-nl-time-val">{hour12}</span>
          <button type="button" aria-label="Hour down" onClick={() => nudgeHour(-1)}>▼</button>
        </div>
        <span className="dn-nl-time-sep">:</span>
        <div className="dn-nl-time-col">
          <button type="button" aria-label="Minute up" onClick={() => nudgeMinute(1)}>▲</button>
          <span className="dn-nl-time-val">{String(minute).padStart(2, '0')}</span>
          <button type="button" aria-label="Minute down" onClick={() => nudgeMinute(-1)}>▼</button>
        </div>
        <div className="dn-nl-time-ampm">
          <button type="button" className={isAm ? 'is-on' : ''} onClick={() => setAmPm(true)}>am</button>
          <button type="button" className={!isAm ? 'is-on' : ''} onClick={() => setAmPm(false)}>pm</button>
        </div>
      </div>
      <input
        className="dn-nl-time-input"
        value={typed}
        aria-label="Type a time"
        onChange={(e) => setTyped(e.target.value)}
        onBlur={applyTyped}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            applyTyped()
            onCommit()
          }
        }}
      />
      <div className="dn-nl-time-chips">
        <button type="button" onClick={() => onChange(snap15(startMin - 15))}>−15</button>
        <button type="button" onClick={() => onChange(snap15(startMin + 15))}>+15</button>
        <button
          type="button"
          onClick={() => {
            const n = new Date()
            onChange(snap15(n.getHours() * 60 + n.getMinutes()))
          }}
        >
          Now
        </button>
        {allowClear && onClear && (
          <button type="button" onClick={onClear}>Clear</button>
        )}
      </div>
      <div className="dn-nl-pop-foot">
        <span>Scroll to nudge</span>
        <span><kbd>↵</kbd> done</span>
      </div>
    </div>
  )
}
