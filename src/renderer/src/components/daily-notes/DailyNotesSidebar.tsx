import { useEffect, useMemo, useRef, useState } from 'react'
import { useDailyNote } from '../../hooks/useDailyNote'
import { useSectionResize } from './section-resize'
import Timeline from './Timeline'
import TaskItem from './TaskItem'
import { computeMoveDateOptions } from './move-date-options'

export interface DailyNotesSidebarProps {
  date: string
  onClose: () => void
}

type CollapsibleSection = 'unscheduled' | 'tracker'

interface AddTaskInputProps {
  testId: string
  buttonLabel?: string
  onAdd: (text: string) => void
}

/** Shared inline "+ New task" affordance (UC-12/14): collapsed state shows a
 * button; clicking reveals an autofocused text input. Enter/blur with
 * content commits via `onAdd`; Escape/blur with empty content cancels back
 * to the button. */
function AddTaskInput({ testId, buttonLabel = '+ New task', onAdd }: AddTaskInputProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  function commit(): void {
    const trimmed = text.trim()
    if (trimmed) onAdd(trimmed)
    setText('')
    setOpen(false)
  }

  function cancel(): void {
    setText('')
    setOpen(false)
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-sm dn-add-task-button" data-testid={testId} onClick={() => setOpen(true)}>
        {buttonLabel}
      </button>
    )
  }

  return (
    <input
      ref={inputRef}
      className="dn-add-task-input"
      data-testid={`${testId}-input`}
      value={text}
      placeholder="New task…"
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
    />
  )
}

/**
 * Daily Notes sidebar: three independently resizable/scrollable sections —
 * Timeline (time-blocked tasks), Unscheduled (backlog/delegated), Trackers
 * (habit trackers from the `> [!invisible] Trackers` callout). Mirrors
 * `Features/UI-Design/mocks/index.html`'s `.daily-notes-panel` markup and
 * sizing (`.dn-head`, `.dn-section`, `.dn-section-head`, `.dn-resize-handle`,
 * `.dn-section-body`).
 */
export default function DailyNotesSidebar({ date, onClose }: DailyNotesSidebarProps): JSX.Element {
  const {
    note,
    loading,
    exists,
    vaultConfigured,
    createNote,
    toggleTask,
    addTask,
    deleteTask,
    moveTask,
    moveTaskToDate,
    updateTask
  } = useDailyNote(date)
  const containerRef = useRef<HTMLDivElement>(null)
  const { weights, startResize } = useSectionResize(containerRef)
  const [collapsedSections, setCollapsedSections] = useState<Set<CollapsibleSection>>(new Set())
  // 16-task-move-to-date: "today" for the "Move to..." menu's relative
  // labels (tomorrow/weekday-name/next-week) is the date of the note
  // currently open — the app has no other-date navigation today, so this is
  // always the real "today" (or GARDENIA_TEST_DATE in tests).
  const moveDateOptions = useMemo(() => computeMoveDateOptions(date), [date])

  function toggleSection(section: CollapsibleSection): void {
    setCollapsedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  if (!vaultConfigured) {
    return (
      <div className="daily-notes-panel" data-testid="daily-notes-panel">
        <div className="dn-head">
          <span className="dtitle">Daily Notes</span>
          <button className="btn btn-icon btn-sm dn-close-button" data-testid="daily-notes-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dn-empty-state" data-testid="vault-not-configured">
          No vault configured. Set GARDENIA_VAULT_ROOT (or GARDENIA_TEST_VAULT_ROOT for tests).
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="daily-notes-panel" data-testid="daily-notes-panel">
        <div className="dn-head">
          <span className="dtitle">Daily Notes</span>
          <button className="btn btn-icon btn-sm dn-close-button" data-testid="daily-notes-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dn-empty-state">Loading…</div>
      </div>
    )
  }

  if (!exists || !note) {
    return (
      <div className="daily-notes-panel" data-testid="daily-notes-panel">
        <div className="dn-head">
          <span className="dtitle">Daily Notes — {date}</span>
          <button className="btn btn-icon btn-sm dn-close-button" data-testid="daily-notes-close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="dn-empty-state">
          <p>No note for {date} yet.</p>
          <button className="btn btn-primary btn-sm" onClick={createNote} data-testid="create-daily-note">
            Create note
          </button>
        </div>
      </div>
    )
  }

  const dayPlanTasks = note.tasks
    .filter((t) => t.section === 'day-plan')
    .sort((a, b) => (a.timeBlock ?? '').localeCompare(b.timeBlock ?? ''))
  const unscheduledTasks = note.tasks.filter((t) => t.section === 'unscheduled')
  const trackerTasks = note.tasks.filter((t) => t.section === 'tracker')

  const totalActionable = note.tasks.filter(
    (t) => !t.isNote && t.status !== 'forwarded' && t.status !== 'cancelled'
  ).length
  const doneCount = note.tasks.filter((t) => !t.isNote && t.status === 'done').length
  const progressPct = totalActionable > 0 ? (doneCount / totalActionable) * 100 : 0

  const unscheduledCollapsed = collapsedSections.has('unscheduled')
  const trackerCollapsed = collapsedSections.has('tracker')

  return (
    <div className="daily-notes-panel" data-testid="daily-notes-panel" ref={containerRef}>
      <div className="dn-head">
        <div className="dn-head-info">
          <span className="dtitle">Daily Notes — {date}</span>
          <div className="dn-progress-row" data-testid="dn-progress">
            <span className="dn-progress-label">
              {doneCount}/{totalActionable} tasks done
            </span>
            <div className="dn-progress-bar">
              <div className="dn-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>
        <button className="btn btn-icon btn-sm dn-close-button" data-testid="daily-notes-close" onClick={onClose}>
          ×
        </button>
      </div>

      {note.bigThree.length > 0 && (
        <div className="dn-focus-block" data-testid="dn-big-three">
          <div className="dn-focus-heading">Today's Focus</div>
          <ul className="dn-focus-list">
            {note.bigThree.map((item, idx) => (
              <li key={idx} data-testid="dn-big-three-item">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="dn-section" style={{ flexGrow: weights.timeline }} data-testid="timeline-section">
        <div className="dn-section-head">Timeline</div>
        <Timeline
          tasks={dayPlanTasks}
          onToggle={toggleTask}
          onCreate={(text, timeBlock) => addTask(text, 'day-plan', timeBlock)}
          onDropExisting={(id, timeBlock) => moveTask(id, 'day-plan', timeBlock)}
          onDelete={deleteTask}
          moveDateOptions={moveDateOptions}
          onMoveToDate={moveTaskToDate}
        />
      </div>

      {!unscheduledCollapsed && (
        <div className="dn-resize-handle" onMouseDown={startResize('timeline', 'unscheduled')} />
      )}

      <div
        className="dn-section"
        style={{ flexGrow: unscheduledCollapsed ? 0 : weights.unscheduled }}
        data-testid="unscheduled-section"
      >
        <button
          type="button"
          className="dn-section-head dn-section-head-toggle"
          data-testid="unscheduled-collapse-toggle"
          onClick={() => toggleSection('unscheduled')}
        >
          <span className={`dn-chevron${unscheduledCollapsed ? '' : ' expanded'}`}>▶</span>
          Unscheduled
        </button>
        {!unscheduledCollapsed && (
          <>
            <div
              className="dn-section-body scroll-y"
              data-testid="unscheduled-body"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const id = e.dataTransfer.getData('text/task-id')
                if (id) moveTask(id, 'unscheduled', undefined)
              }}
            >
              {unscheduledTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  onToggle={toggleTask}
                  onDelete={deleteTask}
                  onUpdateText={(id, text) => updateTask(id, { text })}
                  onUpdateTags={(id, tags) => updateTask(id, { tags })}
                  moveDateOptions={moveDateOptions}
                  onMoveToDate={moveTaskToDate}
                />
              ))}
            </div>
            <div className="dn-add-task-footer">
              <AddTaskInput testId="add-unscheduled-task" onAdd={(text) => addTask(text, 'unscheduled')} />
            </div>
          </>
        )}
      </div>

      {!unscheduledCollapsed && !trackerCollapsed && (
        <div className="dn-resize-handle" onMouseDown={startResize('unscheduled', 'trackers')} />
      )}

      <div
        className="dn-section"
        style={{ flexGrow: trackerCollapsed ? 0 : weights.trackers }}
        data-testid="trackers-section"
      >
        <button
          type="button"
          className="dn-section-head dn-section-head-toggle"
          data-testid="trackers-collapse-toggle"
          onClick={() => toggleSection('tracker')}
        >
          <span className={`dn-chevron${trackerCollapsed ? '' : ' expanded'}`}>▶</span>
          Trackers
        </button>
        {!trackerCollapsed && (
          <>
            <div className="dn-section-body scroll-y" data-testid="trackers-body">
              {trackerTasks.map((task) => (
                <TaskItem
                  key={task.id}
                  task={task}
                  testId="tracker-task"
                  draggable={false}
                  onToggle={toggleTask}
                  onDelete={deleteTask}
                  onUpdateText={(id, text) => updateTask(id, { text })}
                  onUpdateTags={(id, tags) => updateTask(id, { tags })}
                />
              ))}
            </div>
            <div className="dn-add-task-footer">
              <AddTaskInput testId="add-tracker-task" onAdd={(text) => addTask(text, 'tracker')} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}
