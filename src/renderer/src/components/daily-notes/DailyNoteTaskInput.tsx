import { useRef, useState } from 'react'
import {
  extractInlineTagsFromText,
  filterDailyNoteTagSuggestions,
  inlineTagQueryAtCursor
} from '../../../../shared/daily-note-tags'

interface DailyNoteTaskInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit?: () => void
  onCancel?: () => void
  onBlur?: () => void
  onMouseDown?: (e: React.MouseEvent) => void
  className?: string
  inputClassName?: string
  testId?: string
  placeholder?: string
  autoFocus?: boolean
}

/** Task text field with `#` autocomplete for predefined Obsidian tags. */
export default function DailyNoteTaskInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  onBlur,
  onMouseDown,
  className,
  inputClassName,
  testId,
  placeholder = 'New task…',
  autoFocus
}: DailyNoteTaskInputProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [cursor, setCursor] = useState(0)

  const syncCursor = (): void => {
    setCursor(inputRef.current?.selectionStart ?? value.length)
  }

  const tagCtx = inlineTagQueryAtCursor(value, cursor)
  const suggestions = tagCtx
    ? filterDailyNoteTagSuggestions(tagCtx.query, extractInlineTagsFromText(value))
    : []

  function applySuggestion(tag: string): void {
    if (!tagCtx) return
    const before = value.slice(0, tagCtx.start)
    const after = value.slice(cursor)
    const next = `${before}${tag} ${after}`
    onChange(next)
    const nextCursor = before.length + tag.length + 1
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(nextCursor, nextCursor)
      setCursor(nextCursor)
    })
  }

  return (
    <div className={className ?? 'dn-task-input-wrap'}>
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        className={inputClassName ?? 'input'}
        data-testid={testId}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setCursor(e.target.selectionStart ?? e.target.value.length)
        }}
        onSelect={syncCursor}
        onKeyUp={syncCursor}
        onClick={syncCursor}
        onMouseDown={onMouseDown}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onSubmit?.()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onCancel?.()
          } else if (e.key === 'Tab' && suggestions.length > 0) {
            e.preventDefault()
            applySuggestion(suggestions[0]!)
          }
        }}
      />
      {suggestions.length > 0 && (
        <div className="dn-inline-tag-suggestions" data-testid="inline-tag-suggestions">
          {suggestions.map((tag) => (
            <button
              type="button"
              key={tag}
              className="dn-tag-suggestion"
              data-testid="inline-tag-suggestion"
              onMouseDown={(e) => {
                e.preventDefault()
                applySuggestion(tag)
              }}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
