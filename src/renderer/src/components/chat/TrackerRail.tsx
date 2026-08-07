import { useState } from 'react'
import type { MessageRecord } from '../../../../shared/session-types'
import { parseStructuredContent } from '../../../../shared/chat-content'
import type { BackgroundTaskRow } from '../../../../shared/harness-ui-types'
import { backgroundTaskRailGroup, countActiveBackgroundTasks } from '../../../../shared/background-tasks-ui'
import BackgroundTaskRowView from './BackgroundTaskRowView'

interface SubagentEntry {
  toolUseId: string
  label: string
  running: boolean
}

/**
 * Todos/Subagents tracker rail (03-chat-surface-core): renders `TodoWrite`
 * (`todo_update`) events as a live checklist, and top-level `Task` tool
 * calls as a running/completed subagent list — derived straight from the
 * session's message stream (no separate state to keep in sync), so a resume
 * reconstructs the exact same rail from SQLite. Markup/classes match
 * `.tracker-rail`/`.tracker-card`/`.todo-item`/`.subagent-item` in
 * mocks/index.html exactly.
 *
 * SDK background tasks (monitors / jobs / shell) use separate tracker cards —
 * not the transcript `Task` subagent list.
 */
export default function TrackerRail({
  messages,
  backgroundTasks = [],
}: {
  messages: MessageRecord[]
  backgroundTasks?: BackgroundTaskRow[]
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const [showCompleted, setShowCompleted] = useState(false)
  let todos: { content: string; status: string }[] = []
  const subagentOrder: string[] = []
  const subagentByToolUseId = new Map<string, SubagentEntry>()

  for (const m of messages) {
    const parsed = parseStructuredContent(m.content)
    if (!parsed) continue
    if (parsed.kind === 'todo_update') {
      todos = parsed.todos
    } else if (parsed.kind === 'tool_call' && (parsed.name === 'Task' || parsed.name === 'Agent') && !parsed.parentToolUseId) {
      const input = parsed.input && typeof parsed.input === 'object' ? (parsed.input as Record<string, unknown>) : {}
      const label =
        typeof input.description === 'string'
          ? input.description
          : typeof input.subagent_type === 'string'
            ? String(input.subagent_type)
            : 'Task'
      if (!subagentByToolUseId.has(parsed.toolUseId)) subagentOrder.push(parsed.toolUseId)
      subagentByToolUseId.set(parsed.toolUseId, { toolUseId: parsed.toolUseId, label, running: parsed.status === 'running' })
    }
  }

  const subagents = subagentOrder.map((id) => subagentByToolUseId.get(id)!)
  const doneCount = todos.filter((t) => t.status === 'completed').length
  const runningCount = subagents.filter((s) => s.running).length

  const bgMonitors: BackgroundTaskRow[] = []
  const bgJobs: BackgroundTaskRow[] = []
  const bgShell: BackgroundTaskRow[] = []
  for (const t of backgroundTasks) {
    const g = backgroundTaskRailGroup(t.taskType)
    if (g === 'monitors') bgMonitors.push(t)
    else if (g === 'shell') bgShell.push(t)
    else bgJobs.push(t)
  }

  const hasBg = backgroundTasks.length > 0
  if (todos.length === 0 && subagents.length === 0 && !hasBg) {
    return null
  }

  const bgActiveTotal =
    countActiveBackgroundTasks(bgMonitors) +
    countActiveBackgroundTasks(bgJobs) +
    countActiveBackgroundTasks(bgShell)

  return (
    <div className={`tracker-rail${collapsed ? ' collapsed' : ''}`} data-testid="tracker-rail">
      <button
        type="button"
        className="tracker-rail-toggle"
        data-testid="tracker-rail-toggle"
        title={collapsed ? 'Expand Todos/Subagents' : 'Collapse Todos/Subagents'}
        onClick={() => setCollapsed((c) => !c)}
      >
        <span>{collapsed ? '▸' : '◂'}</span>
        <span className="rail-label">Collapse</span>
      </button>
      {todos.length > 0 && (
        <div className="tracker-card" data-testid="todo-tracker-card">
          <div className="tracker-head">
            Todos{' '}
            <span className="count">
              {doneCount}/{todos.length}
            </span>
          </div>
          <div className="tracker-body">
            {todos.filter((t) => showCompleted || t.status !== 'completed').map((t, i) => (
              <div
                key={i}
                className={`todo-item${t.status === 'completed' ? ' done' : t.status === 'in_progress' ? ' active' : ''}`}
                data-testid="todo-item"
                data-status={t.status}
              >
                <div className="box" />
                <span>{t.content}</span>
              </div>
            ))}
            {doneCount > 0 && (
              <button
                type="button"
                className="todo-completed-toggle"
                onClick={() => setShowCompleted((s) => !s)}
              >
                {showCompleted ? 'Hide completed' : `${doneCount} completed`}
              </button>
            )}
          </div>
        </div>
      )}
      {runningCount > 0 && (
        <div className="tracker-card" data-testid="subagent-tracker-card">
          <div className="tracker-head">
            Subagents <span className="count">{runningCount} running</span>
          </div>
          <div className="tracker-body">
            {subagents.map((s) => (
              <div key={s.toolUseId} className="subagent-item" data-testid="subagent-rail-item">
                {s.running && <span className="spinner" />}
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {bgMonitors.length > 0 && (
        <div className="tracker-card" data-testid="background-monitors-card">
          <div className="tracker-head">
            Monitors{' '}
            <span className="count">
              {countActiveBackgroundTasks(bgMonitors) > 0
                ? `${countActiveBackgroundTasks(bgMonitors)} running`
                : `${bgMonitors.length}`}
            </span>
          </div>
          <div className="tracker-body">
            {bgMonitors.map((t) => (
              <BackgroundTaskRowView key={t.taskId} task={t} variant="rail" />
            ))}
          </div>
        </div>
      )}
      {bgJobs.length > 0 && (
        <div className="tracker-card" data-testid="background-jobs-card">
          <div className="tracker-head">
            Background jobs{' '}
            <span className="count">
              {countActiveBackgroundTasks(bgJobs) > 0
                ? `${countActiveBackgroundTasks(bgJobs)} running`
                : `${bgJobs.length}`}
            </span>
          </div>
          <div className="tracker-body">
            {bgJobs.map((t) => (
              <BackgroundTaskRowView key={t.taskId} task={t} variant="rail" />
            ))}
          </div>
        </div>
      )}
      {bgShell.length > 0 && (
        <div className="tracker-card" data-testid="background-shell-card">
          <div className="tracker-head">
            Shell{' '}
            <span className="count">
              {countActiveBackgroundTasks(bgShell) > 0
                ? `${countActiveBackgroundTasks(bgShell)} running`
                : `${bgShell.length}`}
            </span>
          </div>
          <div className="tracker-body">
            {bgShell.map((t) => (
              <BackgroundTaskRowView key={t.taskId} task={t} variant="rail" />
            ))}
          </div>
        </div>
      )}
      <div className="rail-mini-badges" data-testid="tracker-rail-mini-badges">
        {todos.length > 0 && (
          <div className="rail-mini-badge" title={`Todos ${doneCount}/${todos.length}`}>
            <b>
              {doneCount}/{todos.length}
            </b>
          </div>
        )}
        {runningCount > 0 && (
          <div className="rail-mini-badge" title={`Subagents: ${runningCount} running`}>
            <b>{runningCount}</b>
          </div>
        )}
        {bgActiveTotal > 0 && (
          <div className="rail-mini-badge" title="Background tasks running">
            <b>{bgActiveTotal}</b>
          </div>
        )}
      </div>
    </div>
  )
}
