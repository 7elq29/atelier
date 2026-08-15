import type { ReviewSelectionAnchor } from './review-selection-anchor'
import { rangeFromReviewSelectionAnchor } from './review-selection-anchor'

const HIGHLIGHT_CLASS = 'response-review-comment-highlight'

export function clearReviewCommentHighlights(contentRoot: HTMLElement): void {
  contentRoot.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((element) => {
    const parent = element.parentNode
    if (!parent) return
    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element)
    }
    parent.removeChild(element)
  })
}

function isInsideHighlight(node: Node): boolean {
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return !!element?.closest(`.${HIGHLIGHT_CLASS}`)
}

/** Split a range into same-text-node segments so we never extract partial elements. */
function collectTextSegments(range: Range): Range[] {
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode!
      : range.commonAncestorContainer

  const segments: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (isInsideHighlight(node)) return NodeFilter.FILTER_REJECT
      try {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT
      } catch {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })

  let node = walker.nextNode() as Text | null
  while (node) {
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : (node.textContent?.length ?? 0)
    if (end > start) {
      const segment = document.createRange()
      segment.setStart(node, start)
      segment.setEnd(node, end)
      segments.push(segment)
    }
    node = walker.nextNode() as Text | null
  }
  return segments
}

function wrapTextRange(range: Range, commentId: string): void {
  const segments = collectTextSegments(range)
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!
    const span = document.createElement('span')
    span.className = HIGHLIGHT_CLASS
    span.dataset.commentId = commentId
    span.dataset.testid = 'response-review-comment-highlight'
    try {
      segment.surroundContents(span)
    } catch {
      // Skip segments that cross element boundaries (shouldn't happen after collectTextSegments).
    }
  }
}

export function highlightReviewCommentAnchor(
  contentRoot: HTMLElement,
  commentId: string,
  anchor: ReviewSelectionAnchor
): boolean {
  const range = rangeFromReviewSelectionAnchor(contentRoot, anchor)
  if (!range) return false
  wrapTextRange(range, commentId)
  return true
}

export function applyReviewCommentHighlights(
  contentRoot: HTMLElement,
  comments: Array<{ id: string; anchor: ReviewSelectionAnchor }>
): void {
  clearReviewCommentHighlights(contentRoot)
  for (const comment of comments) {
    highlightReviewCommentAnchor(contentRoot, comment.id, comment.anchor)
  }
}

export function highlightTopInBody(
  contentRoot: HTMLElement,
  bodyRoot: HTMLElement,
  commentId: string
): number | null {
  const highlight = contentRoot.querySelector<HTMLElement>(`[data-comment-id="${commentId}"]`)
  if (!highlight) return null
  const rect = highlight.getBoundingClientRect()
  const bodyRect = bodyRoot.getBoundingClientRect()
  return rect.top - bodyRect.top + bodyRoot.scrollTop
}

export function readSelectionQuote(contentRoot: HTMLElement): string | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!contentRoot.contains(range.commonAncestorContainer)) return null
  const quote = selection.toString().trim()
  return quote || null
}

export function selectionToolbarPosition(
  contentRoot: HTMLElement,
  bodyRoot: HTMLElement
): { top: number; left: number; bubbleLeft: number } | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  if (!contentRoot.contains(range.commonAncestorContainer)) return null
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  const bodyRect = bodyRoot.getBoundingClientRect()
  return {
    top: rect.bottom - bodyRect.top + bodyRoot.scrollTop,
    left: Math.max(36, rect.left - bodyRect.left),
    bubbleLeft: rect.right - bodyRect.left
  }
}

export function selectionIconTop(bodyRoot: HTMLElement, range: Range): number {
  const rect = range.getBoundingClientRect()
  const bodyRect = bodyRoot.getBoundingClientRect()
  return rect.top - bodyRect.top + bodyRoot.scrollTop
}
