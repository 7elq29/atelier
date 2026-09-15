import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type MutableRefObject
} from 'react'
import * as monaco from 'monaco-editor'
import {
  buildPlanReviewDisplayLines,
  type PlanReviewDisplayLine
} from '../../../../shared/plan-review-render-blocks'
import { ensureAtelierMonacoThemes, monacoThemeId } from '../../editor/atelier-monaco-theme'
import { registerEmacsMonacoKeybindings } from '../../editor/emacs-monaco-keybindings'
import { detectLanguageFromPath } from '../../editor/monaco-language'
import type { ReviewSelectionAnchor } from './review-selection-anchor'

ensureAtelierMonacoThemes()

const LINE_HEIGHT = 21
const HIGHLIGHT_CLASS = 'response-review-comment-highlight'

export const REVIEW_FILE_MONACO_BLOCK_KEY = 'file-monaco'
export const REVIEW_FILE_MONACO_DEL_PREFIX = 'file-monaco-del:'

export function reviewFileMonacoDelBlockKey(displayLineKey: string): string {
  return `${REVIEW_FILE_MONACO_DEL_PREFIX}${displayLineKey}`
}

export function isReviewFileMonacoDelAnchor(blockKey: string): boolean {
  return blockKey.startsWith(REVIEW_FILE_MONACO_DEL_PREFIX)
}

export interface ReviewFileMonacoSelection {
  quote: string
  sourceLineNumber: number
  anchor: ReviewSelectionAnchor
  top: number
  left: number
  bubbleLeft: number
}

export interface ReviewFileMonacoEditorHandle {
  anchorTopInBody(bodyRoot: HTMLElement, anchor: ReviewSelectionAnchor): number | null
  getHostElement(): HTMLElement | null
  clearSelection(): void
}

interface CommentAnchorInput {
  id: string
  anchor: ReviewSelectionAnchor
  active?: boolean
}

function modelUri(scopeKey: string, filePath: string): monaco.Uri {
  return monaco.Uri.parse(`atelier-review://${scopeKey}/${encodeURIComponent(filePath)}`)
}

function positionTopInBody(
  bodyRoot: HTMLElement,
  host: HTMLElement,
  editor: monaco.editor.IStandaloneCodeEditor,
  position: monaco.IPosition
): number | null {
  const pos = editor.getScrolledVisiblePosition(position)
  if (!pos) return null
  const bodyRect = bodyRoot.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  return hostRect.top - bodyRect.top + bodyRoot.scrollTop + pos.top
}

function clearDeletedLineHighlights(host: HTMLElement): void {
  host.querySelectorAll(`.diff-full-deleted-line .${HIGHLIGHT_CLASS}`).forEach((element) => {
    const parent = element.parentNode
    if (!parent) return
    while (element.firstChild) {
      parent.insertBefore(element.firstChild, element)
    }
    parent.removeChild(element)
  })
  host.querySelectorAll('.diff-full-deleted-line[data-comment-active]').forEach((element) => {
    element.removeAttribute('data-comment-active')
    element.classList.remove('active')
  })
}

function applyDeletedLineHighlight(
  lineEl: HTMLElement,
  commentId: string,
  anchor: ReviewSelectionAnchor,
  active: boolean
): void {
  const lineText = lineEl.textContent ?? ''
  const start = Math.max(0, Math.min(anchor.start, lineText.length))
  const end = Math.max(start, Math.min(anchor.end, lineText.length))
  if (end <= start) return

  if (start === 0 && end >= lineText.length) {
    lineEl.dataset.commentId = commentId
    if (active) {
      lineEl.dataset.commentActive = 'true'
      lineEl.classList.add(HIGHLIGHT_CLASS, 'active')
    } else {
      lineEl.classList.add(HIGHLIGHT_CLASS)
    }
    return
  }

  const textNode = lineEl.firstChild
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) return
  const range = document.createRange()
  range.setStart(textNode, start)
  range.setEnd(textNode, end)
  const span = document.createElement('span')
  span.className = active ? `${HIGHLIGHT_CLASS} active` : HIGHLIGHT_CLASS
  span.dataset.commentId = commentId
  span.dataset.testid = 'response-review-comment-highlight'
  try {
    range.surroundContents(span)
  } catch {
    // Selection crosses an existing highlight — skip partial wrap.
  }
}

function applyPlanReviewDiffDecorations(
  editor: monaco.editor.IStandaloneCodeEditor,
  host: HTMLElement,
  content: string,
  previousContent: string | undefined,
  deletedLineRefs: MutableRefObject<Map<string, HTMLElement>>
): { decorations: monaco.editor.IEditorDecorationsCollection; zoneIds: string[] } {
  const displayLines = buildPlanReviewDisplayLines(content, previousContent)
  const decorations: monaco.editor.IModelDeltaDecoration[] = []
  const zoneSpecs: { afterLineNumber: number; lines: PlanReviewDisplayLine[] }[] = []
  let pendingDel: PlanReviewDisplayLine[] = []

  const flushDelsBefore = (beforeNewLine: number): void => {
    if (pendingDel.length === 0) return
    zoneSpecs.push({
      afterLineNumber: Math.max(0, beforeNewLine - 1),
      lines: [...pendingDel]
    })
    pendingDel = []
  }

  for (const line of displayLines) {
    if (line.kind === 'del') {
      pendingDel.push(line)
      continue
    }
    flushDelsBefore(line.sourceLineNumber)
    if (line.kind === 'add') {
      decorations.push({
        range: new monaco.Range(line.sourceLineNumber, 1, line.sourceLineNumber, 1),
        options: { isWholeLine: true, className: 'diff-full-line-add' }
      })
    }
  }

  if (pendingDel.length > 0) {
    const model = editor.getModel()
    const after = model ? model.getLineCount() : 0
    zoneSpecs.push({ afterLineNumber: after, lines: pendingDel })
  }

  const collection = editor.createDecorationsCollection(decorations)
  const zoneIds: string[] = []
  const nextDeletedRefs = new Map<string, HTMLElement>()

  editor.changeViewZones((accessor) => {
    for (const spec of zoneSpecs) {
      const domNode = document.createElement('div')
      domNode.className = 'diff-full-deleted-zone'
      for (const line of spec.lines) {
        const row = document.createElement('div')
        row.className = 'diff-full-deleted-line'
        row.dataset.deletedLineKey = line.key
        row.dataset.sourceLineNumber = String(line.sourceLineNumber)
        row.textContent = line.content
        domNode.appendChild(row)
        nextDeletedRefs.set(line.key, row)
      }
      const id = accessor.addZone({
        afterLineNumber: spec.afterLineNumber,
        heightInPx: spec.lines.length * LINE_HEIGHT,
        domNode
      })
      zoneIds.push(id)
    }
  })

  deletedLineRefs.current = nextDeletedRefs
  clearDeletedLineHighlights(host)
  return { decorations: collection, zoneIds }
}

function applyModelCommentDecorations(
  editor: monaco.editor.IStandaloneCodeEditor,
  commentAnchors: CommentAnchorInput[]
): monaco.editor.IEditorDecorationsCollection {
  const model = editor.getModel()
  if (!model) return editor.createDecorationsCollection([])

  const decorations: monaco.editor.IModelDeltaDecoration[] = []
  for (const comment of commentAnchors) {
    if (isReviewFileMonacoDelAnchor(comment.anchor.blockKey)) continue
    if (comment.anchor.blockKey !== REVIEW_FILE_MONACO_BLOCK_KEY) continue
    const startPos = model.getPositionAt(comment.anchor.start)
    const endPos = model.getPositionAt(comment.anchor.end)
    decorations.push({
      range: new monaco.Range(
        startPos.lineNumber,
        startPos.column,
        endPos.lineNumber,
        endPos.column
      ),
      options: {
        inlineClassName: comment.active
          ? 'response-review-comment-highlight active'
          : 'response-review-comment-highlight',
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
      }
    })
  }
  return editor.createDecorationsCollection(decorations)
}

function applyDeletedCommentHighlights(
  host: HTMLElement,
  deletedLineRefs: Map<string, HTMLElement>,
  commentAnchors: CommentAnchorInput[]
): void {
  clearDeletedLineHighlights(host)
  for (const comment of commentAnchors) {
    if (!isReviewFileMonacoDelAnchor(comment.anchor.blockKey)) continue
    const lineKey = comment.anchor.blockKey.slice(REVIEW_FILE_MONACO_DEL_PREFIX.length)
    const lineEl = deletedLineRefs.get(lineKey)
    if (!lineEl) continue
    applyDeletedLineHighlight(lineEl, comment.id, comment.anchor, !!comment.active)
  }
}

const ReviewFileMonacoEditor = forwardRef<
  ReviewFileMonacoEditorHandle,
  {
    filePath: string
    content: string
    previousContent?: string
    effectiveTheme: 'light' | 'dark'
    scopeKey: string
    commentAnchors: CommentAnchorInput[]
    onSelection: (selection: ReviewFileMonacoSelection | null) => void
    onCommentAnchorClick: (commentId: string) => void
    onScroll: () => void
  }
>(function ReviewFileMonacoEditor(
  {
    filePath,
    content,
    previousContent,
    effectiveTheme,
    scopeKey,
    commentAnchors,
    onSelection,
    onCommentAnchorClick,
    onScroll
  },
  ref
): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [editorReady, setEditorReady] = useState(false)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const diffDecorationRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const commentDecorationRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const viewZoneIdsRef = useRef<string[]>([])
  const deletedLineRefs = useRef<Map<string, HTMLElement>>(new Map())
  const onSelectionRef = useRef(onSelection)
  const onCommentAnchorClickRef = useRef(onCommentAnchorClick)
  const onScrollRef = useRef(onScroll)
  const commentAnchorsRef = useRef(commentAnchors)
  onSelectionRef.current = onSelection
  onCommentAnchorClickRef.current = onCommentAnchorClick
  onScrollRef.current = onScroll
  commentAnchorsRef.current = commentAnchors

  const clearDiffUi = useCallback((editor: monaco.editor.IStandaloneCodeEditor | null) => {
    diffDecorationRef.current?.clear()
    diffDecorationRef.current = null
    commentDecorationRef.current?.clear()
    commentDecorationRef.current = null
    if (editor && viewZoneIdsRef.current.length > 0) {
      const ids = viewZoneIdsRef.current
      viewZoneIdsRef.current = []
      editor.changeViewZones((accessor) => {
        for (const id of ids) accessor.removeZone(id)
      })
    }
    deletedLineRefs.current = new Map()
  }, [])

  useImperativeHandle(ref, () => ({
    anchorTopInBody(bodyRoot: HTMLElement, anchor: ReviewSelectionAnchor): number | null {
      const editor = editorRef.current
      const host = hostRef.current
      if (!host) return null

      if (isReviewFileMonacoDelAnchor(anchor.blockKey)) {
        const lineKey = anchor.blockKey.slice(REVIEW_FILE_MONACO_DEL_PREFIX.length)
        const lineEl =
          deletedLineRefs.current.get(lineKey) ??
          host.querySelector<HTMLElement>(`.diff-full-deleted-line[data-deleted-line-key="${CSS.escape(lineKey)}"]`)
        if (!lineEl) return null
        const highlight = lineEl.querySelector<HTMLElement>(`[data-comment-id]`) ?? lineEl
        const rect = highlight.getBoundingClientRect()
        const bodyRect = bodyRoot.getBoundingClientRect()
        return rect.top - bodyRect.top + bodyRoot.scrollTop
      }

      if (!editor) return null
      const model = editor.getModel()
      if (!model || anchor.blockKey !== REVIEW_FILE_MONACO_BLOCK_KEY) return null
      const startPos = model.getPositionAt(anchor.start)
      return positionTopInBody(bodyRoot, host, editor, startPos)
    },
    getHostElement(): HTMLElement | null {
      return hostRef.current
    },
    clearSelection(): void {
      const editor = editorRef.current
      if (!editor) return
      const model = editor.getModel()
      if (!model) return
      editor.setSelection(new monaco.Selection(1, 1, 1, 1))
      onSelectionRef.current(null)
    }
  }))

  const publishEditorSelection = useCallback(() => {
    const editor = editorRef.current
    const host = hostRef.current
    if (!editor || !host) {
      onSelectionRef.current(null)
      return
    }
    const model = editor.getModel()
    const selection = editor.getSelection()
    if (!model || !selection || selection.isEmpty()) {
      onSelectionRef.current(null)
      return
    }
    const quote = model.getValueInRange(selection).trim()
    if (!quote) {
      onSelectionRef.current(null)
      return
    }
    const start = model.getOffsetAt(selection.getStartPosition())
    const end = model.getOffsetAt(selection.getEndPosition())
    const startPos = editor.getScrolledVisiblePosition(selection.getStartPosition())
    const endPos = editor.getScrolledVisiblePosition(selection.getEndPosition())
    if (!startPos) {
      onSelectionRef.current(null)
      return
    }
    const fontInfo = editor.getOption(monaco.editor.EditorOption.fontInfo)
    const charWidth = fontInfo.typicalHalfwidthCharacterWidth
    let bubbleLeft = startPos.left + charWidth
    if (endPos) {
      if (selection.startLineNumber === selection.endLineNumber) {
        bubbleLeft = endPos.left + Math.max(charWidth, (selection.endColumn - selection.startColumn) * charWidth)
      } else {
        bubbleLeft = endPos.left + charWidth
      }
    }
    const bodyRect = host.getBoundingClientRect()
    onSelectionRef.current({
      quote,
      sourceLineNumber: selection.startLineNumber,
      anchor: { blockKey: REVIEW_FILE_MONACO_BLOCK_KEY, start, end },
      top: startPos.top + startPos.height,
      left: Math.max(0, startPos.left),
      bubbleLeft
    })
  }, [])

  const publishDeletedSelection = useCallback(() => {
    const host = hostRef.current
    if (!host) {
      onSelectionRef.current(null)
      return
    }
    const domSelection = window.getSelection()
    if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) {
      onSelectionRef.current(null)
      return
    }
    const range = domSelection.getRangeAt(0)
    const lineEl = (
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement
    )?.closest<HTMLElement>('.diff-full-deleted-line')
    if (!lineEl || !host.contains(lineEl)) {
      publishEditorSelection()
      return
    }
    if (lineEl.closest(`.${HIGHLIGHT_CLASS}`)) {
      onSelectionRef.current(null)
      return
    }
    const quote = domSelection.toString().trim()
    if (!quote) {
      onSelectionRef.current(null)
      return
    }
    const lineKey = lineEl.dataset.deletedLineKey
    if (!lineKey) {
      onSelectionRef.current(null)
      return
    }
    const lineText = lineEl.textContent ?? ''
    const probe = document.createRange()
    probe.selectNodeContents(lineEl)
    probe.setEnd(range.startContainer, range.startOffset)
    const start = probe.toString().length
    const end = start + quote.length
    const rect = range.getBoundingClientRect()
    const hostRect = host.getBoundingClientRect()
    const sourceLineNumber = Number(lineEl.dataset.sourceLineNumber ?? '1')
    onSelectionRef.current({
      quote,
      sourceLineNumber,
      anchor: {
        blockKey: reviewFileMonacoDelBlockKey(lineKey),
        start,
        end
      },
      top: rect.bottom - hostRect.top,
      left: Math.max(0, rect.left - hostRect.left),
      bubbleLeft: rect.right - hostRect.left
    })
  }, [publishEditorSelection])

  const mountEditor = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) {
        clearDiffUi(editorRef.current)
        editorRef.current?.dispose()
        editorRef.current = null
        setEditorReady(false)
        return
      }
      if (editorRef.current) return
      const editor = monaco.editor.create(node, {
        theme: monacoThemeId(effectiveTheme),
        automaticLayout: true,
        readOnly: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineHeight: LINE_HEIGHT,
        fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
        padding: { top: 8 },
        folding: true,
        wordWrap: 'on',
        wrappingIndent: 'same',
        lineNumbers: 'on',
        renderValidationDecorations: 'off',
        occurrencesHighlight: 'off',
        selectionHighlight: false
      })
      registerEmacsMonacoKeybindings(editor)
      editor.onDidChangeCursorSelection(() => publishEditorSelection())
      editor.onDidScrollChange(() => {
        publishEditorSelection()
        onScrollRef.current()
      })
      editor.onMouseDown((event) => {
        const target = event.target
        if (target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return
        const offset = target.range?.startColumn != null && target.range.startLineNumber != null
          ? editor.getModel()?.getOffsetAt({
              lineNumber: target.range.startLineNumber,
              column: target.range.startColumn
            })
          : null
        if (offset == null) return
        for (const comment of commentAnchorsRef.current) {
          if (isReviewFileMonacoDelAnchor(comment.anchor.blockKey)) continue
          if (comment.anchor.blockKey !== REVIEW_FILE_MONACO_BLOCK_KEY) continue
          if (offset >= comment.anchor.start && offset < comment.anchor.end) {
            event.event.preventDefault()
            event.event.stopPropagation()
            onCommentAnchorClickRef.current(comment.id)
            return
          }
        }
      })
      editorRef.current = editor
      setEditorReady(true)
    },
    [clearDiffUi, effectiveTheme, publishEditorSelection]
  )

  useEffect(() => {
    monaco.editor.setTheme(monacoThemeId(effectiveTheme))
  }, [effectiveTheme])

  useEffect(() => {
    const host = hostRef.current
    const editor = editorRef.current
    if (!host || !editor || !editorReady) return
    const observer = new ResizeObserver(() => {
      editor.layout()
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [editorReady])

  useEffect(() => {
    const editor = editorRef.current
    const host = hostRef.current
    if (!editor || !host || !editorReady) return
    const lang = detectLanguageFromPath(filePath)
    const uri = modelUri(scopeKey, filePath)
    let model = monaco.editor.getModel(uri)
    if (model) {
      model.setValue(content)
      monaco.editor.setModelLanguage(model, lang)
    } else {
      model = monaco.editor.createModel(content, lang, uri)
    }
    const prev = modelRef.current
    if (prev && prev !== model && prev.uri.toString() !== model.uri.toString()) prev.dispose()
    modelRef.current = model

    clearDiffUi(editor)
    editor.setModel(model)
    const diffUi = applyPlanReviewDiffDecorations(
      editor,
      host,
      content,
      previousContent,
      deletedLineRefs
    )
    diffDecorationRef.current = diffUi.decorations
    viewZoneIdsRef.current = diffUi.zoneIds
    commentDecorationRef.current = applyModelCommentDecorations(editor, commentAnchorsRef.current)
    applyDeletedCommentHighlights(host, deletedLineRefs.current, commentAnchorsRef.current)
    requestAnimationFrame(() => {
      editor.layout()
      publishEditorSelection()
    })
  }, [clearDiffUi, content, editorReady, filePath, previousContent, publishEditorSelection, scopeKey])

  useEffect(() => {
    const editor = editorRef.current
    const host = hostRef.current
    if (!editor || !host) return
    commentDecorationRef.current?.clear()
    commentDecorationRef.current = applyModelCommentDecorations(editor, commentAnchors)
    applyDeletedCommentHighlights(host, deletedLineRefs.current, commentAnchors)
  }, [commentAnchors])

  useEffect(() => {
    return () => {
      clearDiffUi(editorRef.current)
      editorRef.current?.dispose()
      editorRef.current = null
      modelRef.current?.dispose()
      modelRef.current = null
    }
  }, [clearDiffUi])

  return (
    <div
      ref={hostRef}
      className="response-review-file-monaco-host"
      data-testid="response-review-file-monaco-host"
      onMouseUp={publishDeletedSelection}
      onClick={(event) => {
        const highlight = (event.target as HTMLElement).closest<HTMLElement>('[data-comment-id]')
        if (!highlight?.dataset.commentId) return
        event.preventDefault()
        onCommentAnchorClickRef.current(highlight.dataset.commentId)
      }}
    >
      <div ref={mountEditor} data-testid="response-review-file-monaco" />
    </div>
  )
})

export default ReviewFileMonacoEditor
