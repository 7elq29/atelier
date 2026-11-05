import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
import { isDailyNoteBulletFromTags, parseInlineTagsFromTaskText } from '../../../../shared/daily-note-tags'
import {
  formatDurationPhrase,
  formatStartPhrase,
  formatTaskNl,
  nearestDurIdx,
  NL_DUR_STEPS_MIN,
  parseTaskNl,
  replaceNlEntity,
  type NlEntityKind,
} from '../../../../shared/task-nl-parse'
import { formatTaskEditBuffer } from '../../../../shared/task-priority'
import { priorityTimelineAccentClass } from '../../../../shared/task-priority'
import AgendaNlCreateCard from './AgendaNlCreateCard'
import MeetingGlyph from './MeetingGlyph'
import NlAnnotatedInput from './NlAnnotatedInput'
import NlDurationPopover from './NlDurationPopover'
import NlTimePopover from './NlTimePopover'
import TaskMoveContextMenu from './TaskMoveContextMenu'
import type { MoveDateOptions } from './move-date-options'
import { buildTaskEditPatch, TaskEditInput } from './task-priority-ui'
import TaskTextDisplay from './TaskTextDisplay'
import { minutesToTime, parseTimeBlock, snapMinutes } from './timeline-scale'

const NOW_POLL_MS = 30_000
const MEANINGFUL_GAP_MINUTES = 60

const AGENDA_HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]
const AGENDA_START_MIN = AGENDA_HOURS[0]! * 60
const AGENDA_END_MIN = (AGENDA_HOURS[AGENDA_HOURS.length - 1]! + 1) * 60
const AGENDA_SLOT_H_PX = 36 // px per hour slot in the drag overlay grid
const AGENDA_SNAP_MIN = 15

/** Fast path: time/duration popover on an agenda row without opening the NL editor. */
interface FastPopState {
  taskId: string
  kind: 'time' | 'duration'
  startMin: number
  durIdx: number
  /** Snapshot for Esc cancel */
  origStartMin: number
  origDurIdx: number
  anchor: DOMRect
}

/** Full NL sentence edit for an existing scheduled task. */
interface NlEditState {
  taskId: string
  text: string
  startMin: number
  durIdx: number
  entityPop: { kind: NlEntityKind; anchor: DOMRect } | null
}

const DUR_STEPS_MIN = [...NL_DUR_STEPS_MIN]
const DUR_MAX_MIN = DUR_STEPS_MIN[DUR_STEPS_MIN.length - 1]!
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
  /** Increment to imperatively open the create card (e.g. from command palette). */
  requestCreate?: number
}

interface PendingDrop {
  taskId: string
  taskLabel: string
  startMin: number  // minutes from midnight, 15-min resolution
  durIdx: number
  cardX: number
  cardY: number
}

interface PendingCreate {
  startMin: number  // minutes from midnight, 15-min resolution
  durIdx: number
  text: string
  cardX: number
  cardY: number
  noTime?: boolean  // if true, create as unscheduled task (no timeBlock)
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
  onCreate,
  requestCreate
}: AgendaTimelineProps): JSX.Element {
  const [nowMinutes, setNowMinutes] = useState(minutesNow)
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; taskId: string } | null>(null)
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameInputRef = useRef<HTMLTextAreaElement>(null)

  // Drag-over overlay state
  const [isDragOver, setIsDragOver] = useState(false)
  const [ghostStartMin, setGhostStartMin] = useState<number | null>(null)

  // Dynamic slot height: recomputed after the CSS :has() rules expand the
  // timeline section (Trackers hides, more flex space is available). Using a
  // ref for minutesFromClientY (avoids stale closures) + state for JSX renders.
  const slotHRef = useRef(AGENDA_SLOT_H_PX)
  const [slotH, setSlotH] = useState(AGENDA_SLOT_H_PX)
  useLayoutEffect(() => {
    const el = agendaRef.current
    if (!el) return
    if (isDragOver) {
      const h = el.clientHeight
      const computed = h > 0 ? Math.max(AGENDA_SLOT_H_PX, h / AGENDA_HOURS.length) : AGENDA_SLOT_H_PX
      slotHRef.current = computed
      setSlotH(computed)
    } else {
      slotHRef.current = AGENDA_SLOT_H_PX
      setSlotH(AGENDA_SLOT_H_PX)
    }
  }, [isDragOver])

  // Duration confirm card (for drops)
  const [pendingDrop, setPendingDrop] = useState<PendingDrop | null>(null)
  const dropStartRef = useRef<HTMLDivElement>(null)

  // Right-click create draft (NL sentence card)
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null)
  const createCardRef = useRef<HTMLDivElement>(null)

  // Fast time/duration popover on agenda row
  const [fastPop, setFastPop] = useState<FastPopState | null>(null)
  /** Brief shield after popover close so a trailing click cannot hit Delete. */
  const [rowClickShield, setRowClickShield] = useState(false)
  const rowClickShieldRef = useRef(false)
  const rowClickShieldTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const commitFastPopRef = useRef<() => void>(() => {})

  // Full NL edit of existing task (double-click title)
  const [nlEdit, setNlEdit] = useState<NlEditState | null>(null)
  const nlEditRef = useRef<NlEditState | null>(null)
  nlEditRef.current = nlEdit

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
      if (dropStartRef.current?.contains(e.target as Node)) {
        // Scroll on "starting" → nudge start ±15 min (same as create/time-edit cards)
        setPendingDrop((prev) => {
          if (!prev) return null
          const next = Math.max(
            AGENDA_START_MIN,
            Math.min(AGENDA_END_MIN - DUR_STEPS_MIN[prev.durIdx]!, prev.startMin + (e.deltaY < 0 ? AGENDA_SNAP_MIN : -AGENDA_SNAP_MIN))
          )
          return { ...prev, startMin: next }
        })
      } else {
        setPendingDrop((prev) => {
          if (!prev) return null
          const next = Math.max(
            0,
            Math.min(DUR_STEPS_MIN.length - 1, prev.durIdx + (e.deltaY < 0 ? 1 : -1))
          )
          return { ...prev, durIdx: next }
        })
      }
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

  // Click-outside dismisses empty create draft (non-empty kept until Enter / Esc)
  const createOpen = pendingCreate !== null
  useEffect(() => {
    if (!createOpen) return
    function onClick(e: MouseEvent): void {
      const t = e.target as Node
      if (createCardRef.current?.contains(t)) return
      if ((t as Element).closest?.('.dn-nl-time-pop, .dn-nl-dur-pop')) return
      setPendingCreate(null)
    }
    const timer = setTimeout(
      () => document.addEventListener('mousedown', onClick, { capture: true }),
      80
    )
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', onClick, { capture: true })
    }
  }, [createOpen])

  // Open create card when triggered from command palette.
  // noTime: without a typed clock/duration, commit as unscheduled (not the
  // seed hour). Right-click create keeps noTime unset so the click slot wins.
  useEffect(() => {
    if (!requestCreate || !onCreate) return
    const currentHour: number = new Date().getHours()
    const nowH = Math.max(6, Math.min(21, currentHour))
    setPendingDrop(null)
    setFastPop(null)
    setNlEdit(null)
    setPendingCreate({
      startMin: nowH * 60,
      durIdx: DEFAULT_DUR_IDX,
      text: '',
      cardX: Math.max(8, window.innerWidth / 2 - 200),
      cardY: Math.max(8, window.innerHeight / 2 - 80),
      noTime: true,
    })
  }, [requestCreate]) // eslint-disable-line react-hooks/exhaustive-deps

  function minutesFromClientY(clientY: number): number {
    const el = agendaRef.current
    if (!el) return AGENDA_START_MIN
    const rect = el.getBoundingClientRect()
    const relY = Math.max(0, clientY - rect.top)
    // Use slotHRef (always current) so the minute maps correctly whether the
    // overlay is at the fixed 36px pitch or the expanded dynamic pitch.
    const rawMin = AGENDA_START_MIN + (relY / slotHRef.current) * 60
    const snapped = snapMinutes(rawMin)
    const maxStart = AGENDA_END_MIN - DUR_STEPS_MIN[DEFAULT_DUR_IDX]!
    return Math.max(AGENDA_START_MIN, Math.min(maxStart, snapped))
  }

  function handleDragOver(e: React.DragEvent): void {
    if (!onDropExisting || pendingDrop) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
    setGhostStartMin(minutesFromClientY(e.clientY))
  }

  function handleDragLeave(e: React.DragEvent): void {
    if (!agendaRef.current?.contains(e.relatedTarget as Node)) {
      setIsDragOver(false)
      setGhostStartMin(null)
    }
  }

  function handleDrop(e: React.DragEvent): void {
    e.preventDefault()
    setIsDragOver(false)
    if (!onDropExisting) return
    const id    = e.dataTransfer.getData('text/task-id')
    const label = e.dataTransfer.getData('text/task-label')
    if (!id) { setGhostStartMin(null); return }
    const startMin = ghostStartMin ?? minutesFromClientY(e.clientY)
    setGhostStartMin(null)
    setPendingDrop({
      taskId: id,
      taskLabel: label || 'Task',
      startMin,
      durIdx: DEFAULT_DUR_IDX,
      cardX: e.clientX,
      cardY: e.clientY,
    })
  }

  function confirmDrop(): void {
    if (!pendingDrop || !onDropExisting) return
    const startMin  = pendingDrop.startMin
    const durMin    = DUR_STEPS_MIN[pendingDrop.durIdx]!
    const endMin    = startMin + durMin
    const timeBlock = `${minutesToTime(startMin)}-${minutesToTime(endMin)}`
    onDropExisting(pendingDrop.taskId, timeBlock)
    setPendingDrop(null)
  }

  function cancelDrop(): void {
    setPendingDrop(null)
  }

  // ── Fast time / duration popover on agenda row ───────────────────────────

  const fastPopRef = useRef<FastPopState | null>(null)
  fastPopRef.current = fastPop

  function armRowClickShield(): void {
    rowClickShieldRef.current = true
    setRowClickShield(true)
    if (rowClickShieldTimer.current) clearTimeout(rowClickShieldTimer.current)
    rowClickShieldTimer.current = setTimeout(() => {
      rowClickShieldRef.current = false
      setRowClickShield(false)
      rowClickShieldTimer.current = null
    }, 400)
  }

  function commitFastPop(): void {
    const pop = fastPopRef.current
    if (!pop) return
    // Arm before clearing so a same-tick fallthrough click cannot Delete.
    armRowClickShield()
    fastPopRef.current = null
    const durMin = DUR_STEPS_MIN[pop.durIdx]!
    const endMin = pop.startMin + durMin
    onUpdateTask(pop.taskId, {
      timeBlock: `${minutesToTime(pop.startMin)}-${minutesToTime(endMin)}`,
    })
    setFastPop(null)
  }
  commitFastPopRef.current = commitFastPop

  function cancelFastPop(): void {
    armRowClickShield()
    fastPopRef.current = null
    setFastPop(null)
  }

  function openFastPop(
    event: React.MouseEvent,
    task: DailyTask,
    start: number,
    end: number,
    kind: 'time' | 'duration'
  ): void {
    event.stopPropagation()
    const snappedStart = Math.round(start / 15) * 15
    const durIdx = nearestDurIdx(end - start, DUR_STEPS_MIN)
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    setPendingDrop(null)
    setPendingCreate(null)
    setNlEdit(null)
    setFastPop({
      taskId: task.id,
      kind,
      startMin: snappedStart,
      durIdx,
      origStartMin: snappedStart,
      origDurIdx: durIdx,
      anchor: rect,
    })
  }

  function startNlEdit(task: DailyTask, start: number, end: number): void {
    const durMin = end - start
    const durIdx = nearestDurIdx(durMin, DUR_STEPS_MIN)
    setFastPop(null)
    setPendingCreate(null)
    setPendingDrop(null)
    setRenamingTaskId(null)
    setNlEdit({
      taskId: task.id,
      text: formatTaskNl({
        title: task.text,
        tags: task.tags,
        startMin: start,
        durationMin: durMin,
      }),
      startMin: Math.round(start / 15) * 15,
      durIdx,
      entityPop: null,
    })
  }

  function commitNlEdit(): void {
    if (!nlEdit) return
    const parsed = parseTaskNl(nlEdit.text)
    const content = parsed.content.trim()
    if (!content) {
      setNlEdit(null)
      return
    }
    const tagParsed = parseInlineTagsFromTaskText(content)
    const startMin = parsed.startMin ?? nlEdit.startMin
    const durMin = parsed.durationMin ?? DUR_STEPS_MIN[nlEdit.durIdx]!
    const endMin = startMin + durMin
    const task = tasks.find((t) => t.id === nlEdit.taskId)
    onUpdateTask(nlEdit.taskId, {
      text: tagParsed.text.trim() || content,
      tags: tagParsed.tags.length ? tagParsed.tags : (task?.tags ?? []),
      isNote: isDailyNoteBulletFromTags(tagParsed.tags.length ? tagParsed.tags : (task?.tags ?? [])),
      timeBlock: `${minutesToTime(startMin)}-${minutesToTime(endMin)}`,
    })
    setNlEdit(null)
  }

  function handleContextMenu(e: React.MouseEvent): void {
    if (!onCreate) return
    e.preventDefault()
    if ((e.target as Element).closest('.dn-agenda-entry')) return
    setPendingDrop(null)
    setFastPop(null)
    setNlEdit(null)
    const startMin = minutesFromClientY(e.clientY)
    setPendingCreate({
      startMin,
      durIdx: DEFAULT_DUR_IDX,
      text: '',
      cardX: e.clientX,
      cardY: e.clientY,
    })
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
  const ghostDurMin = DUR_STEPS_MIN[DEFAULT_DUR_IDX]!
  const ghostEndMin = ghostStartMin !== null ? ghostStartMin + ghostDurMin : 0
  const ghostHour = ghostStartMin !== null ? Math.floor(ghostStartMin / 60) : null
  const ghostH12 = ghostHour !== null ? (ghostHour % 12 || 12) : 0
  const ghostMinute = ghostStartMin !== null ? ghostStartMin % 60 : 0
  const ghostTopPx =
    ghostStartMin !== null ? ((ghostStartMin / 60) - AGENDA_HOURS[0]!) * slotH : 0
  const ghostHeightPx = (ghostDurMin / 60) * slotH

  // Duration card derived values
  const durMin      = pendingDrop ? DUR_STEPS_MIN[pendingDrop.durIdx]! : 30
  const dropStartHour = pendingDrop ? Math.floor(pendingDrop.startMin / 60) : 0
  const dropStartSuf = dropStartHour < 12 ? 'am' : 'pm'
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

  let nowPlaced = false

  return (
    <div
      ref={agendaRef}
      className={`dn-agenda${isDragOver ? ' dn-agenda--drag-over' : ''}${fastPop || nlEdit || rowClickShield ? ' dn-agenda--popover-open' : ''}`}
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
          style={{ height: AGENDA_HOURS.length * slotH }}
          aria-hidden="true"
        >
          {/* Hour grid — labels stay in the rail; active drop time is shown
              IN the rail (GCal-style), never as a chip over the grid. */}
          {AGENDA_HOURS.map((h) => (
            <div key={h} className="dn-agenda-overlay-slot" style={{ flex: `0 0 ${slotH}px` }}>
              <span className="dn-agenda-overlay-label">
                {h === 12 ? '12p' : h < 12 ? `${h}a` : `${h - 12}p`}
              </span>
            </div>
          ))}
          {/* Existing tasks — muted, content column only */}
          {entries.map(({ task, start, end }) => {
            const topH = start / 60
            const durH = (end - start) / 60
            const topPx = (topH - AGENDA_HOURS[0]!) * slotH
            const heightPx = Math.max(durH * slotH, 8)
            if (topPx < 0 || topPx > AGENDA_HOURS.length * slotH) return null
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
          {/* Snap guide in the rail + empty translucent ghost (GCal-style:
              time readout never paints over the grid). */}
          {ghostStartMin !== null && (
            <>
              <div
                className="dn-agenda-snap-guide"
                style={{ top: ghostTopPx }}
                data-testid="agenda-snap-guide"
              >
                <div className="dn-agenda-snap-rail">
                  <span className="dn-agenda-snap-time">
                    {`${ghostH12}:${String(ghostMinute).padStart(2, '0')}${ghostHour !== null && ghostHour < 12 ? 'a' : 'p'}`}
                  </span>
                  <span className="dn-agenda-ghost-label">
                    {`${ghostH12}:${String(ghostMinute).padStart(2, '0')}–${formatClock(ghostEndMin)}${Math.floor(ghostEndMin / 60) < 12 ? 'a' : 'p'}`}
                  </span>
                </div>
                <span className="dn-agenda-snap-line" />
              </div>
              <div
                className="dn-agenda-ghost"
                style={{ top: ghostTopPx, height: Math.max(ghostHeightPx, 8) }}
                data-testid="agenda-drag-ghost"
                data-start-min={ghostStartMin}
                aria-label={`${ghostH12}:${String(ghostMinute).padStart(2, '0')} to ${formatClock(ghostEndMin)}`}
              />
            </>
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
          <div
            className={`dn-agenda-entry-wrap${nlEdit?.taskId === task.id ? ' dn-agenda-entry-wrap--nl-editing' : ''}`}
            key={task.id}
          >
            {showNowBefore && (
              <div className="dn-agenda-now" data-testid="agenda-current-time">
                <span>Now · {formatClock(nowMinutes)}</span>
                <i />
              </div>
            )}
            <div
              className={`dn-agenda-entry${task.status === 'done' ? ' done' : ''}${
                task.isNote ? ' meeting' : ''
              }${priorityTimelineAccentClass(task.priority)}`}
              data-testid="agenda-task"
              data-task-id={task.id}
              draggable={renamingTaskId !== task.id && nlEdit?.taskId !== task.id}
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
              {nlEdit?.taskId === task.id ? (
                <div className="dn-task-input-wrap" onMouseDown={(event) => event.stopPropagation()}>
                  <NlAnnotatedInput
                    value={nlEdit.text}
                    autoFocus
                    testId="agenda-task-nl-edit"
                    openKind={nlEdit.entityPop?.kind ?? null}
                    onChange={(raw, parsed) => {
                      setNlEdit((prev) =>
                        prev
                          ? {
                              ...prev,
                              text: raw,
                              startMin: parsed.startMin ?? prev.startMin,
                              durIdx:
                                parsed.durationMin != null
                                  ? nearestDurIdx(parsed.durationMin, DUR_STEPS_MIN)
                                  : prev.durIdx,
                            }
                          : prev
                      )
                    }}
                    onCommit={() => commitNlEdit()}
                    onCancel={() => setNlEdit(null)}
                    onEntityClick={(kind, rect) => {
                      if (kind === 'tag') return
                      setNlEdit((prev) => (prev ? { ...prev, entityPop: { kind, anchor: rect } } : prev))
                    }}
                  />
                </div>
              ) : (
                <>
                  <span
                    className="dn-agenda-time dn-agenda-time--editable"
                    title="Click to edit start time"
                    onClick={(e) => openFastPop(e, task, start, end, 'time')}
                  >{formatClock(start)}</span>
                  {task.isNote
                    ? <MeetingGlyph testId="agenda-meeting-glyph" />
                    : (
                      <button
                        type="button"
                        className="dn-tbox"
                        data-testid="agenda-task-toggle"
                        onClick={(event) => { event.stopPropagation(); onToggle(task.id) }}
                        aria-label={task.status === 'done' ? 'Mark task incomplete' : 'Mark task complete'}
                      />
                    )
                  }
                  <div
                    className="dn-agenda-task-main"
                    onDoubleClick={(event) => {
                      event.stopPropagation()
                      startNlEdit(task, start, end)
                    }}
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
                  <span
                    className={`dn-agenda-duration dn-agenda-duration--editable${priorityTimelineAccentClass(task.priority) ? ' dn-agenda-duration--hi-pri' : ''}`}
                    title="Click to edit duration"
                    onClick={(e) => openFastPop(e, task, start, end, 'duration')}
                  >{formatDuration(end - start)}</span>
                  {!(fastPop || nlEdit || rowClickShield) && (
                    <button
                      type="button"
                      className="btn btn-icon btn-sm dn-agenda-delete"
                      data-testid="agenda-task-delete"
                      title="Delete task"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (rowClickShieldRef.current || fastPopRef.current || nlEditRef.current) return
                        onDelete(task.id)
                      }}
                    >
                      ×
                    </button>
                  )}
                </>
              )}
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
            <span className="dn-agenda-time">{formatClock(pendingDrop.startMin)}</span>
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
          <span>Now · {formatClock(nowMinutes)}</span>
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
          <div
            className="dn-dur-card-at"
            ref={dropStartRef}
            title="Scroll to nudge ±15 min"
          >
            {`starting ${formatClock(pendingDrop.startMin)} ${dropStartSuf}`}
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

        </div>
      )}

      {/* ── NL create card ── */}
      {pendingCreate && onCreate && (
        <AgendaNlCreateCard
          draft={pendingCreate}
          cardRef={createCardRef}
          onDraftChange={setPendingCreate}
          onCancel={() => setPendingCreate(null)}
          onCommit={(content, timeBlock) => {
            onCreate(content, timeBlock)
            setPendingCreate(null)
          }}
        />
      )}

      {/* ── Fast time / duration popover on agenda row ── */}
      {fastPop?.kind === 'time' && (
        <NlTimePopover
          startMin={fastPop.startMin}
          anchor={fastPop.anchor}
          onChange={(startMin) => {
            const next = fastPopRef.current
            if (!next) return
            fastPopRef.current = { ...next, startMin }
            setFastPop(fastPopRef.current)
          }}
          onCommit={() => commitFastPopRef.current()}
          onCancel={cancelFastPop}
        />
      )}
      {fastPop?.kind === 'duration' && (
        <NlDurationPopover
          durationMin={DUR_STEPS_MIN[fastPop.durIdx]!}
          anchor={fastPop.anchor}
          onArmShield={armRowClickShield}
          onChange={(durationMin) => {
            const next = fastPopRef.current
            if (!next) return
            const durIdx = nearestDurIdx(durationMin, DUR_STEPS_MIN)
            fastPopRef.current = { ...next, durIdx }
            setFastPop(fastPopRef.current)
          }}
          onCommit={() => commitFastPopRef.current()}
          onCancel={cancelFastPop}
        />
      )}

      {/* ── Entity popovers while NL-editing an existing task ── */}
      {nlEdit?.entityPop?.kind === 'time' && (
        <NlTimePopover
          startMin={nlEdit.startMin}
          anchor={nlEdit.entityPop.anchor}
          onChange={(startMin) => {
            setNlEdit((prev) =>
              prev
                ? {
                    ...prev,
                    startMin,
                    text: replaceNlEntity(prev.text, 'time', formatStartPhrase(startMin)),
                  }
                : prev
            )
          }}
          onCommit={() => setNlEdit((prev) => (prev ? { ...prev, entityPop: null } : prev))}
          onCancel={() => setNlEdit((prev) => (prev ? { ...prev, entityPop: null } : prev))}
        />
      )}
      {nlEdit?.entityPop?.kind === 'duration' && (
        <NlDurationPopover
          durationMin={DUR_STEPS_MIN[nlEdit.durIdx]!}
          anchor={nlEdit.entityPop.anchor}
          onChange={(durationMin) => {
            const durIdx = nearestDurIdx(durationMin, DUR_STEPS_MIN)
            setNlEdit((prev) =>
              prev
                ? {
                    ...prev,
                    durIdx,
                    text: replaceNlEntity(prev.text, 'duration', formatDurationPhrase(durationMin)),
                  }
                : prev
            )
          }}
          onCommit={() => setNlEdit((prev) => (prev ? { ...prev, entityPop: null } : prev))}
          onCancel={() => setNlEdit((prev) => (prev ? { ...prev, entityPop: null } : prev))}
        />
      )}
    </div>
  )
}
