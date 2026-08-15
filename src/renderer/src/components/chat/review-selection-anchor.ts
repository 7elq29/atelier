import {
  isTableSeparatorLine,
  type PlanReviewDisplayLine,
  type PlanReviewRenderBlock
} from '../../../../shared/plan-review-render-blocks'
import { sourceLineNumberForQuote } from '../../../../shared/review-pane-types'

/** Character offsets within a review block's rendered text (stable across re-layout). */
export interface ReviewSelectionAnchor {
  blockKey: string
  start: number
  end: number
}

export const TRANSCRIPT_COMMENT_BLOCK_KEY = 'root'

interface LineTextSpan {
  sourceLineNumber: number
  start: number
  end: number
}

function blockElementForRange(range: Range): Element | null {
  const node = range.commonAncestorContainer
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  return element?.closest('.response-review-block') ?? null
}

function textLengthBefore(root: Element, container: Node, offset: number): number {
  const probe = document.createRange()
  probe.selectNodeContents(root)
  probe.setEnd(container, offset)
  return probe.toString().length
}

function plainTextNeedle(lineContent: string): string {
  return lineContent
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s*)?/, '')
    .replace(/^(\s*)\d+\.\s+(\[[ xX]\]\s*)?/, '')
    .trim()
}

function lineTextSpansForBlock(blockEl: Element, lines: PlanReviewDisplayLine[]): LineTextSpan[] {
  const table = blockEl.querySelector('table')
  if (table) {
    const rows = Array.from(table.querySelectorAll('tr'))
    const spans: LineTextSpan[] = []
    let rowIndex = 0
    for (const line of lines) {
      if (isTableSeparatorLine(line.content)) {
        const at = textLengthBefore(blockEl, table, 0)
        spans.push({ sourceLineNumber: line.sourceLineNumber, start: at, end: at })
        continue
      }
      const row = rows[rowIndex]
      rowIndex += 1
      if (!row) {
        spans.push({
          sourceLineNumber: line.sourceLineNumber,
          start: 0,
          end: blockEl.textContent?.length ?? 0
        })
        continue
      }
      const start = textLengthBefore(blockEl, row, 0)
      const end = start + (row.textContent?.length ?? 0)
      spans.push({ sourceLineNumber: line.sourceLineNumber, start, end })
    }
    return spans
  }

  const pre = blockEl.querySelector('pre')
  if (pre) {
    const preStart = textLengthBefore(blockEl, pre, 0)
    const preText = pre.textContent ?? ''
    const renderedLines = preText.split('\n')
    const spans: LineTextSpan[] = []
    let offset = 0
    for (let index = 0; index < lines.length; index += 1) {
      const rendered = renderedLines[index] ?? lines[index]!.content
      const start = preStart + offset
      const end = start + rendered.length
      spans.push({ sourceLineNumber: lines[index]!.sourceLineNumber, start, end })
      offset += rendered.length + 1
    }
    return spans
  }

  if (lines.length === 1) {
    const total = blockEl.textContent?.length ?? 0
    return [{ sourceLineNumber: lines[0]!.sourceLineNumber, start: 0, end: total }]
  }

  const fullText = blockEl.textContent ?? ''
  const spans: LineTextSpan[] = []
  let searchFrom = 0
  for (const line of lines) {
    const needle = plainTextNeedle(line.content)
    const idx = needle ? fullText.indexOf(needle, searchFrom) : -1
    if (idx >= 0) {
      spans.push({
        sourceLineNumber: line.sourceLineNumber,
        start: idx,
        end: idx + needle.length
      })
      searchFrom = idx + needle.length
      continue
    }
    spans.push({
      sourceLineNumber: line.sourceLineNumber,
      start: searchFrom,
      end: fullText.length
    })
  }
  return spans
}

export function sourceLineNumberForOffset(
  blockEl: Element,
  lines: PlanReviewDisplayLine[],
  offset: number
): number {
  const spans = lineTextSpansForBlock(blockEl, lines)
  for (const span of spans) {
    if (offset >= span.start && offset < span.end) {
      return span.sourceLineNumber
    }
  }
  return spans[spans.length - 1]?.sourceLineNumber ?? lines[0]?.sourceLineNumber ?? 1
}

export function captureReviewSelectionAnchor(
  contentRoot: HTMLElement,
  range: Range,
  renderBlocks: PlanReviewRenderBlock[]
): { anchor: ReviewSelectionAnchor; sourceLineNumber: number } | null {
  const blockEl = blockElementForRange(range)
  if (!blockEl || !contentRoot.contains(blockEl)) return null

  const blockElements = Array.from(contentRoot.querySelectorAll('.response-review-block'))
  const blockIndex = blockElements.indexOf(blockEl)
  const block = renderBlocks[blockIndex]
  if (!block) return null

  const start = textLengthBefore(blockEl, range.startContainer, range.startOffset)
  const end = textLengthBefore(blockEl, range.endContainer, range.endOffset)
  if (end <= start) return null

  return {
    anchor: { blockKey: block.key, start, end },
    sourceLineNumber: sourceLineNumberForOffset(blockEl, block.lines, start)
  }
}

/** Selection anchor for inline comments on transcript markdown (single root block). */
export function captureTranscriptSelectionAnchor(
  contentRoot: HTMLElement,
  range: Range,
  sourceContent: string
): { anchor: ReviewSelectionAnchor; sourceLineNumber: number } | null {
  const blockEl = contentRoot.querySelector('.response-review-block[data-block-key="root"]')
  if (!blockEl || !blockEl.contains(range.commonAncestorContainer)) return null

  const start = textLengthBefore(blockEl, range.startContainer, range.startOffset)
  const end = textLengthBefore(blockEl, range.endContainer, range.endOffset)
  if (end <= start) return null

  const quote = range.toString().trim()
  return {
    anchor: { blockKey: TRANSCRIPT_COMMENT_BLOCK_KEY, start, end },
    sourceLineNumber: sourceLineNumberForQuote(sourceContent, quote)
  }
}

export function rangeFromReviewSelectionAnchor(
  contentRoot: HTMLElement,
  anchor: ReviewSelectionAnchor
): Range | null {
  const blockEl = contentRoot.querySelector<HTMLElement>(
    `.response-review-block[data-block-key="${CSS.escape(anchor.blockKey)}"]`
  )
  if (!blockEl) return null

  let offset = 0
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0

  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement?.closest('.response-review-comment-highlight')) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })

  let node = walker.nextNode() as Text | null
  while (node) {
    const length = node.textContent?.length ?? 0
    if (!startNode && offset + length >= anchor.start) {
      startNode = node
      startOffset = anchor.start - offset
    }
    if (!endNode && offset + length >= anchor.end) {
      endNode = node
      endOffset = anchor.end - offset
      break
    }
    offset += length
    node = walker.nextNode() as Text | null
  }

  if (!startNode || !endNode) return null
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}
