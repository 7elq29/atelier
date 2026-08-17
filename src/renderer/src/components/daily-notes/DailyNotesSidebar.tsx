import { useEffect, useMemo, useRef, useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
import { sortUnscheduledTasksForDisplay } from '../../../../shared/daily-note-unscheduled-order'
import { useDailyNote } from '../../hooks/useDailyNote'
import { useCarrySuggestions } from '../../hooks/useCarrySuggestions'
import { useSectionResize } from './section-resize'
import Timeline from './Timeline'
import TaskItem from './TaskItem'
import CarrySuggestionItem from './CarrySuggestionItem'
import DailyNoteTaskInput from './DailyNoteTaskInput'
import { isDailyNoteBulletFromTags } from '../../../../shared/daily-note-tags'
import { computeMoveDateOptions } from './move-date-options'

export interface DailyNotesSidebarProps {
  date: string
  onClose: () => void
  vaultRoot?: string
  onCreateSessionFromTask?: (task: DailyTask) => void
}

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
    <DailyNoteTaskInput
      autoFocus
      value={text}
      onChange={setText}
      inputClassName="dn-add-task-input"
      testId={`${testId}-input`}
      onSubmit={commit}
      onCancel={cancel}
      onBlur={commit}
    />
  )
}

/**
 * Daily Notes sidebar: four independently resizable/scrollable sections —
 * Timeline (time-blocked tasks), Unscheduled (backlog/delegated), Carry-over
 * (incomplete todos from the prior daily note), Trackers (habit trackers from
 * the `> [!invisible] Trackers` callout). Mirrors
 * `Features/UI-Design/mocks/index.html`'s `.daily-notes-panel` markup and
 * sizing (`.dn-head`, `.dn-section`, `.dn-section-head`, `.dn-resize-handle`,
 * `.dn-section-body`).
 */
export default function DailyNotesSidebar({ date, onClose, vaultRoot, onCreateSessionFromTask }: DailyNotesSidebarProps): JSX.Element {
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
    moveError,
    updateTask,
    updateTaskText
  } = useDailyNote(date, vaultRoot)
  const carry = useCarrySuggestions(date, vaultConfigured)
  const containerRef = useRef<HTMLDivElement>(null)
  const sectionsRef = useRef<HTMLDivElement>(null)
  const { weights, startResize } = useSectionResize(sectionsRef)
  const [addingUnscheduled, setAddingUnscheduled] = useState(false)
  const [unscheduledDraft, setUnscheduledDraft] = useState('')
  const [carryMoveError, setCarryMoveError] = useState<string | null>(null)
  // 16-task-move-to-date: "today" for the "Move to..." menu's relative
  // labels (tomorrow/weekday-name/next-week) is the date of the note
  // currently open — the app has no other-date navigation today, so this is
  // always the real "today" (or ATELIER_TEST_DATE in tests).
  const moveDateOptions = useMemo(() => computeMoveDateOptions(date), [date])

  const taskSignature =
    note?.tasks.map((t) => `${t.id}:${t.status}:${t.text}:${t.section}`).join('|') ?? ''

  useEffect(() => {
    if (vaultConfigured && note) void carry.refresh()
  }, [vaultConfigured, taskSignature, date])

  const showCarrySection = Boolean(carry.sourceDate && !carry.loading && carry.tasks.length > 0)

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
          No vault configured. Set a vault root in Settings → Vault (or ATELIER_VAULT_ROOT for dev/tests).
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
  const unscheduledTasks = sortUnscheduledTasksForDisplay(note.tasks)
  const trackerTasks = note.tasks.filter((t) => t.section === 'tracker')

  const totalActionable = note.tasks.filter(
    (t) => !t.isNote && t.status !== 'forwarded' && t.status !== 'cancelled'
  ).length
  const doneCount = note.tasks.filter((t) => !t.isNote && t.status === 'done').length
  const progressPct = totalActionable > 0 ? (doneCount / totalActionable) * 100 : 0

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

      {moveError && (
        <div style={{ color: 'var(--danger)', fontSize: 13.5, padding: '8px 12px' }} data-testid="move-task-error">
          {moveError}
        </div>
      )}
      {carryMoveError && (
        <div style={{ color: 'var(--danger)', fontSize: 13.5, padding: '8px 12px' }} data-testid="carry-move-error">
          {carryMoveError}
        </div>
      )}

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

      <div ref={sectionsRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
      <div className="dn-section" style={{ flex: `${weights.timeline} 1 0px` }} data-testid="timeline-section">
        <div className="dn-section-head">Timeline</div>
        <Timeline
          tasks={dayPlanTasks}
          onToggle={toggleTask}
          onCreate={(text, timeBlock) => addTask(text, 'day-plan', timeBlock)}
          onDropExisting={(id, timeBlock) => moveTask(id, 'day-plan', timeBlock)}
          onMoveToUnscheduled={(id) => moveTask(id, 'unscheduled', undefined)}
          onDelete={deleteTask}
          onUpdateText={updateTaskText}
          onUpdateTask={updateTask}
          moveDateOptions={moveDateOptions}
          onMoveToDate={moveTaskToDate}
          onCreateSessionFromTask={onCreateSessionFromTask}
        />
      </div>

      <div className="dn-resize-handle" onMouseDown={startResize('timeline', 'unscheduled')} />

      <div
        className="dn-section"
        style={{ flex: `${weights.unscheduled} 1 0px` }}
        data-testid="unscheduled-section"
      >
        <div className="dn-section-head dn-section-head-row">
          <span>Unscheduled</span>
          <button
            type="button"
            className="btn btn-icon btn-sm"
            data-testid="add-unscheduled-task-btn"
            onClick={() => {
              setUnscheduledDraft('')
              setAddingUnscheduled(true)
            }}
          >
            +
          </button>
        </div>
        {addingUnscheduled && (
          <div className="dn-inline-add">
            <DailyNoteTaskInput
              autoFocus
              value={unscheduledDraft}
              onChange={setUnscheduledDraft}
              testId="add-unscheduled-task-input"
              onSubmit={() => {
                const trimmed = unscheduledDraft.trim()
                if (trimmed) addTask(trimmed, 'unscheduled')
                setUnscheduledDraft('')
                setAddingUnscheduled(false)
              }}
              onCancel={() => {
                setUnscheduledDraft('')
                setAddingUnscheduled(false)
              }}
              onBlur={() => {
                const trimmed = unscheduledDraft.trim()
                if (trimmed) addTask(trimmed, 'unscheduled')
                setUnscheduledDraft('')
                setAddingUnscheduled(false)
              }}
            />
          </div>
        )}
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
              onUpdateText={updateTaskText}
              onUpdateTask={updateTask}
              onUpdateTags={(id, tags) =>
                updateTask(id, { tags, isNote: isDailyNoteBulletFromTags(tags) })
              }
              moveDateOptions={moveDateOptions}
              onMoveToDate={moveTaskToDate}
              onCreateSessionFromTask={onCreateSessionFromTask}
            />
          ))}
        </div>
      </div>

      {showCarrySection ? (
        <div className="dn-resize-handle" onMouseDown={startResize('unscheduled', 'carry')} />
      ) : (
        <div className="dn-resize-handle" onMouseDown={startResize('unscheduled', 'trackers')} />
      )}

      {showCarrySection && carry.sourceDate && (
        <>
          <div
            className="dn-section"
            style={{ flex: `${weights.carry} 1 0px` }}
            data-testid="carry-section"
          >
            <div className="dn-section-head" data-testid="carry-section-head">From {carry.sourceDate}</div>
            <div className="dn-section-body scroll-y" data-testid="carry-body">
              {carry.tasks.map((task) => (
                <CarrySuggestionItem
                  key={task.id}
                  task={task}
                  sourceDate={carry.sourceDate!}
                  moveDateOptions={moveDateOptions}
                  onComplete={() => void carry.completeOnSource(carry.sourceDate!, task.id)}
                  onMoveToToday={async () => {
                    setCarryMoveError(null)
                    const err = await carry.moveToDate(carry.sourceDate!, task.id, date)
                    if (err) setCarryMoveError(err)
                  }}
                  onMoveToDate={async (targetDate) => {
                    setCarryMoveError(null)
                    const err = await carry.moveToDate(carry.sourceDate!, task.id, targetDate)
                    if (err) setCarryMoveError(err)
                  }}
                  onDismiss={() => carry.dismiss(carry.sourceDate!, task.gid)}
                />
              ))}
            </div>
          </div>
          <div className="dn-resize-handle" onMouseDown={startResize('carry', 'trackers')} />
        </>
      )}

      <div
        className="dn-section"
        style={{ flex: `${weights.trackers} 1 0px` }}
        data-testid="trackers-section"
      >
        <div className="dn-section-head">Trackers</div>
        <div className="dn-section-body scroll-y" data-testid="trackers-body">
          {trackerTasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              testId="tracker-task"
              draggable={false}
              onToggle={toggleTask}
              onDelete={deleteTask}
              onUpdateText={updateTaskText}
              onUpdateTask={updateTask}
              onUpdateTags={(id, tags) =>
                updateTask(id, { tags, isNote: isDailyNoteBulletFromTags(tags) })
              }
            />
          ))}
        </div>
      </div>
      </div>
    </div>
  )
}
