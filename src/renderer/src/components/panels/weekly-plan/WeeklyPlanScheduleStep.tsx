import { useMemo, useRef, useState } from 'react'
import type { WeeklyPlanScheduleEntry, WeeklyPlanWizardData } from '../../../../../shared/weekly-plan-types'
import {
  WP_WEEK_DAYS,
  splitScheduleEntry,
  syncScheduleEntries,
  wpEntryDayUnsched,
  wpEntryInPool,
  wpEntryOnTimeline,
  wpSetSlotEnd,
  wpSlotFromDropY,
  wpSlotStartMinutes,
  wpTimelineBlockStyle
} from './schedule-utils'

const POOL_KINDS = ['Rejuvenation', 'Big Three', 'Idea'] as const

function CalChip({
  entry,
  className,
  onDragStart,
  onDoubleClick
}: {
  entry: WeeklyPlanScheduleEntry
  className?: string
  onDragStart: (id: string) => void
  onDoubleClick: (id: string) => void
}): JSX.Element {
  const q2 = /#q2/i.test(entry.text)
  return (
    <span
      className={`wp-cal-chip${q2 ? ' is-q2' : ''}${className ? ` ${className}` : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/wp-entry', entry.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart(entry.id)
      }}
      onDoubleClick={() => onDoubleClick(entry.id)}
      title="Double-click to edit"
    >
      {entry.text || 'Untitled'}
    </span>
  )
}

function CalBlock({
  entry,
  onDragStart,
  onDoubleClick,
  onResizeStart
}: {
  entry: WeeklyPlanScheduleEntry
  onDragStart: (id: string) => void
  onDoubleClick: (id: string) => void
  onResizeStart: (id: string, ev: React.MouseEvent) => void
}): JSX.Element {
  const q2 = /#q2/i.test(entry.text)
  const style = wpTimelineBlockStyle(entry.slot)
  return (
    <div
      className={`wp-cal-block${q2 ? ' is-q2' : ''}`}
      data-testid="weekly-plan-cal-block"
      data-entry-id={entry.id}
      draggable
      style={{ top: style.top, height: style.height }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/wp-entry', entry.id)
        onDragStart(entry.id)
      }}
      onDoubleClick={() => onDoubleClick(entry.id)}
      title={entry.slot}
    >
      {entry.text}
      <div className="wp-cal-resize" onMouseDown={(ev) => onResizeStart(entry.id, ev)} />
    </div>
  )
}

export function WeeklyPlanScheduleStep({
  isoWeek,
  data,
  onChange
}: {
  isoWeek: string
  data: WeeklyPlanWizardData
  onChange: (entries: WeeklyPlanScheduleEntry[]) => void
}): JSX.Element {
  const dragId = useRef<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)

  const entries = useMemo(() => syncScheduleEntries(data), [data])

  const placeEntry = (id: string, day: string, slot: string): void => {
    const next = entries.map((e) => {
      if (e.id !== id) return e
      if (!day) return { ...e, day: '', slot: '' }
      if (!slot) return { ...e, day, slot: '' }
      return { ...e, day, slot }
    })
    onChange(next)
  }

  const editEntry = (id: string): void => {
    const e = entries.find((x) => x.id === id)
    if (!e) return
    const next = window.prompt('Edit task:', e.text)
    if (next === null || !String(next).trim()) return
    const trimmed = String(next).trim()
    const updated = entries.map((x) => (x.id === id ? { ...x, text: trimmed } : x))
    onChange(updated)
  }

  const onSplit = (id: string): void => {
    onChange(splitScheduleEntry(entries, id))
  }

  const pool = entries.filter(wpEntryInPool)

  const timeAxis = (
    <div className="wp-cal-time-axis">
      {Array.from({ length: 13 }, (_, i) => 7 + i).map((h) => {
        const top = ((h * 60 - 7 * 60) / (19 * 60 - 7 * 60)) * 100
        return (
          <span key={h} style={{ top: `${top}%` }}>
            {String(h).padStart(2, '0')}:00
          </span>
        )
      })}
    </div>
  )

  return (
    <div className="wp-split is-schedule-step">
      <div className="wp-split-main">
        <div className="wp-phase-label">Schedule</div>
        <h3 className="wp-title">Schedule the week</h3>
        <div className="wp-inline-hint">
          Drag to a day&apos;s <strong>Unscheduled</strong> row or <strong>timeline</strong>. Drop on the pool to
          unassign. Double-click to edit.
        </div>
        <div
          className={`wp-sched-left-pool${dragOver === 'pool' ? ' drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver('pool')
          }}
          onDragLeave={() => setDragOver(null)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(null)
            const id = e.dataTransfer.getData('text/wp-entry') || dragId.current
            if (id) placeEntry(id, '', '')
          }}
        >
          {!pool.length ? (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              All tasks placed — drop here to return to the pool.
            </span>
          ) : null}
          {POOL_KINDS.map((kind) => {
            const group = pool.filter((e) => e.kind === kind)
            if (!group.length) return null
            const title = kind === 'Idea' ? 'Ideas' : kind
            return (
              <div key={kind} className="wp-schedule-block">
                <h4>{title}</h4>
                <div className="wp-sched-pool-list">
                  {group.map((e) => (
                    <div key={e.id} className="wp-sched-pool-row">
                      <CalChip
                        entry={e}
                        className="wp-sched-pool-chip"
                        onDragStart={(id) => {
                          dragId.current = id
                        }}
                        onDoubleClick={editEntry}
                      />
                      <button
                        type="button"
                        className="btn btn-icon btn-sm wp-split-icon"
                        title="Split into another block"
                        onClick={(ev) => {
                          ev.stopPropagation()
                          onSplit(e.id)
                        }}
                      >
                        ⎇
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <aside className="wp-schedule-preview">
        <div className="wp-schedule-preview-title">{isoWeek}</div>
        <div className="wp-cal-board">
          <div className="wp-cal-matrix">
            <div className="wp-cal-matrix-corner" />
            {WP_WEEK_DAYS.map((label) => (
              <div key={label} className="wp-cal-matrix-day-head">
                {label}
              </div>
            ))}
            <div className="wp-cal-matrix-unsched-label">Unsched</div>
            {WP_WEEK_DAYS.map((day, dayIdx) => {
              const dayUnsched = entries.filter((e) => wpEntryDayUnsched(e) && e.day === day)
              const key = `unsched-${day}`
              return (
                <div
                  key={key}
                  className={`wp-cal-matrix-unsched${dayUnsched.length ? '' : ' empty-hint'}${dragOver === key ? ' drag-over' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(key)
                  }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(null)
                    const id = e.dataTransfer.getData('text/wp-entry') || dragId.current
                    if (id) placeEntry(id, day, '')
                  }}
                >
                  <div className="wp-cal-day-unsched-chips">
                    {dayUnsched.map((e) => (
                      <CalChip key={e.id} entry={e} onDragStart={(id) => { dragId.current = id }} onDoubleClick={editEntry} />
                    ))}
                  </div>
                </div>
              )
            })}
            {timeAxis}
            {WP_WEEK_DAYS.map((day, dayIdx) => {
              const timed = entries
                .filter((e) => wpEntryOnTimeline(e) && e.day === day)
                .sort((a, b) => wpSlotStartMinutes(a.slot) - wpSlotStartMinutes(b.slot))
              const key = `tl-${day}`
              return (
                <div
                  key={key}
                  className={`wp-cal-matrix-timeline${dragOver === key ? ' drag-over' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragOver(key)
                  }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(null)
                    const id = e.dataTransfer.getData('text/wp-entry') || dragId.current
                    if (!id) return
                    const slot = wpSlotFromDropY(e.currentTarget, e.clientY)
                    placeEntry(id, day, slot)
                  }}
                >
                  {timed.map((e) => (
                    <CalBlock
                      key={e.id}
                      entry={e}
                      onDragStart={(id) => {
                        dragId.current = id
                      }}
                      onDoubleClick={editEntry}
                      onResizeStart={(id, ev) => {
                        ev.preventDefault()
                        ev.stopPropagation()
                        const body = (ev.target as HTMLElement).closest('.wp-cal-matrix-timeline') as HTMLElement
                        const entry = entries.find((x) => x.id === id)
                        if (!entry || !body) return
                        const onMove = (ev2: MouseEvent): void => {
                          const endMin = wpSlotFromDropY(body, ev2.clientY)
                          const endParsed = wpSlotStartMinutes(endMin.split('–')[0] ?? '')
                          const copy = entries.map((x) => ({ ...x }))
                          const target = copy.find((x) => x.id === id)
                          if (target) wpSetSlotEnd(target, endParsed + 30)
                          onChange(copy)
                        }
                        const onUp = (): void => {
                          document.removeEventListener('mousemove', onMove)
                          document.removeEventListener('mouseup', onUp)
                        }
                        document.addEventListener('mousemove', onMove)
                        document.addEventListener('mouseup', onUp)
                      }}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </aside>
    </div>
  )
}
