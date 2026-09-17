import { useCallback, useEffect, useRef, useState } from 'react'
import {
  TASK_PRIORITY_OPTIONS,
  externalLinksEqual,
  formatPriorityInlineField,
  getPriorityFieldDraft,
  mergeExternalLinks,
  parseExternalLinksFromTaskText,
  parseTaskEditContent,
  priorityDisplayLabel,
  type TaskPriorityOption
} from '../../../../shared/task-priority'
import type { DailyTask, ExternalLink } from '../../../../shared/daily-note-types'
import {
  extractInlineTagsFromText,
  filterDailyNoteTagSuggestions,
  inlineTagQueryAtCursor,
  isDailyNoteBulletFromTags,
  parseInlineTagsFromTaskText
} from '../../../../shared/daily-note-tags'
import { handleEmacsTextareaKeyDown } from '../../palette-input-keys'

export function TaskPriorityBadge({ priority }: { priority: string }): JSX.Element {
  const label = priorityDisplayLabel(priority)
  return (
    <span className="dn-priority-badge" data-testid="task-priority-badge" data-priority={label}>
      {label}
    </span>
  )
}

function insertPriorityFieldAtDraft(
  value: string,
  cursor: number,
  draftStart: number,
  field: string
): { next: string; caret: number } {
  const needsSpace = draftStart > 0 && !/\s/.test(value[draftStart - 1] ?? '')
  const prefix = needsSpace ? ' ' : ''
  const next = `${value.slice(0, draftStart)}${prefix}${field}${value.slice(cursor)}`
  return { next, caret: draftStart + prefix.length + field.length }
}

function insertAtSelection(input: HTMLTextAreaElement, text: string): string {
  const start = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? start
  const before = input.value.slice(0, start)
  const after = input.value.slice(end)
  const fullSelected = start === 0 && end === input.value.length && input.value.length > 0
  if (fullSelected && text.startsWith('[priority::')) {
    const next = `${input.value.trimEnd()} ${text}`.trim()
    const caret = next.length
    requestAnimationFrame(() => input.setSelectionRange(caret, caret))
    return next
  }
  const trimmedBefore = before.endsWith('[') ? before.slice(0, -1) : before
  const next = `${trimmedBefore}${text}${after}`
  const caret = trimmedBefore.length + text.length
  requestAnimationFrame(() => {
    input.setSelectionRange(caret, caret)
  })
  return next
}

interface TaskEditInputProps {
  value: string
  onChange: (value: string) => void
  onCommit: (parsed: {
    text: string
    priority?: string
    priorityTouched: boolean
    externalLinks: ExternalLink[]
  }) => void
  onCancel: () => void
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  className: string
  testId?: string
  autoFocus?: boolean
  /** When true, focus on mount is deferred one tick (after context menus dismiss). */
  deferFocus?: boolean
  /** Blur commits immediately, or only when task text is non-empty (timeline draft). */
  blurPolicy?: 'always' | 'nonEmpty'
  onMouseDown?: (e: React.MouseEvent<HTMLTextAreaElement>) => void
}

/** Task rename input with `[` → priority autocomplete (Obsidian Dataview-style). */
export function TaskEditInput({
  value,
  onChange,
  onCommit,
  onCancel,
  inputRef,
  className,
  testId,
  autoFocus,
  deferFocus,
  blurPolicy = 'always',
  onMouseDown
}: TaskEditInputProps): JSX.Element {
  const [cursor, setCursor] = useState(value.length)
  const [pickerSuppressed, setPickerSuppressed] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const editBufferRef = useRef(value)

  useEffect(() => {
    editBufferRef.current = value
  }, [value])

  const draft = getPriorityFieldDraft(value, cursor)
  const showPriorityMenu = Boolean(draft?.open) && !pickerSuppressed

  // ── # tag autocomplete (same logic as DailyNoteTaskInput) ──
  const tagCtx = inlineTagQueryAtCursor(value, cursor)
  const tagSuggestions = tagCtx
    ? filterDailyNoteTagSuggestions(tagCtx.query, extractInlineTagsFromText(value)).slice(0, 5)
    : []
  const showTagMenu = tagCtx !== null && tagSuggestions.length > 0 && !showPriorityMenu

  const applyTagSuggestion = useCallback((tag: string): void => {
    if (!tagCtx) return
    const before = value.slice(0, tagCtx.start)
    const after = value.slice(cursor)
    const next = `${before}${tag} ${after}`
    onChange(next)
    editBufferRef.current = next
    const nextCaret = before.length + tag.length + 1
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(nextCaret, nextCaret)
      setCursor(nextCaret)
    })
  }, [tagCtx, value, cursor, onChange, inputRef])

  const syncCursor = useCallback((): void => {
    setCursor(inputRef.current?.selectionStart ?? value.length)
  }, [inputRef, value.length])

  const syncTextareaHeight = useCallback((): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [inputRef])

  const commit = useCallback(() => {
    const parsed = parseTaskEditContent(editBufferRef.current)
    onCommit(parsed)
    setPickerSuppressed(false)
  }, [onCommit])

  const applyPriorityOption = useCallback(
    (opt: TaskPriorityOption) => {
      const input = inputRef.current
      if (!input) return
      const buffer = editBufferRef.current
      const caret = input.selectionStart ?? cursor
      const inserted = formatPriorityInlineField(opt.value)
      const activeDraft = getPriorityFieldDraft(buffer, caret)
      const { next, caret: nextCaret } = activeDraft
        ? insertPriorityFieldAtDraft(buffer, caret, activeDraft.start, inserted)
        : (() => {
            const fallback = insertAtSelection(input, inserted)
            return { next: fallback, caret: fallback.length }
          })()
      editBufferRef.current = next
      onChange(next)
      setPickerSuppressed(false)
      requestAnimationFrame(() => {
        input.focus()
        input.setSelectionRange(nextCaret, nextCaret)
        setCursor(nextCaret)
        syncTextareaHeight()
      })
    },
    [cursor, inputRef, onChange, syncTextareaHeight, value]
  )

  useEffect(() => {
    if (showPriorityMenu) setHighlightIndex(0)
  }, [showPriorityMenu])

  useEffect(() => {
    if (!showPriorityMenu) return
    optionRefs.current[highlightIndex]?.scrollIntoView({ block: 'nearest' })
  }, [highlightIndex, showPriorityMenu])

  useEffect(() => {
    syncTextareaHeight()
  }, [value, syncTextareaHeight])

  useEffect(() => {
    if (!autoFocus && !deferFocus) return
    const focusInput = (): void => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      syncTextareaHeight()
      const len = el.value.length
      el.setSelectionRange(len, len)
      setCursor(len)
    }
    if (deferFocus) {
      const t = window.setTimeout(focusInput, 0)
      return () => window.clearTimeout(t)
    }
    focusInput()
  }, [autoFocus, deferFocus, blurPolicy, inputRef, syncTextareaHeight])

  function moveHighlight(delta: number): void {
    setHighlightIndex((i) => {
      const n = TASK_PRIORITY_OPTIONS.length
      return (i + delta + n) % n
    })
  }

  return (
    <>
      <textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        className={className}
        data-testid={testId}
        rows={1}
        value={value}
        onChange={(e) => {
          editBufferRef.current = e.target.value
          onChange(e.target.value)
          setCursor(e.target.selectionStart ?? e.target.value.length)
          setPickerSuppressed(false)
          syncTextareaHeight()
        }}
        onSelect={syncCursor}
        onClick={syncCursor}
        onKeyUp={syncCursor}
        onMouseDown={onMouseDown}
        onBlur={() => {
          if (showPriorityMenu) return
          if (showTagMenu) return
          if (blurPolicy === 'nonEmpty' && !parseTaskEditContent(editBufferRef.current).text.trim()) return
          commit()
        }}
        onKeyDown={(e) => {
          if (showPriorityMenu) {
            if (e.ctrlKey && e.key === 'n') {
              e.preventDefault()
              moveHighlight(1)
              return
            }
            if (e.ctrlKey && e.key === 'p') {
              e.preventDefault()
              moveHighlight(-1)
              return
            }
            if (e.key === 'Enter') {
              e.preventDefault()
              const opt = TASK_PRIORITY_OPTIONS[highlightIndex]
              if (opt) applyPriorityOption(opt)
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              setPickerSuppressed(true)
              return
            }
            if (e.key === 'Tab') {
              e.preventDefault()
              const opt = TASK_PRIORITY_OPTIONS[highlightIndex]
              if (opt) applyPriorityOption(opt)
              return
            }
          }

          // # tag autocomplete: Tab applies first suggestion
          if (showTagMenu && e.key === 'Tab') {
            e.preventDefault()
            if (tagSuggestions[0]) applyTagSuggestion(tagSuggestions[0])
            return
          }

          if (handleEmacsTextareaKeyDown(e, value, onChange)) return

          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      {showPriorityMenu ? (
        <div
          className="dn-inline-field-picker"
          data-testid="task-priority-picker"
          ref={menuRef}
          onMouseDown={(e) => e.preventDefault()}
        >
          {TASK_PRIORITY_OPTIONS.map((opt, i) => (
            <button
              key={opt.value}
              ref={(el) => {
                optionRefs.current[i] = el
              }}
              type="button"
              className={`dn-inline-field-suggestion${i === highlightIndex ? ' is-active' : ''}`}
              data-testid="task-priority-suggestion"
              data-priority-value={opt.value}
              onMouseEnter={() => setHighlightIndex(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                applyPriorityOption(opt)
              }}
            >
              priority:: {opt.menuLabel}
            </button>
          ))}
        </div>
      ) : null}
      {showTagMenu ? (
        <div className="dn-inline-tag-suggestions" data-testid="inline-tag-suggestions" onMouseDown={(e) => e.preventDefault()}>
          {tagSuggestions.map((tag) => (
            <button
              type="button"
              key={tag}
              className="dn-tag-suggestion"
              data-testid="inline-tag-suggestion"
              onMouseDown={(e) => {
                e.preventDefault()
                applyTagSuggestion(tag)
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}

export function commitTaskEdit(
  taskId: string,
  parsed: { text: string; priority?: string; priorityTouched?: boolean },
  current: { text: string; priority?: string },
  updateTask: (id: string, patch: { text?: string; priority?: string }) => void
): void {
  const patch: { text?: string; priority?: string } = {}
  if (parsed.text !== current.text) patch.text = parsed.text
  if (parsed.priorityTouched) {
    patch.priority = parsed.priority
  }
  if (Object.keys(patch).length > 0) updateTask(taskId, patch)
}

/** Merge inline `#tags`, markdown links, and optional `[priority:: …]` from a task rename buffer. */
export function buildTaskEditPatch(
  task: Pick<DailyTask, 'text' | 'tags' | 'externalLinks' | 'priority'>,
  parsed: {
    text: string
    priority?: string
    priorityTouched: boolean
    externalLinks: ExternalLink[]
  }
): Partial<DailyTask> {
  const tagParsed = parseInlineTagsFromTaskText(parsed.text)
  const structural = task.tags.filter((t) => t === '#tracker' || t === '#delegated')
  const structuralSet = new Set<string>(structural)
  const tags = [...structural, ...tagParsed.tags.filter((tag) => !structuralSet.has(tag))]
  const patch: Partial<DailyTask> = {}
  if (tagParsed.text !== task.text) patch.text = tagParsed.text
  const tagsChanged =
    tags.length !== task.tags.length || tags.some((tag, index) => tag !== task.tags[index])
  if (tagsChanged) {
    patch.tags = tags
    patch.isNote = isDailyNoteBulletFromTags(tags)
  }
  if (parsed.priorityTouched) patch.priority = parsed.priority
  const { externalLinks: embeddedLinks } = parseExternalLinksFromTaskText(task.text)
  const currentLinks = mergeExternalLinks(embeddedLinks, task.externalLinks)
  if (!externalLinksEqual(currentLinks, parsed.externalLinks)) {
    patch.externalLinks = parsed.externalLinks
  }
  return patch
}
