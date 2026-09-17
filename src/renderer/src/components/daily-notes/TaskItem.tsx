import { useEffect, useRef, useState } from 'react'
import type { DailyTask, ExternalLink } from '../../../../shared/daily-note-types'
import {
  filterDailyNoteTagSuggestions,
  normalizeDailyNoteTag
} from '../../../../shared/daily-note-tags'
import { formatTaskEditBuffer } from '../../../../shared/task-priority'
import TaskMoveContextMenu from './TaskMoveContextMenu'
import { TaskEditInput, TaskPriorityBadge, buildTaskEditPatch } from './task-priority-ui'
import TaskTextDisplay from './TaskTextDisplay'
import type { MoveDateOptions } from './move-date-options'

interface TaskItemProps {
  task: DailyTask
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onUpdateText: (id: string, text: string) => void
  onUpdateTask: (id: string, patch: Partial<DailyTask>) => void
  onUpdateTags: (id: string, tags: string[]) => void
  draggable?: boolean
  /** Root element's data-testid — defaults to "unscheduled-task"; the
   * Trackers section (UC-14, identical mechanics to Unscheduled's UC-12)
   * passes "tracker-task" to match its existing test/selector convention. */
  testId?: string
  /** 16-task-move-to-date: right-click -> "Move to..." menu. Only wired up
   * for the Unscheduled usage of this component — Trackers (and
   * Backlog/Delegated, which don't use TaskItem at all) are out of scope
   * for this feature, so omitting these props there disables the
   * affordance entirely rather than duplicating the menu logic. */
  moveDateOptions?: MoveDateOptions
  onMoveToDate?: (id: string, targetDate: string) => void
  onCreateSessionFromTask?: (task: DailyTask) => void
  showMenuButton?: boolean
}

/** A single "chip" row used by the Unscheduled section (and, without the
 * delete affordance, could be reused elsewhere). Matches the mock's
 * `.task-chip` markup/classnames. */
export default function TaskItem({
  task,
  onToggle,
  onDelete,
  onUpdateText,
  onUpdateTask,
  onUpdateTags,
  draggable = true,
  testId = 'unscheduled-task',
  moveDateOptions,
  onMoveToDate,
  onCreateSessionFromTask,
  showMenuButton = false
}: TaskItemProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(task.text)
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)
  const editInputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (tagPickerOpen) tagInputRef.current?.focus()
  }, [tagPickerOpen])

  function commitEdit(parsed: {
    text: string
    priority?: string
    priorityTouched: boolean
    externalLinks: ExternalLink[]
  }): void {
    const patch = buildTaskEditPatch(task, parsed)
    if (Object.keys(patch).length > 0) onUpdateTask(task.id, patch)
    setEditing(false)
  }

  function cancelEdit(): void {
    setEditText(formatTaskEditBuffer(task))
    setEditing(false)
  }

  function addTag(rawTag: string): void {
    const normalized = normalizeDailyNoteTag(rawTag)
    if (normalized.length <= 1) return
    if (!task.tags.includes(normalized)) onUpdateTags(task.id, [...task.tags, normalized])
    setTagInput('')
    setTagPickerOpen(false)
  }

  function removeTag(tag: string): void {
    onUpdateTags(
      task.id,
      task.tags.filter((t) => t !== tag)
    )
  }

  const suggestions = filterDailyNoteTagSuggestions(tagInput, task.tags).slice(0, 4)

  return (
    <div
      className={`dn-task-chip${showMenuButton ? ' has-menu-button' : ''}${
        task.status === 'done' ? ' done' : ''
      }${task.isNote ? ' meeting' : ''}${editing ? ' editing' : ''}`}
      data-testid={testId}
      data-task-id={task.id}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/task-id', task.id)
        e.dataTransfer.setData('text/task-label', task.text)
      }}
      onContextMenu={(e) => {
        if (!moveDateOptions || !onMoveToDate) return
        e.preventDefault()
        setMoveMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {!task.isNote && <div className="dn-tbox" onClick={() => onToggle(task.id)} />}
      {editing ? (
        <div className="dn-task-input-wrap">
          <TaskEditInput
            autoFocus
            value={editText}
            onChange={setEditText}
            onCommit={commitEdit}
            onCancel={cancelEdit}
            inputRef={editInputRef}
            className="dn-task-edit-input"
            testId="task-edit-input"
          />
        </div>
      ) : (
        <>
          <span
            className="dn-task-chip-text"
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditText(formatTaskEditBuffer(task))
              setEditing(true)
            }}
          >
            <TaskTextDisplay task={task} onRemoveTag={removeTag} />
          </span>
          {task.priority ? <TaskPriorityBadge priority={task.priority} /> : null}
        </>
      )}

      {tagPickerOpen ? (
        <div className="dn-tag-picker" data-testid="tag-picker">
          <input
            ref={tagInputRef}
            className="dn-tag-input"
            data-testid="tag-input"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onBlur={() => setTagPickerOpen(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (tagInput.trim()) addTag(tagInput.trim())
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setTagPickerOpen(false)
              } else if (e.key === 'Tab' && suggestions.length > 0) {
                e.preventDefault()
                addTag(suggestions[0]!)
              }
            }}
          />
          {suggestions.map((s) => (
            <button
              type="button"
              key={s}
              className="dn-tag-suggestion"
              data-testid="tag-suggestion"
              // onMouseDown (not onClick) so the button's press fires before
              // the input's onBlur closes the picker.
              onMouseDown={(e) => {
                e.preventDefault()
                addTag(s)
              }}
            >
              {s}
            </button>
          ))}
        </div>
      ) : (
        <div className="dn-task-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm dn-task-tag-add"
            data-testid="add-tag-button"
            onClick={() => setTagPickerOpen(true)}
          >
            + tag
          </button>
          <button
            className="btn btn-icon btn-sm dn-task-chip-remove"
            aria-label="Delete task"
            onClick={() => onDelete(task.id)}
          >
            ×
          </button>
          {showMenuButton && moveDateOptions && onMoveToDate && (
            <button
              type="button"
              className="btn btn-icon btn-sm dn-task-more"
              data-testid="task-more-button"
              aria-label="Task actions"
              onClick={(event) => {
                event.stopPropagation()
                const rect = event.currentTarget.getBoundingClientRect()
                setMoveMenu({ x: Math.max(4, rect.right - 190), y: rect.bottom })
              }}
            >
              ···
            </button>
          )}
        </div>
      )}

      {moveMenu && moveDateOptions && onMoveToDate && (
        <TaskMoveContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          options={moveDateOptions}
          onSelect={(targetDate) => onMoveToDate(task.id, targetDate)}
          onRename={() => {
            setEditText(formatTaskEditBuffer(task))
            setEditing(true)
          }}
          onCreateSession={onCreateSessionFromTask ? () => onCreateSessionFromTask(task) : undefined}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  )
}
