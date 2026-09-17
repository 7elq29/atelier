import { useEffect, useState } from 'react'
import type { MessageRecord } from '../../../../shared/session-types'
import { parseStructuredContent } from '../../../../shared/chat-content'
import type { BackgroundTaskRow } from '../../../../shared/harness-ui-types'
import {
  backgroundTaskRailGroup,
  countActiveBackgroundTasks,
  isBackgroundTaskActive,
} from '../../../../shared/background-tasks-ui'
import BackgroundTaskRowView from './BackgroundTaskRowView'

function splitTodoContent(content: string): { label: string; detail?: string } {
  const trimmed = content.trim()
  const paren = trimmed.match(/^(.+?)\s+(\([^)]+\))\s*$/)
  if (paren) {
    return { label: paren[1]!.trim(), detail: paren[2]!.trim() }
  }
  return { label: trimmed }
}

function TrackerCardHead({
  title,
  count,
  collapsed,
  onToggle,
}: {
  title: string
  count: string
  collapsed: boolean
  onToggle: () => void
}): JSX.Element {
  const longLabel = title.includes(' ')
  return (
    <button
      type="button"
      className={`tracker-head${longLabel ? ' tracker-head--long-label' : ''}`}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <span className="tracker-head-title">{title}</span>
      <span className="tracker-head-chevron" aria-hidden="true">
        {collapsed ? '▸' : '▾'}
      </span>
      <span className="count">{count}</span>
    </button>
  )
}

/**
 * Todos + SDK background-task tracker rail (03-chat-surface-core / harness-sdk-events).
 * Subagents (`task_type: subagent`) render here with live SDK status — not in the
 * transcript background card, and not inferred from Task tool rows in SQLite.
 */
export default function TrackerRail({
  messages,
  backgroundTasks = [],
}: {
  messages: MessageRecord[]
  backgroundTasks?: BackgroundTaskRow[]
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  const [collapsedCards, setCollapsedCards] = useState<Set<string>>(() => new Set())
  const [showCompleted, setShowCompleted] = useState(false)
  let todos: { content: string; status: string }[] = []

  for (const m of messages) {
    const parsed = parseStructuredContent(m.content)
    if (!parsed) continue
    if (parsed.kind === 'todo_update') {
      todos = parsed.todos
    }
  }

  const doneCount = todos.filter((t) => t.status === 'completed').length

  useEffect(() => {
    if (todos.length > 0 && doneCount === todos.length) {
      setCollapsedCards((prev) => {
        if (prev.has('todos')) return prev
        const next = new Set(prev)
        next.add('todos')
        return next
      })
    }
  }, [todos.length, doneCount])

  const bgMonitors: BackgroundTaskRow[] = []
  const bgSubagents: BackgroundTaskRow[] = []
  const bgJobs: BackgroundTaskRow[] = []
  const bgShell: BackgroundTaskRow[] = []
  for (const t of backgroundTasks) {
    const g = backgroundTaskRailGroup(t.taskType)
    if (g === 'monitors') bgMonitors.push(t)
    else if (g === 'subagents') bgSubagents.push(t)
    else if (g === 'shell') bgShell.push(t)
    else bgJobs.push(t)
  }

  const sortBg = (tasks: BackgroundTaskRow[]) =>
    [...tasks].sort((a, b) => {
      const aActive = isBackgroundTaskActive(a) ? 0 : 1
      const bActive = isBackgroundTaskActive(b) ? 0 : 1
      if (aActive !== bActive) return aActive - bActive
      return a.description.localeCompare(b.description)
    })
  const sortedMonitors = sortBg(bgMonitors)
  const sortedSubagents = sortBg(bgSubagents)
  const sortedJobs = sortBg(bgJobs)
  const sortedShell = sortBg(bgShell)

  const hasBg = backgroundTasks.length > 0
  if (todos.length === 0 && !hasBg) {
    return null
  }

  const subagentActive = countActiveBackgroundTasks(sortedSubagents)
  const bgActiveTotal =
    countActiveBackgroundTasks(sortedMonitors) +
    countActiveBackgroundTasks(sortedJobs) +
    countActiveBackgroundTasks(sortedShell)

  function toggleCard(cardId: string): void {
    setCollapsedCards((prev) => {
      const next = new Set(prev)
      if (next.has(cardId)) next.delete(cardId)
      else next.add(cardId)
      return next
    })
  }

  function isCardCollapsed(cardId: string): boolean {
    return collapsedCards.has(cardId)
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
          <TrackerCardHead
            title="Todos"
            count={`${doneCount}/${todos.length}`}
            collapsed={isCardCollapsed('todos')}
            onToggle={() => toggleCard('todos')}
          />
          <div className={`tracker-body${isCardCollapsed('todos') ? ' collapsed' : ''}`}>
            {todos.filter((t) => showCompleted || t.status !== 'completed').map((t, i) => {
              const { label, detail } = splitTodoContent(t.content)
              return (
                <div
                  key={i}
                  className={`todo-item${t.status === 'completed' ? ' done' : t.status === 'in_progress' ? ' active' : ''}`}
                  data-testid="todo-item"
                  data-status={t.status}
                >
                  <div className="box" aria-hidden="true" />
                  <div className="todo-item-body">
                    <span className="todo-item-label">{label}</span>
                    {detail ? <span className="todo-item-detail">{detail}</span> : null}
                  </div>
                </div>
              )
            })}
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
      {sortedSubagents.length > 0 && (
        <div className="tracker-card" data-testid="subagent-tracker-card">
          <TrackerCardHead
            title="Subagents"
            count={subagentActive > 0 ? `${subagentActive} running` : `${sortedSubagents.length}`}
            collapsed={isCardCollapsed('subagents')}
            onToggle={() => toggleCard('subagents')}
          />
          <div className={`tracker-body${isCardCollapsed('subagents') ? ' collapsed' : ''}`}>
            {sortedSubagents.map((t) => (
              <BackgroundTaskRowView key={t.taskId} task={t} />
            ))}
          </div>
        </div>
      )}
      {sortedMonitors.length > 0 && (
        <div className="tracker-card" data-testid="background-monitors-card">
          <TrackerCardHead
            title="Monitors"
            count={
              countActiveBackgroundTasks(sortedMonitors) > 0
                ? `${countActiveBackgroundTasks(sortedMonitors)} running`
                : `${sortedMonitors.length}`
            }
            collapsed={isCardCollapsed('monitors')}
            onToggle={() => toggleCard('monitors')}
          />
          <div className={`tracker-body${isCardCollapsed('monitors') ? ' collapsed' : ''}`}>
            {sortedMonitors.map((t) => (
              <BackgroundTaskRowView key={t.taskId} task={t} />
            ))}
          </div>
        </div>
      )}
      {sortedJobs.length > 0 && (
        <div className="tracker-card" data-testid="background-jobs-card">
          <TrackerCardHead
            title="Background jobs"
            count={
              countActiveBackgroundTasks(sortedJobs) > 0
                ? `${countActiveBackgroundTasks(sortedJobs)} running`
                : `${sortedJobs.length}`
            }
            collapsed={isCardCollapsed('jobs')}
            onToggle={() => toggleCard('jobs')}
          />
          <div className={`tracker-body${isCardCollapsed('jobs') ? ' collapsed' : ''}`}>
            {sortedJobs.map((t) => (
              <BackgroundTaskRowView key={t.taskId} task={t} />
            ))}
          </div>
        </div>
      )}
      {sortedShell.length > 0 && (
        <div className="tracker-card" data-testid="background-shell-card">
          <TrackerCardHead
            title="Shell"
            count={
              countActiveBackgroundTasks(sortedShell) > 0
                ? `${countActiveBackgroundTasks(sortedShell)} running`
                : `${sortedShell.length}`
            }
            collapsed={isCardCollapsed('shell')}
            onToggle={() => toggleCard('shell')}
          />
          <div className={`tracker-body${isCardCollapsed('shell') ? ' collapsed' : ''}`}>
            {sortedShell.map((t) => (
              <BackgroundTaskRowView key={t.taskId} task={t} />
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
        {subagentActive > 0 && (
          <div className="rail-mini-badge" title={`Subagents: ${subagentActive} running`}>
            <b>{subagentActive}</b>
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
