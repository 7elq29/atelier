import { type RefObject } from 'react'
import { truncateReviewQuote } from '../../../../shared/review-pane-types'

function CommentIcon(): JSX.Element {
  return (
    <svg
      className="icon review-comment-display-icon"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M17 4H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h6l3.5 2.5V16H17a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z" />
      <path d="M12 8v4" />
      <path d="M10 10h4" />
    </svg>
  )
}

/** Compact display for a review comment — quote snippet, line ref, and body. */
export default function ReviewCommentDisplay({
  sourceLineLabel,
  quote,
  body,
  variant = 'stacked',
  editableBody = false,
  onBodyChange,
  bodyInputRef,
  headTestId = 'review-composer-comment-head',
  quoteTestId = 'review-composer-comment-quote',
  lineTestId = 'review-composer-comment-line',
  bodyTestId = 'review-composer-comment-body'
}: {
  sourceLineLabel: string
  quote: string
  body: string
  /** Inline: icon + quote + body + line on one row (composer pending list). */
  variant?: 'inline' | 'stacked'
  /** Composer row: body is an inline text field; quote and line stay styled. */
  editableBody?: boolean
  onBodyChange?: (body: string) => void
  bodyInputRef?: RefObject<HTMLInputElement>
  headTestId?: string
  quoteTestId?: string
  lineTestId?: string
  bodyTestId?: string
}): JSX.Element {
  if (variant === 'inline') {
    return (
      <div className="review-comment-display review-comment-display--inline" data-testid={headTestId}>
        <CommentIcon />
        <span className="review-comment-display-quote" data-testid={quoteTestId} title={quote}>
          &ldquo;{truncateReviewQuote(quote)}&rdquo;
        </span>
        {editableBody ? (
          <input
            ref={bodyInputRef}
            type="text"
            className="review-composer-comment-body-input"
            data-testid={bodyTestId}
            value={body}
            onChange={(e) => onBodyChange?.(e.target.value)}
          />
        ) : body ? (
          <span className="review-comment-display-body" data-testid={bodyTestId}>
            {body}
          </span>
        ) : null}
        <span className="review-comment-display-line" data-testid={lineTestId}>
          line {sourceLineLabel}
        </span>
      </div>
    )
  }

  return (
    <div className="review-comment-display">
      <div className="review-comment-display-head" data-testid={headTestId}>
        <CommentIcon />
        <span className="review-comment-display-quote" data-testid={quoteTestId} title={quote}>
          &ldquo;{truncateReviewQuote(quote)}&rdquo;
        </span>
        <span className="review-comment-display-line" data-testid={lineTestId}>
          line {sourceLineLabel}
        </span>
      </div>
      {body ? (
        <div className="review-comment-display-body" data-testid={bodyTestId}>
          {body}
        </div>
      ) : null}
    </div>
  )
}
