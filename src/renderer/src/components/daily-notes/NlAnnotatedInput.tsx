import { useEffect, useRef, useState } from 'react'
import {
  extractInlineTagsFromText,
  filterDailyNoteTagSuggestions,
  inlineTagQueryAtCursor,
} from '../../../../shared/daily-note-tags'
import {
  parseTaskNl,
  type NlEntityKind,
  type NlParseResult,
} from '../../../../shared/task-nl-parse'

interface NlAnnotatedInputProps {
  value: string
  onChange: (raw: string, parsed: NlParseResult) => void
  onCommit: (parsed: NlParseResult) => void
  onCancel: () => void
  onEntityClick: (kind: NlEntityKind, rect: DOMRect) => void
  autoFocus?: boolean
  testId?: string
  className?: string
  /** Entity currently showing a popover — highlight as open. */
  openKind?: NlEntityKind | null
  placeholder?: string
}

/**
 * Quiet-underline NL field: a transparent textarea over a mirrored backdrop
 * of annotated spans. Avoids contenteditable re-render corruption while typing.
 * Also offers `#` tag autocomplete (same list as DailyNoteTaskInput).
 */
export default function NlAnnotatedInput({
  value,
  onChange,
  onCommit,
  onCancel,
  onEntityClick,
  autoFocus,
  testId,
  className,
  openKind,
  placeholder = 'What’s happening? e.g. Sync #meeting at 9:00 am for 1 h',
}: NlAnnotatedInputProps): JSX.Element {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const backdropRef = useRef<HTMLDivElement>(null)
  const valueRef = useRef(value)
  valueRef.current = value
  const [cursor, setCursor] = useState(0)

  const parsed = parseTaskNl(value)
  const tagCtx = inlineTagQueryAtCursor(value, cursor)
  const tagSuggestions = tagCtx
    ? filterDailyNoteTagSuggestions(tagCtx.query, extractInlineTagsFromText(value))
    : []

  useEffect(() => {
    if (!autoFocus) return
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      const len = el.value.length
      el.setSelectionRange(len, len)
      setCursor(len)
    })
  }, [autoFocus])

  // Keep backdrop scroll in sync with textarea
  useEffect(() => {
    const ta = taRef.current
    const back = backdropRef.current
    if (!ta || !back) return
    const sync = (): void => {
      back.scrollTop = ta.scrollTop
      back.scrollLeft = ta.scrollLeft
    }
    ta.addEventListener('scroll', sync)
    return () => ta.removeEventListener('scroll', sync)
  }, [])

  function syncCursor(): void {
    setCursor(taRef.current?.selectionStart ?? value.length)
  }

  function applyTagSuggestion(tag: string): void {
    if (!tagCtx) return
    const before = value.slice(0, tagCtx.start)
    const after = value.slice(cursor)
    const next = `${before}${tag} ${after}`
    onChange(next, parseTaskNl(next))
    const nextCursor = before.length + tag.length + 1
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(nextCursor, nextCursor)
      setCursor(nextCursor)
    })
  }

  function entityRect(kind: NlEntityKind): DOMRect {
    const span = backdropRef.current?.querySelector(
      `.dn-nl-entity--${kind}`
    ) as HTMLElement | null
    return span?.getBoundingClientRect() ?? new DOMRect()
  }

  function tryOpenEntityAtCaret(): boolean {
    const ta = taRef.current
    if (!ta) return false
    const caret = ta.selectionStart ?? 0
    let cursorPos = 0
    for (const seg of parsed.segments) {
      const start = cursorPos
      const end = cursorPos + seg.text.length
      if (seg.kind && caret >= start && caret <= end) {
        // Prefer opening when caret is inside the entity (not only at boundary before)
        if (caret > start || (caret === start && seg.kind)) {
          onEntityClick(seg.kind, entityRect(seg.kind))
          return true
        }
      }
      cursorPos = end
    }
    return false
  }

  return (
    <div
      className={`dn-nl-field${className ? ` ${className}` : ''}${!value ? ' is-empty' : ''}`}
      data-testid={testId}
    >
      <div className="dn-nl-field-stack">
        <div ref={backdropRef} className="dn-nl-backdrop" aria-hidden="true">
          {parsed.segments.map((seg, i) =>
            seg.kind ? (
              <span
                key={i}
                className={`dn-nl-entity dn-nl-entity--${seg.kind}${openKind === seg.kind ? ' is-open' : ''}`}
                data-kind={seg.kind}
              >
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            )
          )}
          {/* Trailing newline keeps height matched when textarea grows */}
          {value.endsWith('\n') ? '\n' : null}
        </div>
        <textarea
          ref={taRef}
          className="dn-nl-textarea"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          rows={2}
          aria-label={placeholder}
          onChange={(e) => {
            const raw = e.target.value.replace(/\n+$/g, '')
            onChange(raw, parseTaskNl(raw))
            setCursor(e.target.selectionStart ?? raw.length)
          }}
          onSelect={syncCursor}
          onKeyUp={syncCursor}
          onClick={() => {
            syncCursor()
            // Clicking an underlined token opens its popover
            tryOpenEntityAtCaret()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && tagSuggestions.length > 0) {
              e.preventDefault()
              applyTagSuggestion(tagSuggestions[0]!)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onCommit(parseTaskNl(valueRef.current))
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              onCancel()
            }
          }}
        />
      </div>
      {tagSuggestions.length > 0 && (
        <div
          className="dn-inline-tag-suggestions"
          data-testid="inline-tag-suggestions"
          onMouseDown={(e) => e.preventDefault()}
        >
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
      )}
    </div>
  )
}
