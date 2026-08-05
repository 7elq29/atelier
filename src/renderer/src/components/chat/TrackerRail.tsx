import { useState } from 'react'
import type { MessageRecord } from '../../../../shared/session-types'
import { parseStructuredContent } from '../../../../shared/chat-content'

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
export default function TrackerRail({ messages }: { messages: MessageRecord[] }): JSX.Element | null {
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

  if (todos.length === 0 && subagents.length === 0) {
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
      </div>
    </div>
  )
}
