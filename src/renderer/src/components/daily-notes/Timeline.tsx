import { useEffect, useRef, useState } from 'react'
import type { DailyTask, ExternalLink } from '../../../../shared/daily-note-types'
import CurrentTimeMarker from './CurrentTimeLine'
import DailyNoteTaskInput from './DailyNoteTaskInput'
import TaskMoveContextMenu from './TaskMoveContextMenu'
import type { MoveDateOptions } from './move-date-options'
import {
  TIMELINE_START_HOUR,
  TIMELINE_END_HOUR,
  SNAP_MINUTES,
  LABEL_WIDTH,
  parseTimeBlock,
  minutesToTime,
  minutesToPx,
  pxToMinutes,
  snapMinutes,
  computeColumns
} from './timeline-scale'
import { extractInlineTagsFromText } from '../../../../shared/daily-note-tags'
import { formatTaskEditBuffer } from '../../../../shared/task-priority'
import { priorityTimelineAccentClass } from '../../../../shared/task-priority'
import { TaskEditInput, TaskPriorityBadge, buildTaskEditPatch } from './task-priority-ui'
import TaskTextDisplay from './TaskTextDisplay'

const DEFAULT_DURATION_MIN = 30
const NOW_POLL_MS = 30_000
/** Pixels of vertical movement before a mousedown becomes a drag (clicks/double-clicks stay put). */
const DRAG_ACTIVATION_PX = 8
const GRID_START_MIN = TIMELINE_START_HOUR * 60
const GRID_END_MIN = TIMELINE_END_HOUR * 60
const GRID_HEIGHT_PX = minutesToPx(GRID_END_MIN - GRID_START_MIN)

interface TimelineProps {
  tasks: DailyTask[]
  /** All tasks for the note (including unscheduled) — used to look up duration on drop. */
  allTasks?: DailyTask[]
  onToggle: (id: string) => void
  onCreate: (text: string, timeBlock: string) => void
  onDropExisting: (id: string, timeBlock: string) => void
  onMoveToUnscheduled: (id: string) => void
  onDelete: (id: string) => void
  onUpdateText: (id: string, text: string) => void
  onUpdateTask: (id: string, patch: Partial<DailyTask>) => void
  moveDateOptions: MoveDateOptions
  onMoveToDate: (id: string, targetDate: string) => void
  onCreateSessionFromTask?: (task: DailyTask) => void
}

interface DraftForm {
  timeBlock: string
  text: string
}

type DragMode = 'move' | 'resize-top' | 'resize-bottom'

interface DragInfo {
  mode: DragMode
  taskId: string
  initialMouseY: number
  initialStartMin: number
  initialEndMin: number
  liveStartMin: number
  liveEndMin: number
}

function minutesNow(): number {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi)
}

/** "6a" / "12p" / "3p" hour-label format used for the grid gutter. */
function formatHourLabel(hour: number): string {
  const period = hour < 12 ? 'a' : 'p'
  let h12 = hour % 12
  if (h12 === 0) h12 = 12
  return `${h12}${period}`
}

export default function Timeline({
  tasks,
  allTasks,
  onToggle,
  onCreate,
  onDropExisting,
  onMoveToUnscheduled,
  onDelete,
  onUpdateText,
  onUpdateTask,
  moveDateOptions,
  onMoveToDate,
  onCreateSessionFromTask
}: TimelineProps): JSX.Element {
  const [draft, setDraft] = useState<DraftForm | null>(null)
  const [nowMinutes, setNowMinutes] = useState(() => minutesNow())
  const containerRef = useRef<HTMLDivElement>(null)
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number; taskId: string } | null>(null)
  const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const renameInputRef = useRef<HTMLTextAreaElement>(null)

  const pendingDragRef = useRef<Omit<DragInfo, 'liveStartMin' | 'liveEndMin'> | null>(null)
  /** Task id for an in-flight HTML5 drag — dataTransfer is empty during dragover. */
  const htmlDragTaskIdRef = useRef<string | null>(null)
  /** Minutes from block start to the grab point — keeps HTML5 reposition from jumping. */
  const htmlDragGrabOffsetMinRef = useRef(0)
  const dragRef = useRef<DragInfo | null>(null)
  const dragActivatedRef = useRef(false)
  const [dragActive, setDragActive] = useState(false)
  const [liveBlock, setLiveBlock] = useState<{ taskId: string; startMin: number; endMin: number } | null>(null)

  function clearDragGesture(): void {
    pendingDragRef.current = null
    dragRef.current = null
    dragActivatedRef.current = false
    setLiveBlock(null)
    setDragActive(false)
  }

  function applyDragMove(drag: DragInfo, clientY: number): void {
    const deltaMin = snapMinutes(pxToMinutes(clientY - drag.initialMouseY))
    let nextStart = drag.initialStartMin
    let nextEnd = drag.initialEndMin

    if (drag.mode === 'move') {
      const duration = drag.initialEndMin - drag.initialStartMin
      nextStart = drag.initialStartMin + deltaMin
      nextEnd = nextStart + duration
      if (nextStart < GRID_START_MIN) {
        nextStart = GRID_START_MIN
        nextEnd = GRID_START_MIN + duration
      }
      if (nextEnd > GRID_END_MIN) {
        nextEnd = GRID_END_MIN
        nextStart = GRID_END_MIN - duration
      }
    } else if (drag.mode === 'resize-top') {
      nextStart = clamp(drag.initialStartMin + deltaMin, GRID_START_MIN, drag.initialEndMin - SNAP_MINUTES)
      nextEnd = drag.initialEndMin
    } else {
      nextEnd = clamp(drag.initialEndMin + deltaMin, drag.initialStartMin + SNAP_MINUTES, GRID_END_MIN)
      nextStart = drag.initialStartMin
    }

    drag.liveStartMin = nextStart
    drag.liveEndMin = nextEnd
    setLiveBlock({ taskId: drag.taskId, startMin: nextStart, endMin: nextEnd })
  }

  useEffect(() => {
    const interval = setInterval(() => setNowMinutes(minutesNow()), NOW_POLL_MS)
    return () => clearInterval(interval)
  }, [])

  // fix-move-task-not-found-in-source-note: unlike TaskItem's per-task
  // menu (which naturally unmounts — and its menu state with it — when its
  // task's `id` changes, since `key={task.id}` in DailyNotesSidebar's map),
  // this Timeline-level `moveMenu` holds the right-clicked task's id in
  // state that's independent of `tasks` re-rendering. If a fresh disk read
  // lands (fs.watch resync after an external Obsidian edit) while the menu
  // is still open — e.g. the edit stripped/regenerated that task's `[gid::]`
  // tag, so the SAME line now parses to a brand-new id, or the task was
  // deleted/moved out from under the menu entirely — the menu would
  // otherwise keep offering "Move to..." options against an id that no
  // longer exists on disk. Selecting one then reaches the main process's
  // fresh-disk-read fully unaware, and it correctly refuses to guess: it
  // throws "task not found in source note". Closing the menu here as soon
  // as its captured id vanishes from the live task list prevents that stale
  // IPC call from ever being made — the same self-heal TaskItem already
  // gets "for free" from React's key-based unmount.
  useEffect(() => {
    if (!moveMenu) return
    if (!tasks.some((t) => t.id === moveMenu.taskId)) setMoveMenu(null)
  }, [tasks, moveMenu])

  // Dismiss an empty draft when the user clicks elsewhere on the timeline.
  useEffect(() => {
    if (!draft) return
    const text = draft.text
    function onMouseDown(e: MouseEvent): void {
      const target = e.target as HTMLElement
      if (target.closest('.dn-tblock-draft-wrap')) return
      if (!text.trim()) setDraft(null)
    }
    window.addEventListener('mousedown', onMouseDown)
    return () => window.removeEventListener('mousedown', onMouseDown)
  }, [draft])

  // Drag state machine (UC-9/UC-10 move + resize): arm on mousedown, activate only
  // after DRAG_ACTIVATION_PX of movement so clicks/double-clicks/right-click menus
  // do not accidentally commit a new timeBlock.
  useEffect(() => {
    function onMove(e: MouseEvent): void {
      const pending = pendingDragRef.current
      if (pending && !dragRef.current) {
        if (Math.abs(e.clientY - pending.initialMouseY) < DRAG_ACTIVATION_PX) return
        dragActivatedRef.current = true
        dragRef.current = {
          ...pending,
          liveStartMin: pending.initialStartMin,
          liveEndMin: pending.initialEndMin
        }
        pendingDragRef.current = null
        setDragActive(true)
      }

      const drag = dragRef.current
      if (!drag) return
      applyDragMove(drag, e.clientY)
    }

    function onUp(): void {
      if (pendingDragRef.current && !dragActivatedRef.current) {
        pendingDragRef.current = null
        return
      }

      const drag = dragRef.current
      if (
        drag &&
        dragActivatedRef.current &&
        (drag.liveStartMin !== drag.initialStartMin || drag.liveEndMin !== drag.initialEndMin)
      ) {
        onDropExisting(drag.taskId, `${minutesToTime(drag.liveStartMin)}-${minutesToTime(drag.liveEndMin)}`)
      }
      clearDragGesture()
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onDropExisting])

  const startDrag = (mode: DragMode, task: DailyTask, block: { start: number; end: number }, e: React.MouseEvent): void => {
    if (e.button !== 0) return
    if (renamingTaskId === task.id) return
    e.preventDefault()
    e.stopPropagation()
    clearDragGesture()
    pendingDragRef.current = {
      mode,
      taskId: task.id,
      initialMouseY: e.clientY,
      initialStartMin: block.start,
      initialEndMin: block.end
    }
  }

  /** Raw (unsnapped) grid minutes for a client Y inside the scrollable body. */
  const clientYToRawMinutes = (clientY: number): number => {
    const el = containerRef.current
    if (!el) return GRID_START_MIN
    const rect = el.getBoundingClientRect()
    const relY = clientY - rect.top + el.scrollTop
    return GRID_START_MIN + pxToMinutes(relY)
  }

  /**
   * Start time for create / HTML5 drop: snap to SNAP_MINUTES (15), optionally
   * subtracting a grab offset so repositioning an existing block does not jump.
   */
  const clampedStartAtClientY = (
    clientY: number,
    durationMin: number,
    grabOffsetMin = 0
  ): number => {
    const start = snapMinutes(clientYToRawMinutes(clientY) - grabOffsetMin)
    return clamp(start, GRID_START_MIN, GRID_END_MIN - durationMin)
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if ((e.target as HTMLElement).closest('.dn-tblock')) return
    if ((e.target as HTMLElement).closest('.dn-tblock-draft-wrap')) return
    const start = clampedStartAtClientY(e.clientY, DEFAULT_DURATION_MIN)
    const end = start + DEFAULT_DURATION_MIN
    if (draft?.text.trim()) {
      onCreate(draft.text.trim(), draft.timeBlock)
    }
    setDraft({
      timeBlock: `${minutesToTime(start)}-${minutesToTime(end)}`,
      text: ''
    })
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    const id = htmlDragTaskIdRef.current
    // Also handle drags from external sources (unscheduled tasks) — we can't
    // read getData during dragover, but types are always exposed.
    const isExternal = !id && e.dataTransfer.types.includes('text/task-id')
    if (!id && !isExternal) return
    const task = id ? tasks.find((t) => t.id === id) : null
    const parsed = task ? parseTimeBlock(task.timeBlock) : null
    const duration = parsed ? parsed.end - parsed.start : DEFAULT_DURATION_MIN
    const grabOffset = id ? htmlDragGrabOffsetMinRef.current : 0
    const start = clampedStartAtClientY(e.clientY, duration, grabOffset)
    const end = Math.min(start + duration, GRID_END_MIN)
    setLiveBlock({ taskId: id ?? '__external__', startMin: start, endMin: end })
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setLiveBlock(null)
    }
  }

  const handleDragEnd = (): void => {
    htmlDragTaskIdRef.current = null
    htmlDragGrabOffsetMinRef.current = 0
    setLiveBlock(null)
  }

  const handleTaskDragStart = (task: DailyTask, e: React.DragEvent): void => {
    clearDragGesture()
    htmlDragTaskIdRef.current = task.id
    const parsed = parseTimeBlock(task.timeBlock)
    htmlDragGrabOffsetMinRef.current = parsed
      ? clientYToRawMinutes(e.clientY) - parsed.start
      : 0
    e.dataTransfer.setData('text/task-id', task.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const grabOffset = htmlDragTaskIdRef.current ? htmlDragGrabOffsetMinRef.current : 0
    htmlDragTaskIdRef.current = null
    htmlDragGrabOffsetMinRef.current = 0
    setLiveBlock(null)
    const id = e.dataTransfer.getData('text/task-id')
    if (!id) return
    const task = (allTasks ?? tasks).find((t) => t.id === id)
    const parsed = task ? parseTimeBlock(task.timeBlock) : null
    const duration = parsed ? parsed.end - parsed.start : DEFAULT_DURATION_MIN
    // External (unscheduled) drops map cursor → start; in-timeline moves keep grab offset.
    const start = clampedStartAtClientY(e.clientY, duration, parsed ? grabOffset : 0)
    const end = Math.min(start + duration, GRID_END_MIN)
    onDropExisting(id, `${minutesToTime(start)}-${minutesToTime(end)}`)
  }

  const submitDraft = (): void => {
    if (draft && draft.text.trim()) {
      onCreate(draft.text.trim(), draft.timeBlock)
    }
    setDraft(null)
  }

  const commitRename = (
    taskId: string,
    parsed: {
      text: string
      priority?: string
      priorityTouched: boolean
      externalLinks: ExternalLink[]
    }
  ): void => {
    const task = tasks.find((t) => t.id === taskId)
    if (!task) {
      setRenamingTaskId(null)
      return
    }
    const patch = buildTaskEditPatch(task, parsed)
    if (Object.keys(patch).length > 0) onUpdateTask(taskId, patch)
    else if (parsed.text.trim()) onUpdateText(taskId, parsed.text.trim())
    setRenamingTaskId(null)
  }

  const startRename = (task: DailyTask): void => {
    clearDragGesture()
    setRenameText(formatTaskEditBuffer(task))
    setRenamingTaskId(task.id)
  }

  const draftBlock = draft ? parseTimeBlock(draft.timeBlock) : null
  const draftIsMeeting = draft ? extractInlineTagsFromText(draft.text).includes('#meeting') : false

  // Build the effective (possibly live-dragged) start/end for every
  // scheduled task, then run the overlap-column layout (UC-10) over that
  // effective set so a block being dragged re-flows its siblings live too.
  const effective: { task: DailyTask; start: number; end: number }[] = []
  for (const task of tasks) {
    const parsed = parseTimeBlock(task.timeBlock)
    if (!parsed) continue
    const isLive = liveBlock && liveBlock.taskId === task.id
    effective.push({
      task,
      start: isLive ? liveBlock!.startMin : parsed.start,
      end: isLive ? liveBlock!.endMin : parsed.end
    })
  }
  const layout = computeColumns(effective.map((e) => ({ taskId: e.task.id, startMin: e.start, endMin: e.end })))

  const hourMarks: number[] = []
  for (let hour = TIMELINE_START_HOUR; hour <= TIMELINE_END_HOUR; hour++) hourMarks.push(hour)

  return (
    <div
      ref={containerRef}
      className="dn-section-body scroll-y"
      data-testid="timeline-body"
      onContextMenu={handleContextMenu}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="dn-timeline-grid" data-testid="timeline-grid" style={{ height: `${GRID_HEIGHT_PX}px` }}>
        {hourMarks.map((hour) => (
          <div
            key={hour}
            className="dn-hour-row"
            style={{ top: `${minutesToPx((hour - TIMELINE_START_HOUR) * 60)}px` }}
          >
            <span className="dn-hour-label" style={{ width: `${LABEL_WIDTH}px` }}>
              {formatHourLabel(hour)}
            </span>
            <span className="dn-hour-line" />
          </div>
        ))}

        {effective.map(({ task, start, end }) => {
          const entry = layout.get(task.id)
          const column = entry?.column ?? 0
          const totalColumns = entry?.totalColumns ?? 1
          const colFrac = 1 / totalColumns
          const leftFrac = column * colFrac
          const top = minutesToPx(start - GRID_START_MIN)
          const height = Math.max(minutesToPx(end - start), 8)

          return (
            <div
              key={task.id}
              className={`dn-tblock${task.status === 'done' ? ' done' : ''}${
                liveBlock && liveBlock.taskId === task.id ? ' dragging' : ''
              }${task.isNote ? ' meeting' : ''}${priorityTimelineAccentClass(task.priority)}${
                renamingTaskId === task.id ? ' renaming' : ''
              }`}
              data-testid="timeline-task"
              data-task-id={task.id}
              data-start={minutesToTime(start)}
              data-end={minutesToTime(end)}
              style={{
                top: `${top}px`,
                height: `${height}px`,
                left: `calc(${LABEL_WIDTH}px + (100% - ${LABEL_WIDTH}px) * ${leftFrac})`,
                width: `calc((100% - ${LABEL_WIDTH}px) * ${colFrac} - 4px)`
              }}
              draggable={renamingTaskId !== task.id}
              onDragStart={(e) => handleTaskDragStart(task, e)}
              onDragEnd={handleDragEnd}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setMoveMenu({ x: e.clientX, y: e.clientY, taskId: task.id })
              }}
            >
              <div
                className="dn-tblock-resize dn-tblock-resize-top"
                data-testid="timeline-resize-top"
                data-task-id={task.id}
                onMouseDown={(e) => startDrag('resize-top', task, { start, end }, e)}
              />
              <button
                className="btn btn-icon btn-sm dn-tblock-remove"
                data-testid="timeline-task-delete"
                data-task-id={task.id}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(task.id)
                }}
              >
                ✕
              </button>
              <div
                className="dn-tb-body"
                onMouseDown={(e) => {
                  if (renamingTaskId === task.id) return
                  if ((e.target as HTMLElement).closest('.dn-tbox')) return
                  // Pointer move (15-min snap + grab offset). preventDefault inside
                  // startDrag suppresses native HTML5 drag for this gesture; dragging
                  // to Unscheduled still works via the block chrome / context menu.
                  startDrag('move', task, { start, end }, e)
                }}
                onDoubleClick={(e) => {
                  if ((e.target as HTMLElement).closest('.dn-tbox')) return
                  e.stopPropagation()
                  startRename(task)
                }}
              >
                {!task.isNote && (
                  <div
                    className="dn-tbox"
                    data-testid="timeline-task-toggle"
                    data-task-id={task.id}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggle(task.id)
                    }}
                  />
                )}
                {renamingTaskId === task.id ? (
                  <div
                    className="dn-task-input-wrap"
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <TaskEditInput
                      autoFocus
                      deferFocus
                      value={renameText}
                      onChange={setRenameText}
                      onCommit={(parsed) => commitRename(task.id, parsed)}
                      onCancel={() => setRenamingTaskId(null)}
                      inputRef={renameInputRef}
                      className="dn-task-edit-input"
                      testId="timeline-task-edit-input"
                    />
                  </div>
                ) : (
                  <>
                    <span className="dn-tb-label">
                      <TaskTextDisplay task={task} />
                    </span>
                    {task.priority ? <TaskPriorityBadge priority={task.priority} /> : null}
                  </>
                )}
              </div>
              <div
                className="dn-tblock-resize dn-tblock-resize-bottom"
                data-testid="timeline-resize-bottom"
                data-task-id={task.id}
                onMouseDown={(e) => startDrag('resize-bottom', task, { start, end }, e)}
              />
            </div>
          )
        })}

        {/* Ghost block for external drags (e.g. from Unscheduled) */}
        {liveBlock && liveBlock.taskId === '__external__' && (
          <div
            className="dn-tblock dn-tblock-external-ghost"
            data-testid="timeline-external-ghost"
            style={{
              top: `${minutesToPx(liveBlock.startMin - GRID_START_MIN)}px`,
              height: `${Math.max(minutesToPx(liveBlock.endMin - liveBlock.startMin), 8)}px`,
              left: `${LABEL_WIDTH}px`,
              width: `calc(100% - ${LABEL_WIDTH}px - 4px)`,
              pointerEvents: 'none',
            }}
          >
            <span className="dn-tblock-range">
              {minutesToTime(liveBlock.startMin)}–{minutesToTime(liveBlock.endMin)}
            </span>
          </div>
        )}

        {draft && draftBlock && (
          <div
            className="dn-tblock-draft-wrap"
            data-testid="timeline-draft-block"
            style={{
              top: `${minutesToPx(draftBlock.start - GRID_START_MIN)}px`,
              left: `${LABEL_WIDTH}px`,
              width: `calc(100% - ${LABEL_WIDTH}px - 4px)`
            }}
          >
            <div
              className={`dn-tblock-draft-slot${draftIsMeeting ? ' meeting' : ''}`}
              style={{ height: `${Math.max(minutesToPx(draftBlock.end - draftBlock.start), 8)}px` }}
            >
              <span className="dn-draft-range" data-testid="timeline-draft-range">
                {draft.timeBlock.replace('-', '–')}
              </span>
            </div>
            <div className="dn-tblock-draft-editor">
              <DailyNoteTaskInput
                autoFocus
                value={draft.text}
                onChange={(text) => setDraft({ ...draft, text })}
                inputClassName="input dn-draft-input"
                testId="timeline-new-task-input"
                placeholder="New task…"
                onSubmit={submitDraft}
                onCancel={() => setDraft(null)}
                onBlur={submitDraft}
              />
            </div>
          </div>
        )}

        <CurrentTimeMarker minutes={nowMinutes} />
      </div>

      {moveMenu && (
        <TaskMoveContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          options={moveDateOptions}
          onSelect={(targetDate) => onMoveToDate(moveMenu.taskId, targetDate)}
          onRename={() => {
            const task = tasks.find((t) => t.id === moveMenu.taskId)
            if (task) startRename(task)
          }}
          onMoveToUnscheduled={() => onMoveToUnscheduled(moveMenu.taskId)}
          onCreateSession={
            onCreateSessionFromTask
              ? () => {
                  const task = tasks.find((t) => t.id === moveMenu.taskId)
                  if (task) onCreateSessionFromTask(task)
                }
              : undefined
          }
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  )
}
