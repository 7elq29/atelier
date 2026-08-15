import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { formatReviewComposerNote, type ReviewComposerComment } from '../../../../shared/review-pane-types'
import {
  applyReviewCommentHighlights,
  highlightTopInBody,
  readSelectionQuote,
  selectionToolbarPosition
} from './review-comment-highlights'
import { captureTranscriptSelectionAnchor, type ReviewSelectionAnchor } from './review-selection-anchor'
import InlineCommentActions from './InlineCommentActions'
import ReviewCommentDisplay from './ReviewCommentDisplay'
import ReviewSelectionBubble from './ReviewSelectionBubble'
import { handleEmacsTextareaKeyDown } from '../../palette-input-keys'

interface SavedComment {
  id: string
  quote: string
  text: string
  sourceLineNumber: number
  composerNote: string
  anchor: ReviewSelectionAnchor
}

interface SelectionToolbarState {
  quote: string
  top: number
  left: number
  bubbleLeft: number
  sourceLineNumber: number
  anchor: ReviewSelectionAnchor
}

let commentIdSeq = 0
function nextCommentId(): string {
  commentIdSeq += 1
  return `transcript-comment-${commentIdSeq}`
}

/** Inline select-to-comment on assistant messages and plan bodies in the transcript. */
export default function TranscriptInlineComments({
  messageId,
  sourceContent,
  commentPrefix,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  reviewComments = [],
  children
}: {
  messageId: number
  sourceContent: string
  commentPrefix: 'Re response' | 'Re plan'
  onAddComment: (note: string) => void
  onUpdateComment?: (oldNote: string, newNote: string) => void
  onDeleteComment?: (composerNote: string) => void
  reviewComments?: readonly ReviewComposerComment[]
  children: ReactNode
}): JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const commentInputRef = useRef<HTMLTextAreaElement>(null)
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null)
  const [commentDraftOpen, setCommentDraftOpen] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [openCommentId, setOpenCommentId] = useState<string | null>(null)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editCommentText, setEditCommentText] = useState('')
  const [savedComments, setSavedComments] = useState<SavedComment[]>([])
  const [commentIconTops, setCommentIconTops] = useState<Record<string, number>>({})

  const commentAnchorKey = savedComments
    .map((c) => `${c.id}:${c.anchor.blockKey}:${c.anchor.start}:${c.anchor.end}`)
    .join('|')
  const commentAnchorInputs = useMemo(
    () => savedComments.map((c) => ({ id: c.id, anchor: c.anchor })),
    [commentAnchorKey]
  )
  const pendingNotesKey = reviewComments.map((c) => c.composerNote).join('\0')

  useEffect(() => {
    const notes = new Set(reviewComments.map((c) => c.composerNote))
    setSavedComments((prev) => {
      const next = prev.filter((c) => notes.has(c.composerNote))
      return next.length === prev.length ? prev : next
    })
  }, [pendingNotesKey, reviewComments])

  useEffect(() => {
    if (!openCommentId) return
    if (!savedComments.some((c) => c.id === openCommentId)) {
      setOpenCommentId(null)
      setEditingCommentId(null)
      setEditCommentText('')
    }
  }, [openCommentId, savedComments])

  const openComment = savedComments.find((c) => c.id === openCommentId) ?? null

  useEffect(() => {
    setSavedComments([])
    setCommentIconTops({})
    setSelectionToolbar(null)
    setCommentDraftOpen(false)
    setCommentText('')
    setOpenCommentId(null)
    setEditingCommentId(null)
    setEditCommentText('')
  }, [messageId, sourceContent])

  useLayoutEffect(() => {
    const contentRoot = contentRef.current
    if (!contentRoot) return
    applyReviewCommentHighlights(contentRoot, commentAnchorInputs)
    contentRoot.querySelectorAll('.response-review-comment-highlight.active').forEach((el) => {
      el.classList.remove('active')
    })
    if (openCommentId) {
      contentRoot
        .querySelectorAll(`[data-comment-id="${openCommentId}"]`)
        .forEach((el) => el.classList.add('active'))
    }
  }, [commentAnchorInputs, commentAnchorKey, openCommentId, sourceContent])

  useLayoutEffect(() => {
    const contentRoot = contentRef.current
    const bodyRoot = bodyRef.current
    if (!contentRoot || !bodyRoot || savedComments.length === 0) return
    setCommentIconTops((prev) => {
      let changed = false
      const next = { ...prev }
      for (const comment of savedComments) {
        const iconTop = highlightTopInBody(contentRoot, bodyRoot, comment.id)
        if (iconTop == null) continue
        if (Math.abs((prev[comment.id] ?? 0) - iconTop) < 1) continue
        next[comment.id] = iconTop
        changed = true
      }
      return changed ? next : prev
    })
  }, [commentAnchorKey, savedComments.length, openCommentId])

  useEffect(() => {
    function onDocumentMouseDown(e: MouseEvent): void {
      const targetEl = e.target as HTMLElement
      if (targetEl.closest?.('.response-review-selection-bubble')) return
      if (targetEl.closest?.('.response-review-selection-chip')) return
      if (targetEl.closest?.('.response-review-inline-comment')) return
      if (targetEl.closest?.('.response-review-comment-popover')) return
      if (targetEl.closest?.('.response-review-comment-icon')) return
      if (targetEl.closest?.('.response-review-comment-highlight')) return
      const contentRoot = contentRef.current
      if (contentRoot?.contains(targetEl)) {
        if (!targetEl.closest('.response-review-comment-highlight')) {
          setSelectionToolbar(null)
          setCommentDraftOpen(false)
          setCommentText('')
        }
        return
      }
      setSelectionToolbar(null)
      setCommentDraftOpen(false)
      setCommentText('')
      setOpenCommentId(null)
      setEditingCommentId(null)
      setEditCommentText('')
    }
    function onDocumentMouseUp(e: MouseEvent): void {
      handleContentMouseUp(e)
    }
    document.addEventListener('mousedown', onDocumentMouseDown)
    document.addEventListener('mouseup', onDocumentMouseUp)
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown)
      document.removeEventListener('mouseup', onDocumentMouseUp)
    }
  }, [commentDraftOpen, sourceContent])

  useLayoutEffect(() => {
    if (!commentDraftOpen) return
    commentInputRef.current?.focus()
  }, [commentDraftOpen])

  function handleContentMouseUp(event?: MouseEvent | React.MouseEvent): void {
    const targetEl = (event?.target as HTMLElement | undefined) ?? null
    if (
      targetEl?.closest?.('.response-review-selection-bubble') ||
      targetEl?.closest?.('.response-review-selection-bubble-btn') ||
      targetEl?.closest?.('.response-review-inline-comment') ||
      targetEl?.closest?.('.response-review-comment-popover') ||
      targetEl?.closest?.('.response-review-comment-icon')
    ) {
      return
    }
    const contentRoot = contentRef.current
    const bodyRoot = bodyRef.current
    if (!contentRoot || !bodyRoot || commentDraftOpen) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setSelectionToolbar(null)
      return
    }
    const range = selection.getRangeAt(0)
    if (!contentRoot.contains(range.commonAncestorContainer)) {
      setSelectionToolbar(null)
      return
    }
    const anchorElement =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement
    if (anchorElement?.closest('.response-review-comment-highlight')) {
      setSelectionToolbar(null)
      return
    }
    const quote = readSelectionQuote(contentRoot)
    if (!quote) {
      setSelectionToolbar(null)
      return
    }
    const captured = captureTranscriptSelectionAnchor(contentRoot, range, sourceContent)
    if (!captured) {
      setSelectionToolbar(null)
      return
    }
    const position = selectionToolbarPosition(contentRoot, bodyRoot)
    if (!position) return
    setSelectionToolbar({
      quote,
      ...position,
      sourceLineNumber: captured.sourceLineNumber,
      anchor: captured.anchor
    })
  }

  function handleContentClick(e: React.MouseEvent<HTMLDivElement>): void {
    const highlight = (e.target as HTMLElement).closest<HTMLElement>('[data-comment-id]')
    if (!highlight?.dataset.commentId) return
    e.preventDefault()
    setOpenCommentId((current) => (current === highlight.dataset.commentId ? null : highlight.dataset.commentId!))
    setEditingCommentId(null)
    setEditCommentText('')
    setSelectionToolbar(null)
    setCommentDraftOpen(false)
    setCommentText('')
  }

  function clearSelectionUi(): void {
    setSelectionToolbar(null)
    setCommentDraftOpen(false)
    setCommentText('')
    window.getSelection()?.removeAllRanges()
  }

  function submitSelectionComment(): void {
    if (!selectionToolbar || !commentText.trim()) return
    const body = commentText.trim()
    const composerNote = formatReviewComposerNote(
      commentPrefix,
      selectionToolbar.sourceLineNumber,
      selectionToolbar.quote,
      body
    )
    const id = nextCommentId()
    setSavedComments((prev) => [
      ...prev,
      {
        id,
        quote: selectionToolbar.quote,
        text: body,
        sourceLineNumber: selectionToolbar.sourceLineNumber,
        composerNote,
        anchor: selectionToolbar.anchor
      }
    ])
    onAddComment(composerNote)
    clearSelectionUi()
  }

  function deleteComment(comment: SavedComment): void {
    setSavedComments((prev) => prev.filter((c) => c.id !== comment.id))
    onDeleteComment?.(comment.composerNote)
    setOpenCommentId(null)
    setEditingCommentId(null)
    setEditCommentText('')
  }

  function saveEditedComment(comment: SavedComment): void {
    if (!editCommentText.trim()) return
    const body = editCommentText.trim()
    const newNote = formatReviewComposerNote(
      commentPrefix,
      comment.sourceLineNumber,
      comment.quote,
      body
    )
    setSavedComments((prev) =>
      prev.map((c) => (c.id === comment.id ? { ...c, text: body, composerNote: newNote } : c))
    )
    onUpdateComment?.(comment.composerNote, newNote)
    setEditingCommentId(null)
    setEditCommentText('')
  }

  function handleCommentKeyDown(
    e: KeyboardEvent<HTMLTextAreaElement>,
    value: string,
    setValue: (next: string) => void,
    onSubmit: () => void,
    onCancel: () => void
  ): void {
    if (handleEmacsTextareaKeyDown(e, value, setValue)) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSubmit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="transcript-comment-host" data-testid="transcript-comment-host" data-message-id={messageId}>
      <div className="transcript-comment-body" ref={bodyRef}>
        <div className="transcript-comment-grid">
          <div className="response-review-comment-gutter" aria-hidden={savedComments.length === 0}>
            {savedComments.map((comment) => (
              <button
                key={comment.id}
                type="button"
                className={`response-review-comment-icon${openCommentId === comment.id ? ' active' : ''}`}
                style={{ top: commentIconTops[comment.id] ?? 0 }}
                title="Open comment"
                data-testid="response-review-comment-icon"
                data-line={comment.sourceLineNumber}
                onClick={() => {
                  setOpenCommentId((current) => (current === comment.id ? null : comment.id))
                  setEditingCommentId(null)
                  setEditCommentText('')
                }}
              >
                💬
              </button>
            ))}
          </div>
          <div
            className="transcript-comment-content response-review-rendered-lines"
            data-testid="transcript-comment-content"
            ref={contentRef}
            onMouseUp={(e) => handleContentMouseUp(e)}
            onClick={handleContentClick}
          >
            <div className="response-review-block" data-block-key="root">
              {children}
            </div>
          </div>
        </div>

        {openComment ? (
          <div
            className="inline-comment response-review-comment-popover transcript-comment-popover"
            data-testid="response-review-comment-popover"
            style={{ top: commentIconTops[openComment.id] ?? 0 }}
          >
            {editingCommentId === openComment.id ? (
              <div data-testid="response-review-edit-comment">
                <textarea
                  rows={2}
                  placeholder="Edit comment…"
                  value={editCommentText}
                  data-testid="response-review-comment-input"
                  onChange={(e) => setEditCommentText(e.target.value)}
                  onKeyDown={(e) =>
                    handleCommentKeyDown(
                      e,
                      editCommentText,
                      setEditCommentText,
                      () => saveEditedComment(openComment),
                      () => {
                        setEditingCommentId(null)
                        setEditCommentText('')
                      }
                    )
                  }
                />
                <InlineCommentActions
                  submitTitle="Save comment"
                  onSubmit={() => saveEditedComment(openComment)}
                  onDelete={() => deleteComment(openComment)}
                  onCancel={() => {
                    setEditingCommentId(null)
                    setEditCommentText('')
                  }}
                />
              </div>
            ) : (
              <>
                <div
                  className="response-review-saved-comment"
                  data-testid="response-review-saved-comment"
                  onDoubleClick={() => {
                    setEditingCommentId(openComment.id)
                    setEditCommentText(openComment.text)
                  }}
                >
                  <ReviewCommentDisplay
                    sourceLineLabel={String(openComment.sourceLineNumber)}
                    quote={openComment.quote}
                    body={openComment.text}
                    headTestId="response-review-saved-head"
                    quoteTestId="response-review-saved-quote"
                    lineTestId="response-review-saved-line"
                    bodyTestId="response-review-saved-body"
                  />
                </div>
                <InlineCommentActions onDelete={() => deleteComment(openComment)} />
              </>
            )}
          </div>
        ) : null}

        {selectionToolbar && !commentDraftOpen ? (
          <ReviewSelectionBubble
            className="transcript-comment-selection-bubble"
            top={selectionToolbar.top}
            left={selectionToolbar.bubbleLeft}
            onComment={() => setCommentDraftOpen(true)}
          />
        ) : null}

        {selectionToolbar && commentDraftOpen ? (
          <div
            className="inline-comment response-review-inline-comment transcript-inline-comment"
            data-testid="response-review-inline-comment"
            style={{ top: selectionToolbar.top, left: selectionToolbar.left }}
          >
            <textarea
              ref={commentInputRef}
              rows={2}
              placeholder="Comment on this selection…"
              value={commentText}
              data-testid="response-review-comment-input"
              autoFocus
              onChange={(e) => setCommentText(e.target.value)}
              onKeyDown={(e) =>
                handleCommentKeyDown(e, commentText, setCommentText, submitSelectionComment, clearSelectionUi)
              }
            />
            <InlineCommentActions onSubmit={submitSelectionComment} onCancel={clearSelectionUi} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
