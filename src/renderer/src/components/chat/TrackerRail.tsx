import { useState } from 'react'
import type { MessageRecord } from '../../../../shared/session-types'
import { parseStructuredContent } from '../../../../shared/chat-content'
import type { BackgroundTaskRow } from '../../../../shared/harness-ui-types'
import { backgroundTaskRailGroup } from '../../../../shared/harness-ui-types'

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
 * Collapse/expand: mocks/index.html ships a `.tracker-rail-toggle` button
 * (id `toggleTrackerRail`) as the rail's first child that toggles a
 * `collapsed` class on the rail, plus a `.rail-mini-badges` summary shown
 * only while collapsed (see global.css `.tracker-rail.collapsed` /
 * `.rail-mini-badges` rules). That affordance was previously missing here —
 * the CSS existed but no button ever rendered it reachable (see
 * e2e/audit-window-resize-layout.spec.ts "(h) tracker rail collapsed state"
 * comment). This wires up the same button/behavior.
 */
export default function TrackerRail({
  messages,
  backgroundTasks = []
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
  const bgSubagents: BackgroundTaskRow[] = []
  const bgShell: BackgroundTaskRow[] = []
  for (const t of backgroundTasks) {
    const g = backgroundTaskRailGroup(t.taskType)
    if (g === 'monitors') bgMonitors.push(t)
    else if (g === 'shell') bgShell.push(t)
    else bgSubagents.push(t)
  }
  const bgRunning = (rows: BackgroundTaskRow[]) =>
    rows.filter((t) => !t.done && t.status !== 'completed' && t.status !== 'failed' && t.status !== 'killed').length

  const hasBg = backgroundTasks.length > 0
  if (todos.length === 0 && subagents.length === 0 && !hasBg) {
    // Render nothing at all (not an empty-but-present rail) — `.tracker-rail`
    // has a fixed width in global.css, so an empty div here would still
    // reserve that width from `.chat-main-col`'s flex space, leaving the
    // transcript/composer narrower than full width for no reason. The mock
    // never shows an empty rail; this matches that.
    return null
  }

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
              {bgRunning(bgMonitors) > 0 ? `${bgRunning(bgMonitors)} running` : `${bgMonitors.length}`}
            </span>
          </div>
          <div className="tracker-body">
            {bgMonitors.map((t) => (
              <BackgroundRailItem key={t.taskId} task={t} />
            ))}
          </div>
        </div>
      )}
      {bgSubagents.length > 0 && (
        <div className="tracker-card" data-testid="background-subagents-card">
          <div className="tracker-head">
            Subagents{' '}
            <span className="count">
              {bgRunning(bgSubagents) > 0 ? `${bgRunning(bgSubagents)} running` : `${bgSubagents.length}`}
            </span>
          </div>
          <div className="tracker-body">
            {bgSubagents.map((t) => (
              <BackgroundRailItem key={t.taskId} task={t} />
            ))}
          </div>
        </div>
      )}
      {bgShell.length > 0 && (
        <div className="tracker-card" data-testid="background-shell-card">
          <div className="tracker-head">
            Shell{' '}
            <span className="count">
              {bgRunning(bgShell) > 0 ? `${bgRunning(bgShell)} running` : `${bgShell.length}`}
            </span>
          </div>
          <div className="tracker-body">
            {bgShell.map((t) => (
              <BackgroundRailItem key={t.taskId} task={t} />
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
        {bgRunning(bgMonitors) + bgRunning(bgSubagents) + bgRunning(bgShell) > 0 && (
          <div className="rail-mini-badge" title="Background tasks running">
            <b>{bgRunning(bgMonitors) + bgRunning(bgSubagents) + bgRunning(bgShell)}</b>
          </div>
        )}
      </div>
    </div>
  )
}

function BackgroundRailItem({ task }: { task: BackgroundTaskRow }): JSX.Element {
  const running = !task.done && task.status !== 'failed' && task.status !== 'completed' && task.status !== 'killed'
  const failed = task.status === 'failed' || Boolean(task.error)
  return (
    <div
      className={`subagent-item${failed ? ' background-rail-failed' : ''}${task.done ? ' background-rail-done' : ''}`}
      data-testid="background-rail-item"
      data-task-id={task.taskId}
    >
      {running && <span className="spinner" />}
      <span>{task.description}</span>
      {task.subtitle && (
        <span className="background-rail-sub" style={{ display: 'block', fontSize: 12, color: 'var(--text-tertiary)' }}>
          {task.subtitle}
        </span>
      )}
    </div>
  )
}
