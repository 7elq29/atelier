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
    const detail =
      task.subtitle?.replace(/^last:\s*/i, '') ??
      (running ? null : statusLabel !== 'done' ? statusLabel : null)
    const detailWithError = task.error ? `${detail ?? statusLabel} · ${task.error}` : detail

    return (
      <div
        className={`background-rail-entry${failed ? ' background-rail-failed' : ''}${done ? ' background-rail-done' : ''}`}
        data-testid="background-rail-item"
        data-task-id={task.taskId}
        data-task-status={statusLabel}
      >
        <div className="subagent-item background-rail-head">
          {running && <span className="spinner" />}
          {!running && done && !failed && <span className="background-rail-icon done">✓</span>}
          {!running && failed && <span className="background-rail-icon failed">!</span>}
          <span className="background-rail-title" title={fullTitle}>
            {fullTitle}
          </span>
        </div>
        {detailWithError && (
          <div className="background-rail-detail" data-testid="background-rail-sub">
            {detailWithError}
          </div>
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
          {task.subtitle ? ` · ${task.subtitle.replace(/^last:\s*/i, '')}` : ''}
          {task.error ? ` · ${task.error}` : ''}
        </div>
      </div>
    </div>
  )
}
