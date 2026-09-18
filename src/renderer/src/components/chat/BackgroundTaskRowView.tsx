import type { BackgroundTaskRow } from '../../../../shared/harness-ui-types'
import {
  backgroundTaskStatusLabel,
  isBackgroundTaskActive,
  truncateBackgroundTaskTitle,
} from '../../../../shared/background-tasks-ui'

export default function BackgroundTaskRowView({ task }: { task: BackgroundTaskRow }): JSX.Element {
  const running = isBackgroundTaskActive(task)
  const failed = task.status === 'failed' || Boolean(task.error)
  const done = task.done || task.status === 'completed'
  const statusLabel = backgroundTaskStatusLabel(task)
  const fullTitle = task.description
  const displayTitle = truncateBackgroundTaskTitle(fullTitle)
  const detail =
    task.subtitle?.replace(/^last:\s*/i, '') ??
    (running ? null : statusLabel !== 'done' ? statusLabel : null)
  const detailWithError = task.error ? `${detail ?? statusLabel} · ${task.error}` : detail

  const dotClass = failed ? 'failed' : done ? 'done' : 'idle'

  return (
    <div
      className={`background-rail-entry${failed ? ' background-rail-failed' : ''}${done ? ' background-rail-done' : ''}`}
      data-testid="background-rail-item"
      data-task-id={task.taskId}
      data-task-status={statusLabel}
    >
      <div className="background-rail-head">
        {running ? (
          <span className="spinner" aria-hidden="true" />
        ) : (
          <div className={`bg-dot ${dotClass}`} aria-hidden="true" />
        )}
        <div className="background-rail-body">
          <span className="background-rail-title" title={fullTitle}>
            {displayTitle}
          </span>
          {detailWithError ? (
            <span className="background-rail-detail" data-testid="background-rail-sub">
              {detailWithError}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
