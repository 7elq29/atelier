import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  buildPlanReviewRenderBlocks,
  type PlanReviewRenderBlock
} from '../../../../shared/plan-review-render-blocks'
import {
  formatReviewComposerNote,
  reviewPaneCommentPrefix,
  reviewPaneHasDiff,
  reviewPaneSubtitle,
  reviewPaneTitle,
  type ReviewComposerComment,
  type ReviewPaneTarget
} from '../../../../shared/review-pane-types'
import {
  applyReviewCommentHighlights,
  highlightTopInBody,
  readSelectionQuote,
  selectionIconTop,
  selectionToolbarPosition
} from './review-comment-highlights'
import {
  captureReviewSelectionAnchor,
  type ReviewSelectionAnchor
} from './review-selection-anchor'
import { handleEmacsTextareaKeyDown } from '../../palette-input-keys'
import { createMarkdownComponents } from './MarkdownMessage'
import InlineCommentActions from './InlineCommentActions'
import ReviewCommentDisplay from './ReviewCommentDisplay'
import ReviewSelectionBubble from './ReviewSelectionBubble'

interface ResponseReviewPanelProps {
  target: ReviewPaneTarget
  onClose: () => void
  onAddComment: (note: string) => void
  onUpdateComment?: (oldNote: string, newNote: string) => void
  onDeleteComment?: (composerNote: string) => void
  reviewComments?: readonly ReviewComposerComment[]
  workspaceRoot?: string
  projectRoot?: string
  onOpenFileInFiles?: (relativePath: string) => void
}

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

const MIN_PANE_FRACTION = 0.2
const MAX_PANE_FRACTION = 0.85
const DEFAULT_PANE_FRACTION = 0.5
const COMMENT_GUTTER_WIDTH = 28

let commentIdSeq = 0
function nextCommentId(): string {
  commentIdSeq += 1
  return `review-comment-${commentIdSeq}`
}

function buildReviewBlocks(target: ReviewPaneTarget): PlanReviewRenderBlock[] {
  const previous =
    target.kind === 'plan' || target.kind === 'file' ? target.previousContent : undefined
  return buildPlanReviewRenderBlocks(target.content, previous)
}

function blockKindClass(kind: PlanReviewRenderBlock['kind']): string {
  if (kind === 'mixed') return 'mixed'
  return kind
}

const ReviewMarkdownBlock = memo(function ReviewMarkdownBlock({
  block,
  markdownComponents
}: {
  block: PlanReviewRenderBlock
  markdownComponents: Components
}): JSX.Element {
  return (
    <div
      className={`response-review-block ${blockKindClass(block.kind)}`}
      data-block-key={block.key}
      data-block-kind={block.kind}
      data-testid="response-review-block"
    >
      <div className="response-review-block-content plan-body">
        <div className="md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {block.content}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  )
}, (prev, next) => prev.block.key === next.block.key && prev.block.content === next.block.content)

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

/** Formatted markdown review pane — select text, gutter icon, highlighted quotes. */
export default function ResponseReviewPanel({
  target,
  onClose,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  reviewComments = [],
  workspaceRoot,
  projectRoot,
  onOpenFileInFiles
}: ResponseReviewPanelProps): JSX.Element {
  const paneRef = useRef<HTMLElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const commentInputRef = useRef<HTMLTextAreaElement>(null)
  const [paneWidthPx, setPaneWidthPx] = useState<number | null>(null)
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarState | null>(null)
  const [commentDraftOpen, setCommentDraftOpen] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [openCommentId, setOpenCommentId] = useState<string | null>(null)
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
  const [editCommentText, setEditCommentText] = useState('')
  const [savedComments, setSavedComments] = useState<SavedComment[]>([])
  const [commentIconTops, setCommentIconTops] = useState<Record<string, number>>({})
  const renderBlocks = buildReviewBlocks(target)
  const commentAnchorKey = savedComments
    .map((comment) => `${comment.id}:${comment.anchor.blockKey}:${comment.anchor.start}:${comment.anchor.end}`)
    .join('|')
  const commentAnchorInputs = useMemo(
    () => savedComments.map((comment) => ({ id: comment.id, anchor: comment.anchor })),
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

  const commentPrefix = reviewPaneCommentPrefix(target.kind)
  const hasDiff = reviewPaneHasDiff(target)
  const openComment = savedComments.find((comment) => comment.id === openCommentId) ?? null
  const markdownComponents = useMemo(
    () =>
      createMarkdownComponents({
        workspaceRoot,
        projectRoot,
        onOpenFileInFiles
      }),
    [workspaceRoot, projectRoot, onOpenFileInFiles]
  )

  useEffect(() => {
    setSavedComments([])
    setCommentIconTops({})
    setSelectionToolbar(null)
    setCommentDraftOpen(false)
    setCommentText('')
    setOpenCommentId(null)
    setEditingCommentId(null)
    setEditCommentText('')
    setPaneWidthPx(null)
  }, [target.sourceId, target.kind, target.content, target.previousContent])

  useLayoutEffect(() => {
    if (paneWidthPx !== null) return
    const row = paneRef.current?.closest<HTMLElement>('.chat-body-row')
    if (!row || row.clientWidth <= 0) return
    setPaneWidthPx(Math.round(row.clientWidth * DEFAULT_PANE_FRACTION))
  }, [paneWidthPx, target.sourceId, target.kind])

  useLayoutEffect(() => {
    const contentRoot = contentRef.current
    if (!contentRoot) return

    applyReviewCommentHighlights(contentRoot, commentAnchorInputs)

    contentRoot.querySelectorAll('.response-review-comment-highlight.active').forEach((element) => {
      element.classList.remove('active')
    })
    if (openCommentId) {
      contentRoot
        .querySelectorAll(`[data-comment-id="${openCommentId}"]`)
        .forEach((element) => element.classList.add('active'))
    }
  }, [commentAnchorInputs, commentAnchorKey, openCommentId, target.content, paneWidthPx])

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
  }, [commentAnchorKey, savedComments.length, openCommentId, paneWidthPx])

  useLayoutEffect(() => {
    if (!commentDraftOpen) return
    commentInputRef.current?.focus()
  }, [commentDraftOpen])

  useEffect(() => {
    function onDocumentMouseDown(e: MouseEvent): void {
      const targetEl = e.target as HTMLElement
      if (targetEl.closest?.('.response-review-selection-bubble')) return
      if (targetEl.closest?.('.response-review-selection-chip')) return
      if (targetEl.closest?.('.response-review-inline-comment')) return
      if (targetEl.closest?.('.response-review-comment-popover')) return
      if (targetEl.closest?.('.response-review-comment-icon')) return
      if (targetEl.closest?.('.response-review-comment-highlight')) return
      if (contentRef.current?.contains(targetEl)) {
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
    document.addEventListener('mousedown', onDocumentMouseDown)
    return () => document.removeEventListener('mousedown', onDocumentMouseDown)
  }, [])

  function handleContentMouseUp(): void {
    const contentRoot = contentRef.current
    const bodyRoot = bodyRef.current
    if (!contentRoot || !bodyRoot || commentDraftOpen) return
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) {
      setSelectionToolbar(null)
      return
    }
    const range = selection.getRangeAt(0)
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
    const captured = captureReviewSelectionAnchor(contentRoot, range, renderBlocks)
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
    openCommentPopover(highlight.dataset.commentId)
  }

  function openCommentPopover(commentId: string): void {
    setOpenCommentId((current) => (current === commentId ? null : commentId))
    setEditingCommentId(null)
    setEditCommentText('')
    setSelectionToolbar(null)
    setCommentDraftOpen(false)
    setCommentText('')
  }

  function startResize(e: React.MouseEvent): void {
    e.preventDefault()
    const row = paneRef.current?.closest<HTMLElement>('.chat-body-row')
    const pane = paneRef.current
    if (!row || !pane) return
    const rowEl = row
    const startX = e.clientX
    const startWidth = pane.offsetWidth

    function onMove(ev: MouseEvent): void {
      const next = startWidth + (startX - ev.clientX)
      const min = rowEl.clientWidth * MIN_PANE_FRACTION
      const max = rowEl.clientWidth * MAX_PANE_FRACTION
      setPaneWidthPx(Math.round(Math.min(max, Math.max(min, next))))
    }

    function onUp(): void {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
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
    const contentRoot = contentRef.current
    const bodyRoot = bodyRef.current
    const selection = window.getSelection()
    let anchor = selectionToolbar.anchor
    let sourceLineNumber = selectionToolbar.sourceLineNumber
    let iconTop = selectionToolbar.top
    if (contentRoot && bodyRoot && selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0)
      const captured = captureReviewSelectionAnchor(contentRoot, range, renderBlocks)
      if (captured) {
        anchor = captured.anchor
        sourceLineNumber = captured.sourceLineNumber
      }
      iconTop = selectionIconTop(bodyRoot, range)
    }
    const composerNote = formatReviewComposerNote(
      commentPrefix,
      sourceLineNumber,
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
        sourceLineNumber,
        composerNote,
        anchor
      }
    ])
    setCommentIconTops((prev) => ({ ...prev, [id]: iconTop }))
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

  return (
    <>
      <div
        className="response-review-split-handle"
        data-testid="response-review-split-handle"
        onMouseDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize review pane"
      />
      <aside
        ref={paneRef}
        className="response-review-pane"
        data-testid="response-review-pane"
        data-review-kind={target.kind}
        data-source-id={target.sourceId}
        data-cap-file-path={target.capFilePath ?? undefined}
        data-has-plan-diff={hasDiff ? 'true' : 'false'}
        style={paneWidthPx != null ? { width: paneWidthPx, flex: '0 0 auto' } : { width: `${DEFAULT_PANE_FRACTION * 100}%` }}
      >
        <div className="response-review-head">
          <span data-testid="response-review-title">{reviewPaneTitle(target)}</span>
          <span className="response-review-sub">{reviewPaneSubtitle(target)}</span>
          <button
            type="button"
            className="btn btn-icon btn-sm"
            title="Close review pane"
            data-testid="response-review-close"
            onClick={onClose}
          >
            <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="response-review-body" ref={bodyRef}>
          <div className="response-review-content-grid">
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
                  onClick={() => openCommentPopover(comment.id)}
                >
                  💬
                </button>
              ))}
            </div>
            <div
              className="response-review-rendered-lines"
              data-testid="response-review-content"
              ref={contentRef}
              onMouseUp={handleContentMouseUp}
              onClick={handleContentClick}
            >
              {renderBlocks.map((block) => (
                <ReviewMarkdownBlock
                  key={block.key}
                  block={block}
                  markdownComponents={markdownComponents}
                />
              ))}
            </div>
          </div>

          {openComment ? (
            <div
              className="inline-comment response-review-comment-popover"
              data-testid="response-review-comment-popover"
              style={{
                top: commentIconTops[openComment.id] ?? 0,
                left: COMMENT_GUTTER_WIDTH,
                right: 12
              }}
            >
              {editingCommentId === openComment.id ? (
                <div data-testid="response-review-edit-comment">
                  <textarea
                    rows={2}
                    placeholder="Edit comment…"
                    value={editCommentText}
                    onChange={(e) => setEditCommentText(e.target.value)}
                    data-testid="response-review-comment-input"
                    autoFocus
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
                  <button
                    type="button"
                    className="response-review-saved-comment"
                    data-testid="response-review-saved-comment"
                    title="Click to edit"
                    onClick={() => {
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
                  </button>
                  <InlineCommentActions onDelete={() => deleteComment(openComment)} />
                </>
              )}
            </div>
          ) : null}

          {selectionToolbar && !commentDraftOpen ? (
            <ReviewSelectionBubble
              top={selectionToolbar.top}
              left={selectionToolbar.bubbleLeft}
              onComment={() => setCommentDraftOpen(true)}
            />
          ) : null}

          {selectionToolbar && commentDraftOpen ? (
            <div
              className="inline-comment response-review-inline-comment"
              data-testid="response-review-inline-comment"
              style={{ top: selectionToolbar.top, left: COMMENT_GUTTER_WIDTH, right: 12 }}
            >
              <textarea
                ref={commentInputRef}
                rows={2}
                placeholder="Comment on this selection…"
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                data-testid="response-review-comment-input"
                autoFocus
                onKeyDown={(e) =>
                  handleCommentKeyDown(e, commentText, setCommentText, submitSelectionComment, clearSelectionUi)
                }
              />
              <InlineCommentActions onSubmit={submitSelectionComment} onCancel={clearSelectionUi} />
            </div>
          ) : null}
        </div>
      </aside>
    </>
  )
}
