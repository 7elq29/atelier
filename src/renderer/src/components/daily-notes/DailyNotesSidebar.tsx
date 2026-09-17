import { useEffect, useMemo, useRef, useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
import { sortUnscheduledTasksForDisplay } from '../../../../shared/daily-note-unscheduled-order'
import { useDailyNote } from '../../hooks/useDailyNote'
import { useCarrySuggestions } from '../../hooks/useCarrySuggestions'
import { useSectionResize } from './section-resize'
import AgendaTimeline from './AgendaTimeline'
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
 * Daily Notes sidebar. Its default Agenda view is one unified daily overview:
 * compact scheduled work, Unscheduled, prior-day suggestions, then Trackers.
 * "Open schedule" restores the proportional timeline and the persisted,
 * independently resizable section layout for precise time-block editing.
 */
export default function DailyNotesSidebar({ date, onClose, vaultRoot, onCreateSessionFromTask }: DailyNotesSidebarProps): JSX.Element {
  const {
    note,
    loading,
    exists,
    vaultConfigured,
    createNote,
    updateBigThree,
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
  const [unscheduledExpanded, setUnscheduledExpanded] = useState(true)
  const [trackersExpanded, setTrackersExpanded] = useState(true)
  const [carryMoveError, setCarryMoveError] = useState<string | null>(null)
  const [editingBigThree, setEditingBigThree] = useState(false)
  const [bigThreeDraft, setBigThreeDraft] = useState(['', '', ''])
  const [scheduleView, setScheduleView] = useState(false)
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

  function beginBigThreeEdit(): void {
    setBigThreeDraft(Array.from({ length: 3 }, (_, index) => note?.bigThree[index] ?? ''))
    setEditingBigThree(true)
  }

  function cancelBigThreeEdit(): void {
    setEditingBigThree(false)
  }

  function saveBigThree(): void {
    updateBigThree(bigThreeDraft)
    setEditingBigThree(false)
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
          <span className="dtitle">{date}</span>
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
          <span className="dtitle">{date}</span>
          <div className="dn-progress-row" data-testid="dn-progress">
            <span className="dn-progress-label">
              {doneCount}/{totalActionable} tasks done
            </span>
            <div className="dn-progress-bar">
              <div className="dn-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>
        <div className="dn-head-actions">
          <button className="btn btn-icon btn-sm dn-close-button" data-testid="daily-notes-close" onClick={onClose}>
            ×
          </button>
        </div>
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

      <div
        className={`dn-focus-block${editingBigThree ? ' is-editing' : ''}`}
        data-testid="dn-big-three"
      >
          {editingBigThree ? (
            <div className="dn-focus-editor">
              {bigThreeDraft.map((value, index) => (
                <label className="dn-focus-edit-row" key={index}>
                  <span>{index + 1}.</span>
                  <input
                    autoFocus={index === 0}
                    className="input"
                    data-testid="dn-big-three-input"
                    aria-label={`Important priority ${index + 1}`}
                    value={value}
                    onChange={(event) =>
                      setBigThreeDraft((current) =>
                        current.map((item, itemIndex) => (itemIndex === index ? event.target.value : item))
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveBigThree()
                      if (event.key === 'Escape') cancelBigThreeEdit()
                    }}
                  />
                </label>
              ))}
              <div className="dn-focus-editor-actions">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-testid="dn-big-three-cancel"
                  onClick={cancelBigThreeEdit}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  data-testid="dn-big-three-save"
                  onClick={saveBigThree}
                >
                  Save
                </button>
              </div>
            </div>
          ) : note.bigThree.length > 0 ? (
            <ul className="dn-focus-list" data-testid="dn-big-three-list">
              {note.bigThree.map((item, idx) => (
                <li
                  key={idx}
                  data-testid="dn-big-three-item"
                  onContextMenu={(e) => { e.preventDefault(); beginBigThreeEdit() }}
                >
                  {item}
                </li>
              ))}
            </ul>
          ) : (
            <div className="dn-focus-empty">No priorities yet</div>
          )}
      </div>

      <div
        ref={sectionsRef}
        className={`dn-sections-stack ${scheduleView ? 'dn-sections-stack--schedule' : 'dn-sections-stack--agenda scroll-y'}`}
        data-testid={scheduleView ? 'daily-panel-schedule-view' : 'daily-panel-agenda-view'}
      >
      <div
        className={`dn-section dn-timeline-section${scheduleView ? ' dn-timeline-section--schedule' : ''}`}
        style={scheduleView ? { flex: `${weights.timeline} 1 0px` } : undefined}
        data-testid="timeline-section"
      >
        <div className="dn-section-head dn-section-head-row dn-timeline-heading">
          <button
            type="button"
            className="dn-timeline-heading-toggle"
            data-testid={scheduleView ? 'timeline-back-to-agenda' : 'timeline-open-schedule'}
            aria-label={scheduleView ? 'Show agenda' : 'Show schedule'}
            onClick={() => setScheduleView((current) => !current)}
          >
            {scheduleView ? 'Schedule' : 'Today'}
          </button>
          {!scheduleView && !editingBigThree && (
            <button
              type="button"
              className="btn btn-icon btn-sm dn-today-add-daily-three"
              data-testid="dn-today-add-daily-three"
              aria-label="Add to daily three"
              title="Add to daily three"
              onClick={beginBigThreeEdit}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M8 3v10M3 8h10" />
              </svg>
            </button>
          )}
        </div>
        {scheduleView ? (
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
        ) : (
          <AgendaTimeline
            tasks={dayPlanTasks}
            onToggle={toggleTask}
            onMoveToUnscheduled={(id) => moveTask(id, 'unscheduled', undefined)}
            onDropExisting={(id, timeBlock) => moveTask(id, 'day-plan', timeBlock)}
            onCreate={(text, timeBlock) => addTask(text, 'day-plan', timeBlock)}
            onDelete={deleteTask}
            onUpdateText={updateTaskText}
            onUpdateTask={updateTask}
            moveDateOptions={moveDateOptions}
            onMoveToDate={moveTaskToDate}
            onCreateSessionFromTask={onCreateSessionFromTask}
          />
        )}
      </div>

      {scheduleView && unscheduledExpanded && (
        <div className="dn-resize-handle" onMouseDown={startResize('timeline', 'unscheduled')} />
      )}

      <div
        className={`dn-section dn-unscheduled-section${unscheduledExpanded ? '' : ' dn-section-collapsed'}`}
        style={
          scheduleView && unscheduledExpanded
            ? { flex: `${weights.unscheduled} 1 0px` }
            : { flex: '0 0 auto' }
        }
        data-testid="unscheduled-section"
      >
        <div className="dn-section-head dn-section-head-row">
          <button
            type="button"
            className="dn-section-head-toggle"
            data-testid="unscheduled-section-toggle"
            aria-expanded={unscheduledExpanded}
            onClick={() => {
              setUnscheduledExpanded((expanded) => !expanded)
              setAddingUnscheduled(false)
              setUnscheduledDraft('')
            }}
          >
            <span className={`dn-chevron${unscheduledExpanded ? ' expanded' : ''}`} aria-hidden="true">▶</span>
            <span>Unscheduled</span>
          </button>
          {unscheduledExpanded && (
            <button
              type="button"
              className={`btn btn-sm${scheduleView ? ' btn-icon' : ' btn-ghost dn-unscheduled-add-action'}`}
              data-testid="add-unscheduled-task-btn"
              onClick={() => {
                setUnscheduledDraft('')
                setAddingUnscheduled(true)
              }}
            >
              {scheduleView ? '+' : '+ Add'}
            </button>
          )}
        </div>
        {unscheduledExpanded && addingUnscheduled && (
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
        {unscheduledExpanded && (
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
                showMenuButton={!scheduleView}
              />
            ))}
          </div>
        )}
      </div>

      {scheduleView && unscheduledExpanded && showCarrySection ? (
        <div className="dn-resize-handle" onMouseDown={startResize('unscheduled', 'carry')} />
      ) : scheduleView && unscheduledExpanded && trackersExpanded && trackerTasks.length > 0 ? (
        <div className="dn-resize-handle" onMouseDown={startResize('unscheduled', 'trackers')} />
      ) : null}

      {showCarrySection && carry.sourceDate && (
        <>
          <div
            className="dn-section dn-carry-review"
            style={scheduleView ? { flex: `${weights.carry} 1 0px` } : undefined}
            data-testid="carry-section"
          >
            <div className="dn-section-head dn-carry-heading" data-testid="carry-section-head">
              <span>From yesterday</span>
              <span className="dn-section-meta">
                {scheduleView
                  ? carry.sourceDate
                  : `${carry.tasks.length} suggestion${carry.tasks.length === 1 ? '' : 's'}`}
              </span>
            </div>
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
                  compact={!scheduleView}
                />
              ))}
            </div>
          </div>
          {scheduleView && trackersExpanded && trackerTasks.length > 0 && (
            <div className="dn-resize-handle" onMouseDown={startResize('carry', 'trackers')} />
          )}
        </>
      )}

      {trackerTasks.length > 0 && <div
        className={`dn-section dn-trackers-section${trackersExpanded ? '' : ' dn-section-collapsed'}`}
        style={
          scheduleView && trackersExpanded
            ? { flex: `${weights.trackers} 1 0px` }
            : { flex: '0 0 auto' }
        }
        data-testid="trackers-section"
      >
        <div className="dn-section-head">
          <button
            type="button"
            className="dn-section-head-toggle"
            data-testid="trackers-section-toggle"
            aria-expanded={trackersExpanded}
            onClick={() => setTrackersExpanded((expanded) => !expanded)}
          >
            <span className={`dn-chevron${trackersExpanded ? ' expanded' : ''}`} aria-hidden="true">▶</span>
            <span>Trackers</span>
          </button>
        </div>
        {trackersExpanded && (
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
        )}
      </div>}
      </div>
    </div>
  )
}
