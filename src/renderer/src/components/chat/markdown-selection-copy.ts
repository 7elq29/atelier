type SourcePosition = {
  start?: { offset?: number }
  end?: { offset?: number }
}

type HastNode = {
  type: string
  tagName?: string
  value?: string
  position?: SourcePosition
  properties?: Record<string, unknown>
  children?: HastNode[]
}

const SOURCE_START = 'data-md-source-start'
const SOURCE_END = 'data-md-source-end'
const SOURCE_TEXT = 'data-md-source-text'

function offsets(node: HastNode): { start: number; end: number } | null {
  const start = node.position?.start?.offset
  const end = node.position?.end?.offset
  return typeof start === 'number' && typeof end === 'number' ? { start, end } : null
}

/**
 * Carries remark's source offsets into the rendered DOM. Plain text nodes get
 * transparent spans so partial selections can map character-for-character;
 * links and code retain only their enclosing source range so selecting them
 * includes their otherwise-hidden Markdown syntax.
 */
export function rehypeMarkdownSourcePositions(): (tree: HastNode) => void {
  return (tree) => {
    function visit(parent: HastNode): void {
      if (!parent.children) return
      parent.children = parent.children.map((child) => {
        const childOffsets = offsets(child)
        if (child.type === 'text' && childOffsets && !['a', 'code'].includes(parent.tagName ?? '')) {
          return {
            type: 'element',
            tagName: 'span',
            properties: {
              [SOURCE_START]: childOffsets.start,
              [SOURCE_END]: childOffsets.end,
              [SOURCE_TEXT]: 'true'
            },
            children: [child],
            position: child.position
          }
        }
        if (child.type === 'element' && childOffsets) {
          child.properties = {
            ...child.properties,
            [SOURCE_START]: childOffsets.start,
            [SOURCE_END]: childOffsets.end
          }
        }
        visit(child)
        return child
      })
    }
    visit(tree)
  }
}

function sourceOffset(element: Element, edge: 'start' | 'end'): number | null {
  const value = element.getAttribute(edge === 'start' ? SOURCE_START : SOURCE_END)
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function pointNode(container: Node, offset: number, edge: 'start' | 'end'): Node | null {
  if (container.nodeType === Node.TEXT_NODE) return container
  const children = container.childNodes
  let node =
    edge === 'start'
      ? children[Math.min(offset, Math.max(children.length - 1, 0))]
      : children[Math.max(0, Math.min(offset - 1, children.length - 1))]
  if (!node) return null
  while (node.childNodes.length > 0) {
    node = edge === 'start' ? node.childNodes[0] : node.childNodes[node.childNodes.length - 1]
  }
  return node
}

function rangeContainsNode(range: Range, node: Node): boolean {
  const nodeRange = document.createRange()
  nodeRange.selectNodeContents(node)
  return (
    range.compareBoundaryPoints(Range.START_TO_START, nodeRange) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, nodeRange) >= 0
  )
}

function boundaryOffset(
  root: HTMLElement,
  range: Range,
  container: Node,
  offset: number,
  edge: 'start' | 'end'
): number | null {
  const node = pointNode(container, offset, edge)
  if (!node) return null
  let element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  if (!element || !root.contains(element)) return null

  let best: Element | null = null
  for (let current: Element | null = element; current && current !== root; current = current.parentElement) {
    if (sourceOffset(current, edge) == null || !rangeContainsNode(range, current)) continue
    best = current
  }
  if (best) return sourceOffset(best, edge)

  const textHost = element.closest(`[${SOURCE_TEXT}]`)
  if (textHost && root.contains(textHost) && node.nodeType === Node.TEXT_NODE) {
    const start = sourceOffset(textHost, 'start')
    if (start != null) return start + offset
  }

  const sourceHost = element.closest(`[${edge === 'start' ? SOURCE_START : SOURCE_END}]`)
  return sourceHost && root.contains(sourceHost) ? sourceOffset(sourceHost, edge) : null
}

function selectsWholeRoot(root: HTMLElement, range: Range): boolean {
  const rootRange = document.createRange()
  rootRange.selectNodeContents(root)
  return (
    range.compareBoundaryPoints(Range.START_TO_START, rootRange) <= 0 &&
    range.compareBoundaryPoints(Range.END_TO_END, rootRange) >= 0
  )
}

export function selectedMarkdown(root: HTMLElement, source: string): string | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  if (selectsWholeRoot(root, range)) return source

  const start = boundaryOffset(root, range, range.startContainer, range.startOffset, 'start')
  const end = boundaryOffset(root, range, range.endContainer, range.endOffset, 'end')
  if (start == null || end == null || start >= end) return null
  return source.slice(start, end)
}
