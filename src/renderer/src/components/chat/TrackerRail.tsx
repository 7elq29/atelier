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
  isLive,
}: {
  title: string
  count: string
  isLive?: boolean
}): JSX.Element {
  return (
    <div className="tracker-head">
      <span className="tracker-head-title">{title}</span>
      <span className={`count${isLive ? ' live' : ''}`}>{count}</span>
    </div>
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
      setShowCompleted(false)
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

  return (
    <div className={`tracker-rail${collapsed ? ' collapsed' : ''}`} data-testid="tracker-rail">
      {/* Topbar is always visible — outside the panel so it stays clickable when collapsed */}
      <div className="tracker-topbar">
        <span className="tracker-descriptor">Tracking</span>
        <button
          type="button"
          className="tracker-collapse-btn"
          data-testid="tracker-rail-toggle"
          title={collapsed ? 'Expand' : 'Collapse'}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      {/* Single unified panel surface */}
      <div className="tracker-panel">

        {todos.length > 0 && (
          <div className="tracker-card" data-testid="todo-tracker-card">
            <TrackerCardHead
              title="Todos"
              count={`${doneCount}/${todos.length}`}
            />
            <div className="tracker-body">
              {todos
                .filter((t) => showCompleted || t.status !== 'completed')
                .map((t, i) => {
                  const { label, detail } = splitTodoContent(t.content)
                  const dotClass =
                    t.status === 'completed'
                      ? 'done'
                      : t.status === 'in_progress'
                        ? 'active'
                        : 'pending'
                  return (
                    <div
                      key={i}
                      className={`todo-item${t.status === 'completed' ? ' done' : t.status === 'in_progress' ? ' active' : ''}`}
                      data-testid="todo-item"
                      data-status={t.status}
                    >
                      <div className={`todo-dot ${dotClass}`} aria-hidden="true" />
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
              count={subagentActive > 0 ? `${subagentActive} active` : `${sortedSubagents.length}`}
              isLive={subagentActive > 0}
            />
            <div className="tracker-body">
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
                  ? `${countActiveBackgroundTasks(sortedMonitors)} active`
                  : `${sortedMonitors.length}`
              }
              isLive={countActiveBackgroundTasks(sortedMonitors) > 0}
            />
            <div className="tracker-body">
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
                  ? `${countActiveBackgroundTasks(sortedJobs)} active`
                  : `${sortedJobs.length}`
              }
              isLive={countActiveBackgroundTasks(sortedJobs) > 0}
            />
            <div className="tracker-body">
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
                  ? `${countActiveBackgroundTasks(sortedShell)} active`
                  : `${sortedShell.length}`
              }
              isLive={countActiveBackgroundTasks(sortedShell) > 0}
            />
            <div className="tracker-body">
              {sortedShell.map((t) => (
                <BackgroundTaskRowView key={t.taskId} task={t} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Collapsed strip — shown only when collapsed */}
      <div className="rail-mini-badges" data-testid="tracker-rail-mini-badges">
        {todos.length > 0 && (
          <div className="rail-mini-badge" title={`Todos ${doneCount}/${todos.length}`}>
            <b>{doneCount}/{todos.length}</b>
          </div>
        )}
        {subagentActive > 0 && (
          <div className="rail-mini-badge" title={`Subagents: ${subagentActive} active`}>
            <b>{subagentActive}</b>
          </div>
        )}
        {bgActiveTotal > 0 && (
          <div className="rail-mini-badge" title="Background tasks active">
            <b>{bgActiveTotal}</b>
          </div>
        )}
      </div>
    </div>
  )
}
