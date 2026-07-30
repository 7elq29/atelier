import { useRef, useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
import CurrentTimeLine from './CurrentTimeLine'
import { DAY_START_MIN, DAY_END_MIN, PX_PER_MIN, parseTimeBlock, minutesToTime, roundToSlot } from './timeline-scale'

const TOTAL_HEIGHT = (DAY_END_MIN - DAY_START_MIN) * PX_PER_MIN
const DEFAULT_DURATION_MIN = 30

interface TimelineProps {
  tasks: DailyTask[]
  onToggle: (id: string) => void
  onCreate: (text: string, timeBlock: string) => void
  onDropExisting: (id: string, timeBlock: string) => void
}

interface DraftForm {
  top: number
  timeBlock: string
  text: string
}

export default function Timeline({ tasks, onToggle, onCreate, onDropExisting }: TimelineProps): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<DraftForm | null>(null)

  const yToTimeBlock = (clientY: number): { top: number; timeBlock: string } => {
    const rect = bodyRef.current?.getBoundingClientRect()
    const scrollTop = bodyRef.current?.scrollTop ?? 0
    const relativeY = clientY - (rect?.top ?? 0) + scrollTop
    const startMin = roundToSlot(DAY_START_MIN + relativeY / PX_PER_MIN)
    const endMin = startMin + DEFAULT_DURATION_MIN
    const top = (startMin - DAY_START_MIN) * PX_PER_MIN
    return { top, timeBlock: `${minutesToTime(startMin)}–${minutesToTime(endMin)}` }
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    if ((e.target as HTMLElement).closest('.dn-time-block')) return
    const { top, timeBlock } = yToTimeBlock(e.clientY)
    setDraft({ top, timeBlock, text: '' })
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/task-id')
    if (!id) return
    const { timeBlock } = yToTimeBlock(e.clientY)
    onDropExisting(id, timeBlock)
  }

  const submitDraft = (): void => {
    if (draft && draft.text.trim()) {
      onCreate(draft.text.trim(), draft.timeBlock)
    }
    setDraft(null)
  }

  return (
    <div
      className="dn-section-body dn-timeline-body scroll-y"
      data-testid="timeline-body"
      ref={bodyRef}
      onContextMenu={handleContextMenu}
      onDragOver={(e) => e.preventDefault()}
      onDrop={handleDrop}
    >
      <div className="dn-timeline-track" style={{ height: `${TOTAL_HEIGHT}px` }}>
        <CurrentTimeLine />
        {tasks.map((task) => {
          const block = parseTimeBlock(task.timeBlock)
          if (!block) return null
          const top = (block.start - DAY_START_MIN) * PX_PER_MIN
          const height = Math.max(24, (block.end - block.start) * PX_PER_MIN)
          return (
            <div
              key={task.id}
              className={`dn-time-block${task.status === 'done' ? ' done' : ''}`}
              data-testid="timeline-task"
              data-task-id={task.id}
              draggable
              onDragStart={(e) => e.dataTransfer.setData('text/task-id', task.id)}
              onClick={() => onToggle(task.id)}
              style={{ top: `${top}px`, height: `${height}px` }}
            >
              <div className="dn-tb-range">{task.timeBlock}</div>
              <div className="dn-tb-body">
                <div className="dn-tbox" />
                <span className="dn-tb-label">{task.text}</span>
              </div>
            </div>
          )
        })}
        {draft && (
          <div className="dn-time-block dn-time-block-draft" style={{ top: `${draft.top}px` }}>
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
