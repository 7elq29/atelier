import type { BackgroundTaskRow } from '../../../../shared/harness-ui-types'
import {
  backgroundTaskRailGroup,
  backgroundTasksForTranscriptCard,
  countActiveBackgroundTasks,
} from '../../../../shared/background-tasks-ui'
import BackgroundTaskRowView from './BackgroundTaskRowView'

/**
 * Non-subagent SDK background tasks in the transcript (monitors / jobs / shell).
 * Subagents (`task_type: subagent`) render only in the tracker rail with live status.
 */
export default function BackgroundTasksConversationCard({
  tasks,
}: {
  tasks: BackgroundTaskRow[]
}): JSX.Element | null {
  const visible = backgroundTasksForTranscriptCard(tasks)
  if (visible.length === 0) return null

  const monitors: BackgroundTaskRow[] = []
  const jobs: BackgroundTaskRow[] = []
  const shell: BackgroundTaskRow[] = []
  for (const t of visible) {
    const g = backgroundTaskRailGroup(t.taskType)
    if (g === 'monitors') monitors.push(t)
    else if (g === 'shell') shell.push(t)
    else jobs.push(t)
  }

  const active = countActiveBackgroundTasks(visible)

  return (
    <div className="background-tasks-conversation-card" data-testid="background-tasks-conversation-card">
      <div className="background-tasks-conversation-head">
        <span className="background-tasks-conversation-title">Background tasks</span>
        <span className="background-tasks-conversation-count" data-testid="background-tasks-conversation-count">
          {active > 0 ? `${active} active` : `${visible.length} total`}
        </span>
      </div>
      {monitors.length > 0 && (
        <section className="background-tasks-conversation-section" data-testid="background-tasks-section-monitors">
          <div className="background-tasks-section-label">Monitors</div>
          {monitors.map((t) => (
            <BackgroundTaskRowView key={t.taskId} task={t} variant="transcript" />
          ))}
        </section>
      )}
      {jobs.length > 0 && (
        <section className="background-tasks-conversation-section" data-testid="background-tasks-section-jobs">
          <div className="background-tasks-section-label">Background jobs</div>
          {jobs.map((t) => (
            <BackgroundTaskRowView key={t.taskId} task={t} variant="transcript" />
          ))}
        </section>
      )}
      {shell.length > 0 && (
        <section className="background-tasks-conversation-section" data-testid="background-tasks-section-shell">
          <div className="background-tasks-section-label">Shell</div>
          {shell.map((t) => (
            <BackgroundTaskRowView key={t.taskId} task={t} variant="transcript" />
          ))}
        </section>
      )}
    </div>
  )
}
