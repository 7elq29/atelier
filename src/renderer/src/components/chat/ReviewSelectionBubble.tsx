/** Google Docs–style pill bubble shown on text selection (comment action). */
export default function ReviewSelectionBubble({
  top,
  left,
  onComment,
  className = ''
}: {
  top: number
  left: number
  onComment: () => void
  className?: string
}): JSX.Element {
  return (
    <div
      className={`response-review-selection-bubble${className ? ` ${className}` : ''}`}
      data-testid="response-review-selection-ui"
      style={{ top, left }}
    >
      <button
        type="button"
        className="response-review-selection-bubble-btn"
        title="Comment on selection"
        data-testid="response-review-comment-btn"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onComment}
      >
        <svg
          className="icon"
          width="20"
          height="20"
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
      </button>
    </div>
  )
}
