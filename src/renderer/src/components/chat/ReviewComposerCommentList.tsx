import { useEffect, useRef } from 'react'
import type { ReviewComposerComment } from '../../../../shared/review-pane-types'
import ReviewCommentDisplay from './ReviewCommentDisplay'

/** Pending review comments shown above the composer (display only; full notes sent on submit). */
export default function ReviewComposerCommentList({
  comments,
  onUpdateCommentBody,
  onDeleteComment
}: {
  comments: readonly ReviewComposerComment[]
  onUpdateCommentBody: (commentId: string, body: string) => void
  onDeleteComment: (commentId: string) => void
}): JSX.Element | null {
  const prevCountRef = useRef(comments.length)
  const lastBodyInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (comments.length > prevCountRef.current) {
      lastBodyInputRef.current?.focus()
      lastBodyInputRef.current?.select()
    }
    prevCountRef.current = comments.length
  }, [comments.length])

  if (comments.length === 0) return null
  return (
    <div className="review-composer-comment-list" data-testid="review-composer-comment-list">
      <div className="review-composer-comment-panel">
        {comments.map((comment, index) => (
          <div
            key={comment.id}
            className="review-composer-comment-row"
            data-testid="review-composer-comment-card"
          >
            <ReviewCommentDisplay
              variant="inline"
              editableBody
              sourceLineLabel={comment.sourceLineLabel}
              quote={comment.quote}
              body={comment.body}
              bodyInputRef={index === comments.length - 1 ? lastBodyInputRef : undefined}
              onBodyChange={(body) => onUpdateCommentBody(comment.id, body)}
            />
            <button
              type="button"
              className="review-composer-comment-delete"
              title="Delete comment"
              data-testid="review-composer-comment-delete"
              onClick={() => onDeleteComment(comment.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
