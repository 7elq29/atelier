import { useEffect, useRef, useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
import { formatTaskEditBuffer } from '../../../../shared/task-priority'
import { priorityTimelineAccentClass } from '../../../../shared/task-priority'
import TaskMoveContextMenu from './TaskMoveContextMenu'
import type { MoveDateOptions } from './move-date-options'
import { buildTaskEditPatch, TaskEditInput } from './task-priority-ui'
import TaskTextDisplay from './TaskTextDisplay'
import { minutesToTime, parseTimeBlock } from './timeline-scale'

const NOW_POLL_MS = 30_000
const MEANINGFUL_GAP_MINUTES = 60

const AGENDA_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
const AGENDA_SLOT_H_PX = 36 // px per hour slot in the drag overlay grid

interface TimeEditState {
  taskId: string
  taskLabel: string
  startMin: number  // total minutes from midnight, snapped to 15
  durIdx: number
  x: number
  y: number
}
const DUR_STEPS_MIN = [15, 30, 45, 60, 75, 90, 105, 120, 150, 180, 210, 240]
const DUR_MAX_MIN = DUR_STEPS_MIN[DUR_STEPS_MIN.length - 1]
const DEFAULT_DUR_IDX = 1 // 30 min

interface AgendaTimelineProps {
  tasks: DailyTask[]
  onToggle: (id: string) => void
  onMoveToUnscheduled: (id: string) => void
  onDelete: (id: string) => void
  onUpdateText: (id: string, text: string) => void
  onUpdateTask: (id: string, patch: Partial<DailyTask>) => void
  moveDateOptions: MoveDateOptions
  onMoveToDate: (id: string, targetDate: string) => void
  onCreateSessionFromTask?: (task: DailyTask) => void
  /** Drop an unscheduled task onto the agenda; receives a computed timeBlock. */
  onDropExisting?: (id: string, timeBlock: string) => void
  /** Right-click create: receives task text and computed timeBlock. */
  onCreate?: (text: string, timeBlock: string) => void
}

interface PendingDrop {
  taskId: string
  taskLabel: string
  hour: number
  durIdx: number
  cardX: number
  cardY: number
}

interface PendingCreate {
  hour: number
  durIdx: number
  text: string
  cardX: number
  cardY: number
}

function minutesNow(): number {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

function formatClock(minutes: number): string {
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  const hour12 = hour % 12 || 12
  return `${hour12}:${String(minute).padStart(2, '0')}`
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`
}

function durDisplayParts(min: number): { num: string; unit: string } {
  if (min < 60) return { num: String(min), unit: 'min' }
  const h = Math.floor(min / 60), m = min % 60
  return { num: m ? `${h}:${String(m).padStart(2, '0')}` : String(h), unit: 'hr' }
}

/** Parse a human-typed time string into total minutes from midnight, or null on failure. */
function parseTimeInput(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  // "3:30 pm" / "3:30pm"
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/)
  if (m12) {
    let h = parseInt(m12[1]!, 10)
    const min = parseInt(m12[2]!, 10)
    if (m12[3] === 'pm' && h < 12) h += 12
    if (m12[3] === 'am' && h === 12) h = 0
    if (h < 0 || h > 23 || min < 0 || min > 59) return null
    return h * 60 + min
  }
  // "15:30" (24-hour)
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/)
  if (m24) {
    const h = parseInt(m24[1]!, 10)
    const min = parseInt(m24[2]!, 10)
    if (h < 0 || h > 23 || min < 0 || min > 59) return null
    return h * 60 + min
  }
  // "3 pm" / "3pm"
  const mHour = s.match(/^(\d{1,2})\s*(am|pm)$/)
  if (mHour) {
    let h = parseInt(mHour[1]!, 10)
    if (mHour[2] === 'pm' && h < 12) h += 12
    if (mHour[2] === 'am' && h === 12) h = 0
    if (h < 0 || h > 23) return null
    return h * 60
  }
  return null
}

function hourLabel(h: number): string {
  if (h === 12) return '12p'
  if (h === 0)  return '12a'
  return h < 12 ? `${h}a` : `${h - 12}p`
}

export default function AgendaTimeline({
  tasks,
  onToggle,
  onMoveToUnscheduled,
  onDelete,
  onUpdateText,
  onUpdateTask,
  moveDateOptions,
  onMoveToDate,
  onCreateSessionFromTask,
  onDropExisting,
  onCreate
}: AgendaTimelineProps): JSX.Element {
  const [nowMinutes, setNowMinutes] = useState(minutesNow)
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; taskId: string } | null>(null)
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameInputRef = useRef<HTMLTextAreaElement>(null)

  // Drag-over overlay state
  const [isDragOver, setIsDragOver] = useState(false)
  const [ghostHour, setGhostHour] = useState<number | null>(null)

  // Duration confirm card (for drops)
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null)

  // Right-click create draft
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null)
  const createCardRef  = useRef<HTMLDivElement>(null)
  const createInputRef = useRef<HTMLTextAreaElement | null>(null)

  // Time-edit popover (click on time label)
  const [timeEdit, setTimeEdit] = useState<TimeEditState | null>(null)
  const [timeEditStartText, setTimeEditStartText] = useState<string | null>(null)
  const timeEditRef = useRef<HTMLDivElement>(null)
  const timeEditStartRef = useRef<HTMLDivElement>(null)
  const timeEditStartInputRef = useRef<HTMLInputElement>(null)

  const agendaRef = useRef<HTMLDivElement>(null)
  const cardRef   = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const interval = setInterval(() => setNowMinutes(minutesNow()), NOW_POLL_MS)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (moveMenu && !tasks.some((task) => task.id === moveMenu.taskId)) setMoveMenu(null)
  }, [moveMenu, tasks])

  // Global wheel listener — active only while the duration card is open.
  // Fires regardless of cursor position so the user can scroll immediately
  // after the drop without needing to hover over the card.
  const pendingOpen = pendingDrop !== null
  useEffect(() => {
    if (!pendingOpen) return
    function onWheel(e: WheelEvent): void {
      e.preventDefault()
      setPendingDrop((prev) => {
        if (!prev) return null
        const next = Math.max(
          0,
          Math.min(DUR_STEPS_MIN.length - 1, prev.durIdx + (e.deltaY < 0 ? 1 : -1))
        )
        return { ...prev, durIdx: next }
      })
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [pendingOpen])

  // Click-outside to confirm
  useEffect(() => {
    if (!pendingOpen) return
    function onClick(e: MouseEvent): void {
      if (cardRef.current?.contains(e.target as Node)) return
      confirmDrop()
    }
    // Defer so the drop event itself doesn't immediately confirm
    const t = setTimeout(
      () => document.addEventListener('click', onClick, { capture: true }),
      80
    )
    return () => {
      clearTimeout(t)
      document.removeEventListener('click', onClick, { capture: true })
    }
  }, [pendingOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Wheel + click-outside for create draft card
  const createOpen = pendingCreate !== null
  useEffect(() => {
    if (!createOpen) return
    function onWheel(e: WheelEvent): void {
      e.preventDefault()
      setPendingCreate((prev) => {
        if (!prev) return null
        const next = Math.max(0, Math.min(DUR_STEPS_MIN.length - 1, prev.durIdx + (e.deltaY < 0 ? 1 : -1)))
        return { ...prev, durIdx: next }
      })
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [createOpen])

  useEffect(() => {
    if (!createOpen) return
    function onClick(e: MouseEvent): void {
      if (createCardRef.current?.contains(e.target as Node)) return
      setPendingCreate(null)
    }
    const t = setTimeout(
      () => document.addEventListener('click', onClick, { capture: true }),
      80
    )
    return () => {
      clearTimeout(t)
      document.removeEventListener('click', onClick, { capture: true })
    }
  }, [createOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  function hourFromClientY(clientY: number): number {
    const el = agendaRef.current
    if (!el) return 9
    const rect = el.getBoundingClientRect()
    const relY = Math.max(0, Math.min(rect.height, clientY - rect.top))
    const fraction = relY / rect.height
    const first = AGENDA_HOURS[0]!
    const last  = AGENDA_HOURS[AGENDA_HOURS.length - 1]! + 1
    const hour  = first + Math.floor(fraction * (last - first))
    return Math.max(first, Math.min(last - 1, hour))
  }

  function handleDragOver(e: React.DragEvent): void {
    if (!onDropExisting || pendingDrop) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
    setGhostHour(hourFromClientY(e.clientY))
  }

  function handleDragLeave(e: React.DragEvent): void {
    if (!agendaRef.current?.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
      setGhostHour(null)
    }
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault()
    setIsDragOver(false)
    if (!onDropExisting) return
    const id    = e.dataTransfer.getData('text/task-id')
    const label = e.dataTransfer.getData('text/task-label')
    if (!id) { setGhostHour(null); return }
    const hour = ghostHour ?? hourFromClientY(e.clientY)
    setGhostHour(null)
    setPendingDrop({
      taskId: id,
      taskLabel: label || 'Task',
      hour,
      durIdx: DEFAULT_DUR_IDX,
      cardX: e.clientX,
      cardY: e.clientY,
    })
  }

  function confirmDrop(): void {
    if (!pendingDrop || !onDropExisting) return
    const startMin  = pendingDrop.hour * 60
    const durMin    = DUR_STEPS_MIN[pendingDrop.durIdx]!
    const endMin    = startMin + durMin
    const timeBlock = `${minutesToTime(startMin)}-${minutesToTime(endMin)}`
    onDropExisting(pendingDrop.taskId, timeBlock)
    setPendingDrop(null)
  }

  function cancelDrop(): void {
    setPendingDrop(null)
  }

  // ── Time-edit popover ────────────────────────────────────────────────────

  const timeEditOpen = timeEdit !== null
  useEffect(() => {
    if (!timeEditOpen) return
    function onClick(e: MouseEvent): void {
      if (timeEditRef.current?.contains(e.target as Node)) return
      setTimeEdit(null)
      setTimeEditStartText(null)
    }
    const t = setTimeout(() => document.addEventListener('click', onClick, { capture: true }), 80)
    return () => { clearTimeout(t); document.removeEventListener('click', onClick, { capture: true }) }
  }, [timeEditOpen])

  useEffect(() => {
    if (!timeEditOpen) return
    function onWheel(e: WheelEvent): void {
      e.preventDefault()
      if (timeEditStartRef.current?.contains(e.target as Node)) {
        // Scroll on "starting" text → adjust start time ±15 min
        setTimeEdit((t) => {
          if (!t) return t
          const next = Math.max(0, Math.min(23 * 60 + 45, t.startMin + (e.deltaY < 0 ? 15 : -15)))
          return { ...t, startMin: next }
        })
      } else {
        // Scroll elsewhere in card → adjust duration
        setTimeEdit((t) =>
          t ? { ...t, durIdx: Math.max(0, Math.min(DUR_STEPS_MIN.length - 1, t.durIdx + (e.deltaY < 0 ? 1 : -1))) } : t
        )
      }
    }
    window.addEventListener('wheel', onWheel, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', onWheel, { capture: true })
  }, [timeEditOpen])

  function openTimeEdit(event: React.MouseEvent, task: DailyTask, start: number, end: number): void {
    event.stopPropagation()
    const snappedStart = Math.round(start / 15) * 15
    const durMin = end - start
    const durIdx = DUR_STEPS_MIN.reduce(
      (best, v, i) => Math.abs(v - durMin) < Math.abs(DUR_STEPS_MIN[best]! - durMin) ? i : best,
      DEFAULT_DUR_IDX
    )
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    setTimeEditStartText(null)
    setTimeEdit({ taskId: task.id, taskLabel: task.text, startMin: snappedStart, durIdx, x: rect.left, y: rect.bottom + 6 })
    setPendingDrop(null)
    setPendingCreate(null)
  }

  function commitTimeEdit(): void {
    if (!timeEdit) return
    const durMin = DUR_STEPS_MIN[timeEdit.durIdx]!
    const endMin = timeEdit.startMin + durMin
    onUpdateTask(timeEdit.taskId, { timeBlock: `${minutesToTime(timeEdit.startMin)}-${minutesToTime(endMin)}` })
    setTimeEdit(null)
    setTimeEditStartText(null)
  }

  function commitStartText(): void {
    if (timeEditStartText === null) return
    const parsed = parseTimeInput(timeEditStartText)
    if (parsed !== null) {
      setTimeEdit((t) => t ? { ...t, startMin: parsed } : t)
    }
    setTimeEditStartText(null)
  }

  function commitCreate(parsed?: { text: string }): void {
    if (!pendingCreate || !onCreate) return
    const text = (parsed?.text ?? pendingCreate.text).trim()
    if (text) {
      const startMin  = pendingCreate.hour * 60
      const durMin    = DUR_STEPS_MIN[pendingCreate.durIdx]!
      const endMin    = startMin + durMin
      onCreate(text, `${minutesToTime(startMin)}-${minutesToTime(endMin)}`)
    }
    setPendingCreate(null)
  }

  function handleContextMenu(e: React.MouseEvent): void {
    if (!onCreate) return
    e.preventDefault()
    if ((e.target as Element).closest('.dn-agenda-entry')) return
    setPendingDrop(null)
    const hour = hourFromClientY(e.clientY)
    setPendingCreate({ hour, durIdx: DEFAULT_DUR_IDX, text: '', cardX: e.clientX, cardY: e.clientY })
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  const entries = tasks
    .map((task) => {
      const block = parseTimeBlock(task.timeBlock)
      return block ? { task, ...block } : null
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort((a, b) => a.start - b.start)

  function startRename(task: DailyTask): void {
    setRenameText(formatTaskEditBuffer(task))
    setRenamingTaskId(task.id)
  }

  function commitRename(
    taskId: string,
    parsed: {
      text: string
      priority?: string
      priorityTouched: boolean
      externalLinks: DailyTask['externalLinks']
    }
  ): void {
    const task = tasks.find((candidate) => candidate.id === taskId)
    if (!task) { setRenamingTaskId(null); return }
    const patch = buildTaskEditPatch(task, parsed)
    if (Object.keys(patch).length > 0) onUpdateTask(taskId, patch)
    else if (parsed.text.trim()) onUpdateText(taskId, parsed.text.trim())
    setRenamingTaskId(null)
  }

  // Ghost label for the drag overlay
  const ghostH12 = ghostHour !== null ? (ghostHour % 12 || 12) : 0
  const ghostSuf = ghostHour !== null ? (ghostHour < 12 ? 'am' : 'pm') : ''

  // Duration card derived values
  const durMin      = pendingDrop ? DUR_STEPS_MIN[pendingDrop.durIdx]! : 30
  const { num: durNum, unit: durUnit } = durDisplayParts(durMin)
  const pct         = durMin / DUR_MAX_MIN
  const R           = 28
  const CIRC        = 2 * Math.PI * R
  const dashOffset  = CIRC * (1 - pct)
  const isLong      = pct > 0.75

  // Drop card clamped position
  let cardLeft = 0, cardTop = 0
  if (pendingDrop) {
    cardLeft = Math.min(pendingDrop.cardX + 16, window.innerWidth  - 188)
    cardTop  = Math.max(8, Math.min(pendingDrop.cardY - 80,  window.innerHeight - 300))
  }

  // Create card derived values (separate durIdx from drop)
  const createDurMin = pendingCreate ? DUR_STEPS_MIN[pendingCreate.durIdx]! : 30
  const { num: createDurNum, unit: createDurUnit } = durDisplayParts(createDurMin)
  const createPct        = createDurMin / DUR_MAX_MIN
  const createDashOffset = CIRC * (1 - createPct)
  const createIsLong     = createPct > 0.75
  let createCardLeft = 0, createCardTop = 0
  if (pendingCreate) {
    createCardLeft = Math.min(pendingCreate.cardX + 16, window.innerWidth  - 220)
    createCardTop  = Math.max(8, Math.min(pendingCreate.cardY - 80,  window.innerHeight - 340))
  }

  // Time-edit card derived values
  const teDurMin      = timeEdit ? DUR_STEPS_MIN[timeEdit.durIdx]! : 30
  const { num: teDurNum, unit: teDurUnit } = durDisplayParts(teDurMin)
  const tePct         = teDurMin / DUR_MAX_MIN
  const teDashOffset  = CIRC * (1 - tePct)
  const teIsLong      = tePct > 0.75
  const teHour        = timeEdit ? Math.floor(timeEdit.startMin / 60) : 0
  const teHour12      = (teHour % 12) || 12
  const teMinute      = timeEdit ? timeEdit.startMin % 60 : 0
  const teSuffix      = teHour < 12 ? 'am' : 'pm'

  let nowPlaced = false

  return (
    <div
      ref={agendaRef}
      className={`dn-agenda${isDragOver ? ' dn-agenda--drag-over' : ''}`}
      data-testid="timeline-agenda"
      onContextMenu={onCreate ? handleContextMenu : undefined}
      onDragOver={onDropExisting ? handleDragOver : undefined}
      onDragLeave={onDropExisting ? handleDragLeave : undefined}
      onDrop={onDropExisting ? handleDrop : undefined}
    >
      {/* ── Drop insertion line (shown while dragging) ── */}
      {/* ── Time grid overlay (shown while dragging) ── */}
      {isDragOver && (
        <div
          className="dn-agenda-overlay"
          style={{ height: AGENDA_HOURS.length * AGENDA_SLOT_H_PX }}
          aria-hidden="true"
        >
          {/* Hour grid lines */}
          {AGENDA_HOURS.map((h) => (
            <div key={h} className="dn-agenda-overlay-slot">
              <span className="dn-agenda-overlay-label">
                {h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`}
              </span>
              <span className="dn-agenda-overlay-line" />
            </div>
          ))}
          {/* Existing tasks rendered at their correct time positions */}
          {entries.map(({ task, start, end }) => {
            const topH = start / 60
            const durH = (end - start) / 60
            const topPx = (topH - AGENDA_HOURS[0]!) * AGENDA_SLOT_H_PX
            const heightPx = Math.max(durH * AGENDA_SLOT_H_PX, 8)
            if (topPx < 0 || topPx > AGENDA_HOURS.length * AGENDA_SLOT_H_PX) return null
            return (
              <div
                key={task.id}
                className="dn-agenda-overlay-task"
                style={{ top: topPx, height: heightPx }}
              >
                {task.text}
              </div>
            )
          })}
          {/* Ghost block for the task being dropped */}
          {ghostHour !== null && (
            <div
              className="dn-agenda-ghost"
              style={{ top: AGENDA_HOURS.indexOf(ghostHour) * AGENDA_SLOT_H_PX }}
              data-testid="agenda-drag-ghost"
            >
              <span className="dn-agenda-ghost-label">
                {`${ghostH12}:00 ${ghostSuf}`}
                {' — '}
                {(() => {
                  const nextH = ghostHour + 1
                  const h12 = nextH % 12 || 12
                  const suf = nextH < 12 ? 'am' : 'pm'
                  return `${h12}:00 ${suf}`
                })()}
              </span>
            </div>
          )}
        </div>
      )}

      {/* ── Agenda entries ── */}
      {entries.map(({ task, start, end }, index) => {
        const next = entries[index + 1]
        const showNowBefore = !nowPlaced && nowMinutes <= start
        if (showNowBefore) nowPlaced = true
        const gapMinutes = next ? next.start - end : 0

        return (
          <div className="dn-agenda-entry-wrap" key={task.id}>
            {showNowBefore && (
              <div className="dn-agenda-now" data-testid="agenda-current-time">
                <span>Now</span>
                <i />
              </div>
            )}
            <div
              className={`dn-agenda-entry${task.status === 'done' ? ' done' : ''}${
                task.isNote ? ' meeting' : ''
              }${priorityTimelineAccentClass(task.priority)}`}
              data-testid="agenda-task"
              data-task-id={task.id}
              draggable={renamingTaskId !== task.id}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/task-id', task.id)
                event.dataTransfer.setData('text/task-label', task.text)
                event.dataTransfer.effectAllowed = 'move'
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                setMoveMenu({ x: event.clientX, y: event.clientY, taskId: task.id })
              }}
            >
              <span
                className="dn-agenda-time dn-agenda-time--editable"
                title="Click to edit time"
                onClick={(e) => openTimeEdit(e, task, start, end)}
              >{formatClock(start)}</span>
              {!task.isNote ? (
                <button
                  type="button"
                  className="dn-tbox"
                  data-testid="agenda-task-toggle"
                  onClick={(event) => { event.stopPropagation(); onToggle(task.id) }}
                  aria-label={task.status === 'done' ? 'Mark task incomplete' : 'Mark task complete'}
                />
              ) : (
                <span className="dn-agenda-meeting-dot" aria-hidden="true" />
              )}
              <div
                className="dn-agenda-task-main"
                onDoubleClick={(event) => { event.stopPropagation(); startRename(task) }}
              >
                {renamingTaskId === task.id ? (
                  <div className="dn-task-input-wrap" onMouseDown={(event) => event.stopPropagation()}>
                    <TaskEditInput
                      autoFocus
                      deferFocus
                      value={renameText}
                      onChange={setRenameText}
                      onCommit={(parsed) => commitRename(task.id, parsed)}
                      onCancel={() => setRenamingTaskId(null)}
                      inputRef={renameInputRef}
                      className="dn-task-edit-input"
                      testId="agenda-task-edit-input"
                    />
                  </div>
                ) : (
                  <span className="dn-agenda-label">
                    <TaskTextDisplay task={task} />
                  </span>
                )}
              </div>
              <span className={`dn-agenda-duration${priorityTimelineAccentClass(task.priority) ? ' dn-agenda-duration--hi-pri' : ''}`}>{formatDuration(end - start)}</span>
              <button
                type="button"
                className="btn btn-icon btn-sm dn-agenda-delete"
                data-testid="agenda-task-delete"
                title="Delete task"
                onClick={(event) => { event.stopPropagation(); onDelete(task.id) }}
              >
                ×
              </button>
            </div>
            {gapMinutes >= MEANINGFUL_GAP_MINUTES && (
              <div className="dn-agenda-gap" data-testid="agenda-free-gap">
                <span />
                <em>{formatDuration(gapMinutes)} free</em>
              </div>
            )}
          </div>
        )
      })}

      {/* Pending drop preview row */}
      {pendingDrop && (
        <div className="dn-agenda-entry-wrap dn-agenda-entry-wrap--pending">
          <div className="dn-agenda-entry dn-agenda-entry--pending">
            <span className="dn-agenda-time">{formatClock(pendingDrop.hour * 60)}</span>
            <span className="dn-agenda-dot-pending" aria-hidden="true" />
            <div className="dn-agenda-task-main">
              <span className="dn-agenda-label">{pendingDrop.taskLabel}</span>
            </div>
            <span className="dn-agenda-duration">{formatDuration(DUR_STEPS_MIN[pendingDrop.durIdx]!)}</span>
          </div>
        </div>
      )}

      {!nowPlaced && entries.length > 0 && nowMinutes > entries[entries.length - 1]!.end && (
        <div className="dn-agenda-now dn-agenda-now--after" data-testid="agenda-current-time">
          <span>Now</span>
          <i />
        </div>
      )}
      {entries.length === 0 && !pendingDrop && (
        <div className="dn-agenda-empty">No scheduled tasks yet.</div>
      )}

      {moveMenu && (
        <TaskMoveContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          options={moveDateOptions}
          onSelect={(targetDate) => onMoveToDate(moveMenu.taskId, targetDate)}
          onRename={() => {
            const task = tasks.find((candidate) => candidate.id === moveMenu.taskId)
            if (task) startRename(task)
          }}
          onMoveToUnscheduled={() => onMoveToUnscheduled(moveMenu.taskId)}
          onCreateSession={
            onCreateSessionFromTask
              ? () => {
                  const task = tasks.find((candidate) => candidate.id === moveMenu.taskId)
                  if (task) onCreateSessionFromTask(task)
                }
              : undefined
          }
          onClose={() => setMoveMenu(null)}
        />
      )}

      {/* ── Duration confirm card ── */}
      {pendingDrop && (
        <div
          ref={cardRef}
          className="dn-dur-card"
          style={{ left: cardLeft, top: cardTop }}
          tabIndex={-1}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); confirmDrop() }
            if (e.key === 'Escape') { e.preventDefault(); cancelDrop() }
            if (e.key === 'ArrowUp')   { e.preventDefault(); setPendingDrop(p => p ? { ...p, durIdx: Math.min(DUR_STEPS_MIN.length - 1, p.durIdx + 1) } : p) }
            if (e.key === 'ArrowDown') { e.preventDefault(); setPendingDrop(p => p ? { ...p, durIdx: Math.max(0, p.durIdx - 1) } : p) }
          }}
        >
          <div className="dn-dur-card-task">{pendingDrop.taskLabel}</div>
          <div className="dn-dur-card-at">
            {`starting ${formatClock(pendingDrop.hour * 60)} ${pendingDrop.hour < 12 ? 'am' : 'pm'}`}
          </div>

          {/* Arc ring */}
          <svg
            className="dn-dur-card-ring"
            width="68" height="68" viewBox="0 0 68 68"
            aria-hidden="true"
          >
            <circle cx="34" cy="34" r={R} className="dn-dur-ring-bg" />
            <circle
              cx="34" cy="34" r={R}
              className="dn-dur-ring-fill"
              style={{
                stroke: isLong ? 'var(--warning, #f0a05b)' : 'var(--accent)',
                strokeDasharray: CIRC,
                strokeDashoffset: dashOffset,
                transform: 'rotate(-90deg)',
                transformOrigin: '34px 34px',
              }}
            />
          </svg>

          {/* Big duration number */}
          <div className="dn-dur-card-value">
            <span
              className="dn-dur-card-num"
              style={{ color: isLong ? 'var(--warning, #f0a05b)' : undefined }}
            >
              {durNum}
            </span>
            <span className="dn-dur-card-unit">{durUnit}</span>
          </div>

          {/* Scroll hint */}
          <div className="dn-dur-card-hint">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <rect x="5" y="2" width="6" height="10" rx="3"/>
              <line x1="8" y1="5" x2="8" y2="7"/>
            </svg>
            scroll to adjust
          </div>

          <div className="dn-dur-card-confirm">click anywhere to confirm</div>
        </div>
      )}

      {/* ── Right-click create card ── */}
      {pendingCreate && (
        <div
          ref={createCardRef}
          className="dn-dur-card dn-create-card"
          style={{ left: createCardLeft, top: createCardTop }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); setPendingCreate(null) }
            if (e.key === 'ArrowUp')   { e.preventDefault(); setPendingCreate(p => p ? { ...p, durIdx: Math.min(DUR_STEPS_MIN.length - 1, p.durIdx + 1) } : p) }
            if (e.key === 'ArrowDown') { e.preventDefault(); setPendingCreate(p => p ? { ...p, durIdx: Math.max(0, p.durIdx - 1) } : p) }
          }}
        >
          <div className="dn-create-card-input-wrap">
            <TaskEditInput
              autoFocus
              deferFocus
              inputRef={createInputRef}
              className="dn-create-card-input"
              testId="agenda-create-input"
              value={pendingCreate.text}
              onChange={(text) => setPendingCreate(p => p ? { ...p, text } : p)}
              onCommit={commitCreate}
              onCancel={() => setPendingCreate(null)}
              blurPolicy="nonEmpty"
            />
          </div>
          <div className="dn-dur-card-at">
            {`starting ${formatClock(pendingCreate.hour * 60)} ${pendingCreate.hour < 12 ? 'am' : 'pm'}`}
          </div>

          <svg
            className="dn-dur-card-ring"
            width="68" height="68" viewBox="0 0 68 68"
            aria-hidden="true"
          >
            <circle cx="34" cy="34" r={R} className="dn-dur-ring-bg" />
            <circle
              cx="34" cy="34" r={R}
              className="dn-dur-ring-fill"
              style={{
                stroke: createIsLong ? 'var(--warning, #f0a05b)' : 'var(--accent)',
                strokeDasharray: CIRC,
                strokeDashoffset: createDashOffset,
                transform: 'rotate(-90deg)',
                transformOrigin: '34px 34px',
              }}
            />
          </svg>

          <div className="dn-dur-card-value">
            <span
              className="dn-dur-card-num"
              style={{ color: createIsLong ? 'var(--warning, #f0a05b)' : undefined }}
            >
              {createDurNum}
            </span>
            <span className="dn-dur-card-unit">{createDurUnit}</span>
          </div>

          <div className="dn-dur-card-hint">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <rect x="5" y="2" width="6" height="10" rx="3"/>
              <line x1="8" y1="5" x2="8" y2="7"/>
            </svg>
            scroll to adjust
          </div>

          <div className="dn-dur-card-confirm">Enter to create · Esc to cancel</div>
        </div>
      )}

      {/* ── Time-edit card (same visual as drop/create cards) ── */}
      {timeEdit && (
        <div
          ref={timeEditRef}
          className="dn-dur-card"
          style={{
            left: Math.min(timeEdit.x, window.innerWidth - 220),
            top: Math.min(timeEdit.y, window.innerHeight - 320),
          }}
          tabIndex={-1}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Escape') { e.preventDefault(); setTimeEdit(null) }
            if (e.key === 'Enter')  { e.preventDefault(); commitTimeEdit() }
          }}
        >
          <div className="dn-dur-card-task">{timeEdit.taskLabel}</div>

          {/* "starting X:XX pm" — click to type, scroll to nudge ±15 min */}
          {timeEditStartText !== null ? (
            <input
              ref={timeEditStartInputRef}
              className="dn-dur-card-start-input"
              value={timeEditStartText}
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              onChange={(e) => setTimeEditStartText(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter')  { e.preventDefault(); commitStartText() }
                if (e.key === 'Escape') { e.preventDefault(); setTimeEditStartText(null) }
              }}
              onBlur={commitStartText}
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : (
            <div
              ref={timeEditStartRef}
              className="dn-dur-card-at dn-dur-card-at--editable"
              title="Click to type or scroll to nudge ±15 min"
              onClick={() =>
                setTimeEditStartText(`${teHour12}:${String(teMinute).padStart(2, '0')} ${teSuffix}`)
              }
            >
              {`starting ${teHour12}:${String(teMinute).padStart(2, '0')} ${teSuffix}`}
            </div>
          )}

          {/* Arc ring (duration) */}
          <svg
            className="dn-dur-card-ring"
            width="68" height="68" viewBox="0 0 68 68"
            aria-hidden="true"
          >
            <circle cx="34" cy="34" r={R} className="dn-dur-ring-bg" />
            <circle
              cx="34" cy="34" r={R}
              className="dn-dur-ring-fill"
              style={{
                stroke: teIsLong ? 'var(--warning, #f0a05b)' : 'var(--accent)',
                strokeDasharray: CIRC,
                strokeDashoffset: teDashOffset,
                transform: 'rotate(-90deg)',
                transformOrigin: '34px 34px',
              }}
            />
          </svg>

          <div className="dn-dur-card-value">
            <span
              className="dn-dur-card-num"
              style={{ color: teIsLong ? 'var(--warning, #f0a05b)' : undefined }}
            >
              {teDurNum}
            </span>
            <span className="dn-dur-card-unit">{teDurUnit}</span>
          </div>

          <div className="dn-dur-card-hint">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"
              stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <rect x="5" y="2" width="6" height="10" rx="3"/>
              <line x1="8" y1="5" x2="8" y2="7"/>
            </svg>
            scroll to adjust
          </div>

          <div className="dn-dur-card-confirm">Enter to save · Esc to cancel</div>
        </div>
      )}
    </div>
  )
}
