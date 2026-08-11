import { useEffect, useRef, useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
import { filterDailyNoteTagSuggestions, normalizeDailyNoteTag, formatTaskTextWithInlineTags } from '../../../../shared/daily-note-tags'
import DailyNoteTaskInput from './DailyNoteTaskInput'
import TaskMoveContextMenu from './TaskMoveContextMenu'
import type { MoveDateOptions } from './move-date-options'

interface TaskItemProps {
  task: DailyTask
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onUpdateText: (id: string, text: string) => void
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
}

/** Structural tags managed by section semantics (see daily-note-io.ts's
 * `serializeTaskLine`/`parseBulletLine`) — never shown/removable as a chip,
 * since removing them via the UI would silently corrupt the task's section. */
const STRUCTURAL_TAGS = new Set(['#tracker', '#delegated'])

/** A single "chip" row used by the Unscheduled section (and, without the
 * delete affordance, could be reused elsewhere). Matches the mock's
 * `.task-chip` markup/classnames. */
export default function TaskItem({
  task,
  onToggle,
  onDelete,
  onUpdateText,
  onUpdateTags,
  draggable = true,
  testId = 'unscheduled-task',
  moveDateOptions,
  onMoveToDate,
  onCreateSessionFromTask
}: TaskItemProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(task.text)
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (tagPickerOpen) tagInputRef.current?.focus()
  }, [tagPickerOpen])

  function commitEdit(): void {
    const trimmed = editText.trim()
    if (trimmed) onUpdateText(task.id, trimmed)
    setEditing(false)
  }

  function cancelEdit(): void {
    setEditText(formatTaskTextWithInlineTags(task.text, task.tags))
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

  const visibleTags = task.tags.filter((t) => !STRUCTURAL_TAGS.has(t))
  const suggestions = filterDailyNoteTagSuggestions(tagInput, task.tags).slice(0, 4)

  return (
    <div
      className={`dn-task-chip${task.status === 'done' ? ' done' : ''}${task.isNote ? ' meeting' : ''}${
        editing ? ' editing' : ''
      }`}
      data-testid={testId}
      data-task-id={task.id}
      draggable={draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/task-id', task.id)}
      onContextMenu={(e) => {
        if (!moveDateOptions || !onMoveToDate) return
        e.preventDefault()
        setMoveMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {!task.isNote && <div className="dn-tbox" onClick={() => onToggle(task.id)} />}
      {editing ? (
        <DailyNoteTaskInput
          autoFocus
          value={editText}
          onChange={setEditText}
          inputClassName="dn-task-edit-input"
          testId="task-edit-input"
          onSubmit={commitEdit}
          onCancel={cancelEdit}
          onBlur={commitEdit}
        />
      ) : (
        <span
          onDoubleClick={(e) => {
            e.stopPropagation()
            setEditText(formatTaskTextWithInlineTags(task.text, task.tags))
            setEditing(true)
          }}
        >
          {task.text}
        </span>
      )}

      {visibleTags.map((tag) => (
        <span className="dn-tag-chip" key={tag} data-testid="task-tag-chip">
          {tag}
          <button
            type="button"
            className="dn-tag-chip-remove"
            data-testid="task-tag-remove"
            onClick={() => removeTag(tag)}
            aria-label={`remove tag ${tag}`}
          >
            ×
          </button>
        </span>
      ))}

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
        <button
          type="button"
          className="btn btn-icon btn-sm dn-task-tag-add"
          data-testid="add-tag-button"
          onClick={() => setTagPickerOpen(true)}
        >
          + tag
        </button>
      )}

      <button className="btn btn-icon btn-sm dn-task-chip-remove" onClick={() => onDelete(task.id)}>
        ✕
      </button>

      {moveMenu && moveDateOptions && onMoveToDate && (
        <TaskMoveContextMenu
          x={moveMenu.x}
          y={moveMenu.y}
          options={moveDateOptions}
          onSelect={(targetDate) => onMoveToDate(task.id, targetDate)}
          onRename={() => {
            setEditText(formatTaskTextWithInlineTags(task.text, task.tags))
            setEditing(true)
          }}
          onCreateSession={onCreateSessionFromTask ? () => onCreateSessionFromTask(task) : undefined}
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  )
}
