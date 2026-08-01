import { useRef } from 'react'
import { useDailyNote } from '../../hooks/useDailyNote'
import { useSectionResize } from './section-resize'
import Timeline from './Timeline'
import TaskItem from './TaskItem'

export interface DailyNotesSidebarProps {
  date: string
}

/**
 * Daily Notes sidebar: three independently resizable/scrollable sections —
 * Timeline (time-blocked tasks), Unscheduled (backlog/delegated), Trackers
 * (habit trackers from the `> [!invisible] Trackers` callout). Mirrors
 * `Features/UI-Design/mocks/index.html`'s `.daily-notes-panel` markup and
 * sizing (`.dn-head`, `.dn-section`, `.dn-section-head`, `.dn-resize-handle`,
 * `.dn-section-body`).
 */
export default function DailyNotesSidebar({ date }: DailyNotesSidebarProps): JSX.Element {
  const { note, loading, exists, vaultConfigured, createNote, toggleTask, addTask, deleteTask, moveTask } =
    useDailyNote(date)
  const containerRef = useRef<HTMLDivElement>(null)
  const { weights, startResize } = useSectionResize(containerRef)

  if (!vaultConfigured) {
    return (
      <div className="daily-notes-panel" data-testid="daily-notes-panel">
        <div className="dn-head">
          <span className="dtitle">Daily Notes</span>
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

  return (
    <div className="daily-notes-panel" data-testid="daily-notes-panel" ref={containerRef}>
      <div className="dn-head">
        <span className="dtitle">Daily Notes — {date}</span>
      </div>

      <div className="dn-section" style={{ flexGrow: weights.timeline }} data-testid="timeline-section">
        <div className="dn-section-head">Timeline</div>
        <Timeline
          tasks={dayPlanTasks}
          onToggle={toggleTask}
          onCreate={(text, timeBlock) => addTask(text, 'day-plan', timeBlock)}
          onDropExisting={(id, timeBlock) => moveTask(id, 'day-plan', timeBlock)}
          onDelete={deleteTask}
        />
      </div>

      <div className="dn-resize-handle" onMouseDown={startResize('timeline', 'unscheduled')} />

      <div className="dn-section" style={{ flexGrow: weights.unscheduled }} data-testid="unscheduled-section">
        <div className="dn-section-head">Unscheduled</div>
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
            <TaskItem key={task.id} task={task} onToggle={toggleTask} onDelete={deleteTask} />
          ))}
        </div>
      </div>

      <div className="dn-resize-handle" onMouseDown={startResize('unscheduled', 'trackers')} />

      <div className="dn-section" style={{ flexGrow: weights.trackers }} data-testid="trackers-section">
        <div className="dn-section-head">Trackers</div>
        <div className="dn-section-body scroll-y" data-testid="trackers-body">
          {trackerTasks.map((task) => (
            <div className="dn-tracker-mini" key={task.id} data-testid="tracker-task" data-task-id={task.id}>
              <span>{task.text}</span>
              <div
                className={`dn-tbox${task.status === 'done' ? ' done' : ''}`}
                style={{ marginLeft: 'auto' }}
                onClick={() => toggleTask(task.id)}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
