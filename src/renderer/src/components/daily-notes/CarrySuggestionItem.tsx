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
  onDismiss,
  compact = false
}: {
  task: DailyTask
  sourceDate: string
  moveDateOptions: MoveDateOptions
  onComplete: () => void
  onMoveToToday: () => void
  onMoveToDate: (targetDate: string) => void
  onDismiss: () => void
  compact?: boolean
}): JSX.Element {
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null)

  return (
    <div
      className={`dn-carry-item${compact ? ' dn-carry-item--compact' : ''}${
        task.status === 'done' ? ' done' : ''
      }`}
      data-testid="carry-suggestion-item"
      data-task-id={task.id}
      data-source-date={sourceDate}
      onContextMenu={(e) => {
        e.preventDefault()
        setMoveMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {compact ? (
        <span className="dn-carry-suggestion-arrow" aria-hidden="true">↳</span>
      ) : !task.isNote ? (
        <div
          className="dn-tbox"
          data-testid="carry-suggestion-toggle"
          onClick={() => onComplete()}
        />
      ) : null}
      <div className="dn-carry-item-main">
        <span className="dn-carry-item-text">
          <TaskTextDisplay task={task} />
        </span>
      </div>
      <div className="dn-carry-item-actions">
        {compact && !task.isNote && (
          <button
            type="button"
            className="btn btn-icon btn-sm dn-carry-complete"
            data-testid="carry-suggestion-toggle"
            title="Complete on source day"
            aria-label="Complete on source day"
            onClick={() => onComplete()}
          >
            ✓
          </button>
        )}
        {!compact && (
          <button
            type="button"
            className="btn btn-icon btn-sm dn-carry-add"
            data-testid="carry-add-today"
            title="Add to today"
            onClick={() => onMoveToToday()}
          >
            +
          </button>
        )}
        <button
          type="button"
          className="btn btn-icon btn-sm dn-carry-dismiss"
          data-testid="carry-dismiss"
          title="Dismiss"
          onClick={() => onDismiss()}
        >
          ✕
        </button>
        {compact && (
          <button
            type="button"
            className="btn btn-icon btn-sm dn-carry-today"
            data-testid="carry-add-today"
            title="Move to today"
            aria-label="Move to today"
            onClick={() => onMoveToToday()}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 8h9M8 4l4 4-4 4" />
            </svg>
          </button>
        )}
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
