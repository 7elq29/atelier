import { useEffect, useRef } from 'react'
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

  const parsed = parseTaskNl(value)

  useEffect(() => {
    if (!autoFocus) return
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.focus()
      const len = el.value.length
      el.setSelectionRange(len, len)
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
    let cursor = 0
    for (const seg of parsed.segments) {
      const start = cursor
      const end = cursor + seg.text.length
      if (seg.kind && caret >= start && caret <= end) {
        // Prefer opening when caret is inside the entity (not only at boundary before)
        if (caret > start || (caret === start && seg.kind)) {
          onEntityClick(seg.kind, entityRect(seg.kind))
          return true
        }
      }
      cursor = end
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
          }}
          onClick={() => {
            // Clicking an underlined token opens its popover
            tryOpenEntityAtCaret()
          }}
          onKeyDown={(e) => {
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
    </div>
  )
}
