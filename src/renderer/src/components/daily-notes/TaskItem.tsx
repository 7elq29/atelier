import { useEffect, useRef, useState } from 'react'
import type { DailyTask } from '../../../../shared/daily-note-types'
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
}

/** Fixed tag suggestion list (54b list affordances). */
const TAG_SUGGESTIONS = [
  '#p0',
  '#p1',
  '#delegated',
  '#project/spark',
  '#project/unstructured',
  '#project/logging',
  '#ktlo',
  '#q2'
]

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
  onMoveToDate
}: TaskItemProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(task.text)
  const [tagPickerOpen, setTagPickerOpen] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [moveMenu, setMoveMenu] = useState<{ x: number; y: number } | null>(null)
  const editInputRef = useRef<HTMLInputElement>(null)
  const tagInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }
  }, [editing])

  useEffect(() => {
    if (tagPickerOpen) tagInputRef.current?.focus()
  }, [tagPickerOpen])

  function commitEdit(): void {
    const trimmed = editText.trim()
    if (trimmed && trimmed !== task.text) onUpdateText(task.id, trimmed)
    setEditing(false)
  }

  function cancelEdit(): void {
    setEditText(task.text)
    setEditing(false)
  }

  function addTag(rawTag: string): void {
    const normalized = rawTag.startsWith('#') ? rawTag : `#${rawTag}`
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
  const suggestions = TAG_SUGGESTIONS.filter(
    (t) => !task.tags.includes(t) && t.toLowerCase().includes(tagInput.trim().toLowerCase())
  ).slice(0, 4)

  return (
    <div
      className={`dn-task-chip${task.status === 'done' ? ' done' : ''}`}
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
      <div className="dn-tbox" onClick={() => onToggle(task.id)} />
      {editing ? (
        <input
          ref={editInputRef}
          className="dn-task-edit-input"
          data-testid="task-edit-input"
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitEdit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelEdit()
            }
          }}
        />
      ) : (
        <span
          onClick={() => onToggle(task.id)}
          onDoubleClick={(e) => {
            e.stopPropagation()
            setEditText(task.text)
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
          onClose={() => setMoveMenu(null)}
        />
      )}
    </div>
  )
}
