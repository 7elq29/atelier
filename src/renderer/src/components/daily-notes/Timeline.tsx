import { useEffect, useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
import CurrentTimeMarker from './CurrentTimeLine'
import { DAY_START_MIN, DAY_END_MIN, parseTimeBlock, minutesToTime, roundToSlot } from './timeline-scale'

const DEFAULT_DURATION_MIN = 30
const NOW_POLL_MS = 30_000

interface TimelineProps {
  tasks: DailyTask[]
  onToggle: (id: string) => void
  onCreate: (text: string, timeBlock: string) => void
  onDropExisting: (id: string, timeBlock: string) => void
}

interface DraftForm {
  timeBlock: string
  text: string
}

function minutesNow(): number {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

/**
 * Default time-block used for a newly created (right-click) or dropped
 * (drag from Unscheduled) task.
 *
 * Deviation from the old design, documented per the UI-fix instructions:
 * the previous absolute-grid layout derived this from the click/drop pixel
 * Y-coordinate via a fixed px-per-minute scale. The flat-list layout has no
 * such coordinate-to-time mapping (card position in the list is driven by
 * chronological sort, not pixel offset), so there is nothing meaningful to
 * derive from `e.clientY` any more. We anchor new/dropped tasks to "now"
 * (rounded to the nearest 15-minute slot) instead, which keeps the same
 * interaction surface (right-click to create, drag to schedule) while being
 * well-defined for a flow layout. If real overlapping/duplicate time-blocks
 * ever become a problem this would need a proper conflict check, but that's
 * unchanged from the old behavior (which also didn't check for overlap).
 */
function defaultTimeBlock(): string {
  const start = roundToSlot(minutesNow())
  const end = start + DEFAULT_DURATION_MIN
  return `${minutesToTime(start)}–${minutesToTime(end)}`
}

export default function Timeline({ tasks, onToggle, onCreate, onDropExisting }: TimelineProps): JSX.Element {
  const [draft, setDraft] = useState<DraftForm | null>(null)
  const [nowMinutes, setNowMinutes] = useState(() => minutesNow())

  useEffect(() => {
    const interval = setInterval(() => setNowMinutes(minutesNow()), NOW_POLL_MS)
    return () => clearInterval(interval)
  }, [])

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if ((e.target as HTMLElement).closest('.dn-time-block')) return
    setDraft({ timeBlock: defaultTimeBlock(), text: '' })
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/task-id')
    if (!id) return
    onDropExisting(id, defaultTimeBlock())
  }

  const submitDraft = (): void => {
    if (draft && draft.text.trim()) {
      onCreate(draft.text.trim(), draft.timeBlock)
    }
    setDraft(null)
  }

  const showNowMarker = nowMinutes >= DAY_START_MIN && nowMinutes <= DAY_END_MIN

  // Flat, chronologically-ordered render list (tasks arrive pre-sorted by
  // timeBlock from DailyNotesSidebar). The "now" marker is spliced in as a
  // plain row between the two tasks that bracket the current time — not an
  // absolutely-positioned overlay.
  //
  // If "now" falls *inside* a task's own range (an in-progress task), the
  // marker is placed immediately after that task rather than splitting its
  // card in two — the marker separates "started" from "not yet started",
  // and a task that has already started (even if not finished) belongs on
  // the "started" side. This falls out of the `block.start > nowMinutes`
  // check below: an in-progress task's start is <= nowMinutes, so it's
  // never treated as the "next" task the marker needs to precede.
  const rows: JSX.Element[] = []
  let markerInserted = !showNowMarker
  for (const task of tasks) {
    const block = parseTimeBlock(task.timeBlock)
    if (!markerInserted && block && block.start > nowMinutes) {
      rows.push(<CurrentTimeMarker key="now-marker" minutes={nowMinutes} />)
      markerInserted = true
    }
    rows.push(
      <div
        key={task.id}
        className={`dn-time-block${task.status === 'done' ? ' done' : ''}`}
        data-testid="timeline-task"
        data-task-id={task.id}
        data-start={block ? minutesToTime(block.start) : undefined}
        data-end={block ? minutesToTime(block.end) : undefined}
        draggable
        onDragStart={(e) => e.dataTransfer.setData('text/task-id', task.id)}
        onClick={() => onToggle(task.id)}
      >
        <div className="dn-tb-range">
          {task.timeBlock}
          {block ? ` · ${block.end - block.start}m` : ''}
        </div>
        <div className="dn-tb-body">
          <div className="dn-tbox" />
          <span className="dn-tb-label">{task.text}</span>
        </div>
      </div>
    )
  }
  if (!markerInserted) {
    rows.push(<CurrentTimeMarker key="now-marker" minutes={nowMinutes} />)
  }

  return (
    <div
      className="dn-section-body scroll-y"
      data-testid="timeline-body"
      onContextMenu={handleContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="dn-timeline-list" data-testid="timeline-list">
        {rows}
        {draft && (
          <div className="dn-time-block dn-time-block-draft">
            <div className="dn-tb-range">{draft.timeBlock}</div>
            <input
              autoFocus
              className="input dn-draft-input"
              data-testid="timeline-new-task-input"
              placeholder="New task…"
              value={draft.text}
              onChange={(e) => setDraft({ ...draft, text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitDraft()
                if (e.key === 'Escape') setDraft(null)
              }}
              onBlur={submitDraft}
            />
          </div>
        )}
      </div>
    </div>
  )
}
