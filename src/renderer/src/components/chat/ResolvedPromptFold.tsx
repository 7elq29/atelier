import type { ReactNode } from 'react'

/** Collapsed summary row for a resolved interactive prompt — matches tool-sequence-summary. */
export default function ResolvedPromptFold({
  testId,
  summaryTestId,
  summary,
  open,
  onToggle,
  status,
  headExtra,
  children
}: {
  testId: string
  summaryTestId: string
  summary: string
  open: boolean
  onToggle: () => void
  status?: string
  headExtra?: ReactNode
  children: ReactNode
}): JSX.Element {
  return (
    <div data-testid={testId} data-status={status}>
      <div
        className={`tool-sequence-summary prompt-fold${open ? ' open' : ''}`}
        data-testid={`${testId}-fold`}
        onClick={onToggle}
      >
        <div className="tool-sequence-summary-head">
          <span className="tool-sequence-summary-text" data-testid={summaryTestId}>
            {summary}
          </span>
          {headExtra}
          <span className="tool-chev" aria-hidden="true">
            ▸
          </span>
        </div>
        {open ? (
          <div
            className="tool-sequence-summary-body prompt-fold-body"
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </div>
        ) : null}
      </div>
    </div>
  )
}
