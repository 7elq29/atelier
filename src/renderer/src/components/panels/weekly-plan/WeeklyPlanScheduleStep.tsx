import { useMemo, useRef, useState, type MutableRefObject } from 'react'
import type { WeeklyPlanScheduleEntry, WeeklyPlanWizardData } from '../../../../../shared/weekly-plan-types'
import {
  WP_WEEK_DAYS,
  WP_SCHEDULE_END_HOUR,
  WP_SCHEDULE_START_HOUR,
  applyScheduleEntryText,
  addScheduleTask,
  removeScheduleEntry,
  splitScheduleEntry,
  syncScheduleEntries,
  wpEntryDayUnsched,
  wpEntryInPool,
  wpEntryIsDone,
  wpEntryOnTimeline,
  wpSetSlotEnd,
  wpSlotFromDropY,
  wpSlotStartMinutes,
  wpTimelineBlockStyle
} from './schedule-utils'

const POOL_KINDS = ['Big Three', 'Rejuvenation', 'Idea'] as const

function ScheduleRemoveButton({ onRemove }: { onRemove: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="btn btn-icon btn-sm wp-cal-remove"
      title="Remove task"
      data-testid="weekly-plan-cal-remove"
      onClick={(ev) => {
        ev.stopPropagation()
        ev.preventDefault()
        onRemove()
      }}
    >
      ✕
    </button>
  )
}

function CalChip({
  entry,
  className,
  editingId,
  editDraft,
  onEditDraftChange,
  onCommitEdit,
  onCancelEdit,
  onDragStart,
  onDoubleClick
}: {
  entry: WeeklyPlanScheduleEntry
  className?: string
  editingId: string | null
  editDraft: string
  onEditDraftChange: (v: string) => void
  onCommitEdit: (draft?: string) => void
  onCancelEdit: () => void
  onDragStart: (id: string) => void
  onDoubleClick: (id: string) => void
}): JSX.Element {
  const q2 = /#q2/i.test(entry.text)
  const meeting = entry.isNote || /#meeting/i.test(entry.text)
  const done = wpEntryIsDone(entry)
  const editing = editingId === entry.id
  if (editing) {
    return (
      <input
        className="input wp-cal-chip-edit"
        data-testid="weekly-plan-cal-edit"
        value={editDraft}
        autoFocus
        onChange={(e) => onEditDraftChange(e.target.value)}
        onBlur={(e) => onCommitEdit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onCommitEdit()
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancelEdit()
          }
        }}
      />
    )
  }
  return (
    <span
      className={`wp-cal-chip${q2 ? ' is-q2' : ''}${meeting ? ' is-meeting' : ''}${done ? ' is-done' : ''}${className ? ` ${className}` : ''}`}
      data-entry-id={entry.id}
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
  editingId,
  editDraft,
  onEditDraftChange,
  onCommitEdit,
  onCancelEdit,
  onDragStart,
  onDoubleClick,
  onRemove,
  onResizeStart
}: {
  entry: WeeklyPlanScheduleEntry
  editingId: string | null
  editDraft: string
  onEditDraftChange: (v: string) => void
  onCommitEdit: (draft?: string) => void
  onCancelEdit: () => void
  onDragStart: (id: string) => void
  onDoubleClick: (id: string) => void
  onRemove: () => void
  onResizeStart: (id: string, ev: React.MouseEvent) => void
}): JSX.Element {
  const q2 = /#q2/i.test(entry.text)
  const meeting = entry.isNote || /#meeting/i.test(entry.text)
  const done = wpEntryIsDone(entry)
  const style = wpTimelineBlockStyle(entry.slot)
  const editing = editingId === entry.id
  return (
    <div
      className={`wp-cal-block${q2 ? ' is-q2' : ''}${meeting ? ' is-meeting' : ''}${done ? ' is-done' : ''}${editing ? ' is-editing' : ''}`}
      data-testid="weekly-plan-cal-block"
      data-entry-id={entry.id}
      draggable={!editing}
      style={{ top: style.top, height: style.height }}
      onDragStart={(e) => {
        if (editing) {
          e.preventDefault()
          return
        }
        e.dataTransfer.setData('text/wp-entry', entry.id)
        onDragStart(entry.id)
      }}
      onDoubleClick={(ev) => {
        ev.stopPropagation()
        onDoubleClick(entry.id)
      }}
      title={entry.slot}
    >
      {editing ? (
        <input
          className="input wp-cal-block-edit"
          data-testid="weekly-plan-cal-edit"
          value={editDraft}
          autoFocus
          onChange={(e) => onEditDraftChange(e.target.value)}
          onBlur={(e) => onCommitEdit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onCommitEdit()
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              onCancelEdit()
            }
          }}
        />
      ) : (
        entry.text
      )}
      <ScheduleRemoveButton onRemove={onRemove} />
      <div className="wp-cal-resize" onMouseDown={(ev) => onResizeStart(entry.id, ev)} />
    </div>
  )
}

function UnscheduledDayCell({
  day,
  dayUnsched,
  dragOverKey,
  expanded,
  onToggleExpand,
  editingId,
  editDraft,
  onEditDraftChange,
  onCommitEdit,
  onCancelEdit,
  onStartEdit,
  dragId,
  onPlaceEntry,
  onRemoveEntry,
  setDragOver,
  setDropPreviewSlot
}: {
  day: string
  dayUnsched: WeeklyPlanScheduleEntry[]
  dragOverKey: string
  expanded: boolean
  onToggleExpand: () => void
  editingId: string | null
  editDraft: string
  onEditDraftChange: (v: string) => void
  onCommitEdit: (draft?: string) => void
  onCancelEdit: () => void
  onStartEdit: (id: string) => void
  dragId: MutableRefObject<string | null>
  onPlaceEntry: (id: string, day: string, slot: string) => void
  onRemoveEntry: (id: string) => void
  setDragOver: (key: string | null) => void
  setDropPreviewSlot: (slot: string | null) => void
}): JSX.Element {
  const key = `unsched-${day}`
  const chipProps = {
    editingId,
    editDraft,
    onEditDraftChange,
    onCommitEdit,
    onCancelEdit,
    onDoubleClick: onStartEdit
  }

  return (
    <div
      className={`wp-cal-matrix-unsched${dayUnsched.length ? '' : ' empty-hint'}${expanded ? ' is-expanded' : ' is-collapsed'}${dragOverKey === key ? ' drag-over' : ''}`}
      data-testid={`weekly-plan-unsched-${day.toLowerCase()}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(key)
        setDropPreviewSlot(null)
      }}
      onDragLeave={() => {
        setDragOver(null)
        setDropPreviewSlot(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(null)
        setDropPreviewSlot(null)
        const id = e.dataTransfer.getData('text/wp-entry') || dragId.current
        if (id) onPlaceEntry(id, day, '')
      }}
    >
      {dragOverKey === key ? (
        <div
          className="wp-cal-drop-preview wp-cal-drop-preview--unsched"
          data-testid="weekly-plan-cal-drop-preview-unsched"
        />
      ) : null}
      <div className="wp-cal-day-unsched-chips">
        {dayUnsched.map((e) => (
          <span key={e.id} className="wp-cal-unsched-wrap">
            <CalChip
              entry={e}
              {...chipProps}
              onDragStart={(id) => {
                dragId.current = id
              }}
            />
            <ScheduleRemoveButton onRemove={() => onRemoveEntry(e.id)} />
          </span>
        ))}
      </div>
      {dayUnsched.length > 0 ? (
        <button
          type="button"
          className="wp-cal-unsched-toggle"
          data-testid={`weekly-plan-unsched-toggle-${day.toLowerCase()}`}
          aria-expanded={expanded}
          title={expanded ? 'Collapse unscheduled' : 'Expand unscheduled'}
          onClick={(ev) => {
            ev.stopPropagation()
            onToggleExpand()
          }}
        >
          {expanded ? '▴' : '▾'}
          <span className="wp-cal-unsched-toggle-count">{dayUnsched.length}</span>
        </button>
      ) : null}
    </div>
  )
}

function TimelineDropPreview({ slot }: { slot: string }): JSX.Element {
  return (
    <div
      className="wp-cal-drop-preview"
      data-testid="weekly-plan-cal-drop-preview"
      style={wpTimelineBlockStyle(slot)}
    >
      <span className="wp-cal-drop-preview-label" data-testid="weekly-plan-cal-drop-preview-slot">
        {slot}
      </span>
    </div>
  )
}

export function WeeklyPlanScheduleStep({
  isoWeek,
  weekLabel,
  data,
  onDataChange,
  embedded = false
}: {
  isoWeek: string
  weekLabel?: string
  data: WeeklyPlanWizardData
  onDataChange: (update: WeeklyPlanWizardData | ((prev: WeeklyPlanWizardData) => WeeklyPlanWizardData)) => void
  embedded?: boolean
}): JSX.Element {
  const dragId = useRef<string | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const [dropPreviewSlot, setDropPreviewSlot] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [unschedExpanded, setUnschedExpanded] = useState(false)

  const entries = useMemo(() => syncScheduleEntries(data), [data])

  const placeEntry = (id: string, day: string, slot: string): void => {
    onDataChange((prev) => {
      const synced = syncScheduleEntries(prev)
      const next = synced.map((e) => {
        if (e.id !== id) return e
        if (!day) return { ...e, day: '', slot: '' }
        if (!slot) return { ...e, day, slot: '' }
        return { ...e, day, slot }
      })
      return { ...prev, scheduleEntries: next }
    })
  }

  const startEdit = (id: string): void => {
    const e = entries.find((x) => x.id === id)
    if (!e) return
    setEditingId(id)
    setEditDraft(e.text)
  }

  const commitEdit = (draftOverride?: string): void => {
    const id = editingId
    if (!id) return
    const trimmed = (draftOverride ?? editDraft).trim()
    setEditingId(null)
    if (!trimmed) return
    onDataChange((prev) => applyScheduleEntryText(prev, id, trimmed))
  }

  const cancelEdit = (): void => {
    setEditingId(null)
  }

  const removeEntry = (id: string): void => {
    if (editingId === id) setEditingId(null)
    onDataChange((prev) => removeScheduleEntry(prev, id))
  }

  const onSplit = (id: string): void => {
    onDataChange((prev) => ({ ...prev, scheduleEntries: splitScheduleEntry(syncScheduleEntries(prev), id) }))
  }

  const addTask = (): void => {
    onDataChange((prev) => {
      const { data: next, entryId } = addScheduleTask(prev)
      window.setTimeout(() => {
        setEditingId(entryId)
        setEditDraft('New task')
      }, 0)
      return next
    })
  }

  const pool = entries.filter(wpEntryInPool)

  const chipProps = {
    editingId,
    editDraft,
    onEditDraftChange: setEditDraft,
    onCommitEdit: commitEdit,
    onCancelEdit: cancelEdit,
    onDoubleClick: startEdit
  }

  const timeAxis = (
    <div className="wp-cal-time-axis">
      {Array.from(
        { length: WP_SCHEDULE_END_HOUR - WP_SCHEDULE_START_HOUR + 1 },
        (_, i) => WP_SCHEDULE_START_HOUR + i
      ).map((h) => {
        const top =
          ((h * 60 - WP_SCHEDULE_START_HOUR * 60) /
            (WP_SCHEDULE_END_HOUR * 60 - WP_SCHEDULE_START_HOUR * 60)) *
          100
        return (
          <span key={h} style={{ top: `${top}%` }}>
            {String(h).padStart(2, '0')}:00
          </span>
        )
      })}
    </div>
  )

  const calendarLabel = weekLabel ?? isoWeek

  const calendarToolbar = (
    <div className="wp-sched-pool-toolbar">
      <button
        type="button"
        className="btn btn-icon btn-sm weekly-plan-create-btn wp-sched-add-btn"
        title="Add task"
        data-testid="weekly-plan-schedule-add"
        onClick={addTask}
      >
        +
      </button>
    </div>
  )

  const calendar = (
    <aside className="wp-schedule-preview">
      <div className="wp-schedule-preview-head">
        <div className="wp-schedule-preview-title">{calendarLabel}</div>
        {embedded ? calendarToolbar : null}
      </div>
        <div className="wp-cal-board">
          <div className="wp-cal-matrix">
            <div className="wp-cal-matrix-corner" />
            {WP_WEEK_DAYS.map((label) => (
              <div key={label} className="wp-cal-matrix-day-head">
                {label}
              </div>
            ))}
            <div className="wp-cal-matrix-unsched-label">Unscheduled</div>
            {WP_WEEK_DAYS.map((day) => (
              <UnscheduledDayCell
                key={`unsched-${day}`}
                day={day}
                dayUnsched={entries.filter((e) => wpEntryDayUnsched(e) && e.day === day)}
                dragOverKey={dragOver ?? ''}
                expanded={unschedExpanded}
                onToggleExpand={() => setUnschedExpanded((v) => !v)}
                editingId={editingId}
                editDraft={editDraft}
                onEditDraftChange={setEditDraft}
                onCommitEdit={commitEdit}
                onCancelEdit={cancelEdit}
                onStartEdit={startEdit}
                dragId={dragId}
                onPlaceEntry={placeEntry}
                onRemoveEntry={removeEntry}
                setDragOver={setDragOver}
                setDropPreviewSlot={setDropPreviewSlot}
              />
            ))}
            {timeAxis}
            {WP_WEEK_DAYS.map((day) => {
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
                    setDropPreviewSlot(wpSlotFromDropY(e.currentTarget, e.clientY))
                  }}
                  onDragLeave={() => {
                    setDragOver(null)
                    setDropPreviewSlot(null)
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragOver(null)
                    setDropPreviewSlot(null)
                    const id = e.dataTransfer.getData('text/wp-entry') || dragId.current
                    if (!id) return
                    const slot = wpSlotFromDropY(e.currentTarget, e.clientY)
                    placeEntry(id, day, slot)
                  }}
                >
                  {dragOver === key && dropPreviewSlot ? (
                    <TimelineDropPreview slot={dropPreviewSlot} />
                  ) : null}
                  {timed.map((e) => (
                    <CalBlock
                      key={e.id}
                      entry={e}
                      {...chipProps}
                      onDragStart={(id) => {
                        dragId.current = id
                      }}
                      onRemove={() => removeEntry(e.id)}
                      onResizeStart={(id, ev) => {
                        ev.preventDefault()
                        ev.stopPropagation()
                        const body = (ev.target as HTMLElement).closest('.wp-cal-matrix-timeline') as HTMLElement
                        const entry = entries.find((x) => x.id === id)
                        if (!entry || !body) return
                        const onMove = (ev2: MouseEvent): void => {
                          const endMin = wpSlotFromDropY(body, ev2.clientY)
                          const endParsed = wpSlotStartMinutes(endMin.split('–')[0] ?? '')
                          onDataChange((prev) => {
                            const copy = syncScheduleEntries(prev).map((x) => ({ ...x }))
                            const target = copy.find((x) => x.id === id)
                            if (target) wpSetSlotEnd(target, endParsed + 30)
                            return { ...prev, scheduleEntries: copy }
                          })
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
  )

  if (embedded) {
    return (
      <div className="wp-split is-schedule-step is-embedded" data-testid="weekly-plan-view-timeline">
        {calendar}
      </div>
    )
  }

  return (
    <div className="wp-split is-schedule-step">
      <div className="wp-split-main">
        <div className="wp-phase-label">Schedule</div>
        <h3 className="wp-title">Schedule the week</h3>
        {calendarToolbar}
        <div className="wp-inline-hint">
          Drag to a day&apos;s <strong>Unscheduled</strong> row or <strong>timeline</strong>. While dragging on
          the timeline, the dashed preview shows the <strong>time range</strong>. Drop on the pool to unassign.
          <strong> +</strong> adds a task. Double-click to edit; ✕ removes.
        </div>
        <div
          className={`wp-sched-left-pool${dragOver === 'pool' ? ' drag-over' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver('pool')
          }}
          onDragLeave={() => {
            setDragOver(null)
            setDropPreviewSlot(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(null)
            setDropPreviewSlot(null)
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
                        {...chipProps}
                        onDragStart={(id) => {
                          dragId.current = id
                        }}
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
                      <ScheduleRemoveButton onRemove={() => removeEntry(e.id)} />
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {calendar}
    </div>
  )
}
