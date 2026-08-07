import type { BackgroundTaskRow } from '../../../../shared/harness-ui-types'
import {
  backgroundTaskStatusLabel,
  backgroundTaskTypeBadgeClass,
  backgroundTaskTypeBadgeLabel,
  isBackgroundTaskActive,
  truncateBackgroundTaskTitle,
} from '../../../../shared/background-tasks-ui'

export default function BackgroundTaskRowView({
  task,
  variant,
}: {
  task: BackgroundTaskRow
  variant: 'rail' | 'transcript'
}): JSX.Element {
  const running = isBackgroundTaskActive(task)
  const failed = task.status === 'failed' || Boolean(task.error)
  const done = task.done || task.status === 'completed'
  const statusLabel = backgroundTaskStatusLabel(task)
  const fullTitle = task.description
  const displayTitle = truncateBackgroundTaskTitle(fullTitle)
  const typeClass = backgroundTaskTypeBadgeClass(task.taskType)
  const typeLabel = backgroundTaskTypeBadgeLabel(task.taskType)

  if (variant === 'rail') {
    return (
      <div
        className={`subagent-item background-rail-row${failed ? ' background-rail-failed' : ''}${done ? ' background-rail-done' : ''}`}
        data-testid="background-rail-item"
        data-task-id={task.taskId}
        data-task-status={statusLabel}
      >
        {running && <span className="spinner" />}
        <span className="background-rail-title" title={fullTitle}>
          {displayTitle}
        </span>
        <span className="background-rail-status" data-testid="background-rail-status">
          {statusLabel}
        </span>
        {task.subtitle && (
          <span className="background-rail-sub" data-testid="background-rail-sub">
            {task.subtitle}
          </span>
        )}
      </div>
    )
  }

  return (
    <div
      className={`background-item${failed ? ' failed' : ''}${done ? ' done' : ''}`}
      data-testid="background-transcript-item"
      data-task-id={task.taskId}
      data-task-status={statusLabel}
    >
      {running && <span className="spinner" />}
      <span className={`background-type ${typeClass}`}>{typeLabel}</span>
      <div className="background-body">
        <div className="background-desc" title={fullTitle}>
          {displayTitle}
        </div>
        <div className="background-sub" data-testid="background-transcript-sub">
          {statusLabel}
          {task.subtitle ? ` · ${task.subtitle}` : ''}
          {task.error ? ` · ${task.error}` : ''}
        </div>
      </div>
    </div>
  )
}
