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
 */
export default function TrackerRail({ messages }: { messages: MessageRecord[] }): JSX.Element {
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
    return <div className="tracker-rail" data-testid="tracker-rail" />
  }

  return (
    <div className="tracker-rail" data-testid="tracker-rail">
      {todos.length > 0 && (
        <div className="tracker-card" data-testid="todo-tracker-card">
          <div className="tracker-head">
            Todos{' '}
            <span className="count">
              {doneCount}/{todos.length}
            </span>
          </div>
          <div className="tracker-body">
            {todos.map((t, i) => (
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
          </div>
        </div>
      )}
      {subagents.length > 0 && (
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
    </div>
  )
}
