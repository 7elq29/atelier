import { useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
import TaskMoveContextMenu from './TaskMoveContextMenu'
import type { MoveDateOptions } from './move-date-options'
import TaskTextDisplay from './TaskTextDisplay'

export default function CarrySuggestionItem({
  task,
  sourceDate,
  moveDateOptions,
  onComplete,
  onMoveToToday,
  onMoveToDate,
  onDismiss
}: {
  task: DailyTask
  sourceDate: string
  moveDateOptions: MoveDateOptions
  onComplete: () => void
  onMoveToToday: () => void
  onMoveToDate: (targetDate: string) => void
  onDismiss: () => void
}): JSX.Element {
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null)

  return (
    <div
      className={`dn-carry-item${task.status === 'done' ? ' done' : ''}`}
      data-testid="carry-suggestion-item"
      data-task-id={task.id}
      data-source-date={sourceDate}
      onContextMenu={(e) => {
        e.preventDefault()
        setMoveMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {!task.isNote && (
        <div
          className="dn-tbox"
          data-testid="carry-suggestion-toggle"
          onClick={() => onComplete()}
        />
      )}
      <div className="dn-carry-item-main">
        <span className="dn-carry-item-text">
          <TaskTextDisplay task={task} />
        </span>
      </div>
      <div className="dn-carry-item-actions">
        <button
          type="button"
          className="btn btn-icon btn-sm dn-carry-add"
          data-testid="carry-add-today"
          title="Add to today"
          onClick={() => onMoveToToday()}
        >
          +
        </button>
        <button
          type="button"
          className="btn btn-icon btn-sm dn-carry-dismiss"
          data-testid="carry-dismiss"
          title="Dismiss"
          onClick={() => onDismiss()}
        >
          ✕
        </button>
      </div>
      {moveMenu && (
        <TaskMoveContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          options={moveDateOptions}
          variant="carry"
          onSelect={(targetDate) => onMoveToDate(targetDate)}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  )
}
