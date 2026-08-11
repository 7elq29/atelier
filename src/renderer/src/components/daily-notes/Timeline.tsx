import { useEffect, useRef, useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
import CurrentTimeMarker from './CurrentTimeLine'
import DailyNoteTaskInput from './DailyNoteTaskInput'
import TaskMoveContextMenu from './TaskMoveContextMenu'
import type { MoveDateOptions } from './move-date-options'
import {
  TIMELINE_START_HOUR,
  TIMELINE_END_HOUR,
  HOUR_HEIGHT_PX,
  SNAP_MINUTES,
  LABEL_WIDTH,
  parseTimeBlock,
  minutesToTime,
  minutesToPx,
  pxToMinutes,
  snapMinutes,
  snapToHalfHour,
  computeColumns
} from './timeline-scale'
import { formatTaskTextWithInlineTags, extractInlineTagsFromText } from '../../../../shared/daily-note-tags'

const DEFAULT_DURATION_MIN = 30
const NOW_POLL_MS = 30_000
const GRID_START_MIN = TIMELINE_START_HOUR * 60
const GRID_END_MIN = TIMELINE_END_HOUR * 60
const GRID_HEIGHT_PX = minutesToPx(GRID_END_MIN - GRID_START_MIN)

interface TimelineProps {
  tasks: DailyTask[]
  onToggle: (id: string) => void
  onCreate: (text: string, timeBlock: string) => void
  onDropExisting: (id: string, timeBlock: string) => void
  onDelete: (id: string) => void
  onUpdateText: (id: string, text: string) => void
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
  onToggle,
  onCreate,
  onDropExisting,
  onDelete,
  onUpdateText,
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

  const dragRef = useRef<DragInfo | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const [liveBlock, setLiveBlock] = useState<{ taskId: string; startMin: number; endMin: number } | null>(null)

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

  // Drag state machine (UC-9/UC-10 move + resize): dragRef is the source of
  // truth read by the window-level mousemove/mouseup listeners (so they
  // never see a stale closure over the initial mousedown values); liveBlock
  // mirrors the ref's live position purely to trigger a re-render so the
  // dragged block visually tracks the pointer before the drop is committed.
  useEffect(() => {
    if (!dragActive) return

    function onMove(e: MouseEvent): void {
      const drag = dragRef.current
      if (!drag) return
      const deltaMin = snapMinutes(pxToMinutes(e.clientY - drag.initialMouseY))
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

    function onUp(): void {
      const drag = dragRef.current
      if (drag && (drag.liveStartMin !== drag.initialStartMin || drag.liveEndMin !== drag.initialEndMin)) {
        onDropExisting(drag.taskId, `${minutesToTime(drag.liveStartMin)}-${minutesToTime(drag.liveEndMin)}`)
      }
      dragRef.current = null
      setLiveBlock(null)
      setDragActive(false)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragActive, onDropExisting])

  const startDrag = (mode: DragMode, task: DailyTask, block: { start: number; end: number }, e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      mode,
      taskId: task.id,
      initialMouseY: e.clientY,
      initialStartMin: block.start,
      initialEndMin: block.end,
      liveStartMin: block.start,
      liveEndMin: block.end
    }
    setLiveBlock({ taskId: task.id, startMin: block.start, endMin: block.end })
    setDragActive(true)
  }

  /** Map a client Y coordinate to a snapped grid-minutes value (UC-5/UC-13). */
  const yToMinutes = (clientY: number): number => {
    const el = containerRef.current
    if (!el) return GRID_START_MIN
    const rect = el.getBoundingClientRect()
    const relY = clientY - rect.top + el.scrollTop
    return snapMinutes(GRID_START_MIN + pxToMinutes(relY))
  }

  const clampedStartForDefaultDuration = (clientY: number): number => {
    const el = containerRef.current
    if (!el) return GRID_START_MIN
    const rect = el.getBoundingClientRect()
    const relY = clientY - rect.top + el.scrollTop
    const rawMin = GRID_START_MIN + pxToMinutes(relY)
    const start = snapToHalfHour(rawMin)
    return clamp(start, GRID_START_MIN, GRID_END_MIN - DEFAULT_DURATION_MIN)
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if ((e.target as HTMLElement).closest('.dn-tblock')) return
    if ((e.target as HTMLElement).closest('.dn-tblock-draft-wrap')) return
    const start = clampedStartForDefaultDuration(e.clientY)
    const end = start + DEFAULT_DURATION_MIN
    if (draft?.text.trim()) {
      onCreate(draft.text.trim(), draft.timeBlock)
    }
    setDraft({
      timeBlock: `${minutesToTime(start)}-${minutesToTime(end)}`,
      text: ''
    })
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/task-id')
    if (!id) return
    const start = clampedStartForDefaultDuration(e.clientY)
    const end = start + DEFAULT_DURATION_MIN
    onDropExisting(id, `${minutesToTime(start)}-${minutesToTime(end)}`)
  }

  const submitDraft = (): void => {
    if (draft && draft.text.trim()) {
      onCreate(draft.text.trim(), draft.timeBlock)
    }
    setDraft(null)
  }

  const commitRename = (taskId: string): void => {
    if (renameText.trim()) onUpdateText(taskId, renameText.trim())
    setRenamingTaskId(null)
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
      onDragOver={(e) => e.preventDefault()}
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
              }${task.isNote ? ' meeting' : ''}${renamingTaskId === task.id ? ' renaming' : ''}`}
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
              onMouseDown={(e) => startDrag('move', task, { start, end }, e)}
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
              <div className="dn-tb-body">
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
                  <DailyNoteTaskInput
                    autoFocus
                    value={renameText}
                    onChange={setRenameText}
                    inputClassName="dn-task-edit-input"
                    testId="timeline-task-edit-input"
                    onMouseDown={(e) => e.stopPropagation()}
                    onSubmit={() => commitRename(task.id)}
                    onCancel={() => setRenamingTaskId(null)}
                    onBlur={() => commitRename(task.id)}
                  />
                ) : (
                  <span className="dn-tb-label">{task.text}</span>
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
            if (task) {
              setRenameText(formatTaskTextWithInlineTags(task.text, task.tags))
              setRenamingTaskId(task.id)
            }
          }}
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
