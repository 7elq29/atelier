/** Compact ✓ / delete / × actions for inline comment drafts (review pane + transcript). */
export default function InlineCommentActions({
  onSubmit,
  onCancel,
  onDelete,
  submitTitle = 'Add to next message',
  cancelTitle = 'Cancel',
  deleteTitle = 'Delete comment',
  submitTestId = 'response-review-comment-submit',
  deleteTestId = 'response-review-comment-delete'
}: {
  onSubmit?: () => void
  onCancel?: () => void
  onDelete?: () => void
  submitTitle?: string
  cancelTitle?: string
  deleteTitle?: string
  submitTestId?: string
  deleteTestId?: string
}): JSX.Element {
  return (
    <div className="inline-comment-actions">
      {onSubmit ? (
        <button
          type="button"
          className="btn btn-icon btn-sm inline-comment-confirm"
          title={submitTitle}
          data-testid={submitTestId}
          onClick={onSubmit}
        >
          <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        </button>
      ) : null}
      {onDelete ? (
        <button
          type="button"
          className="btn btn-icon btn-sm inline-comment-delete"
          title={deleteTitle}
          data-testid={deleteTestId}
          onClick={onDelete}
        >
          <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
        </button>
      ) : null}
      {onCancel ? (
        <button
          type="button"
          className="btn btn-icon btn-sm"
          title={cancelTitle}
          data-testid="response-review-comment-cancel"
          onClick={onCancel}
        >
          <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      ) : null}
    </div>
  )
}
