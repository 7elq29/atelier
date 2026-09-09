import type { MutableRefObject } from 'react'
import type { AtomicCodeMirrorEditorHandle } from '@atomic-editor/editor'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export type NoteCursorPositions = Map<string, number>

export function rememberNoteCursor(
  noteKey: string,
  positions: NoteCursorPositions
): Extension {
  return EditorView.updateListener.of((update) => {
    if (!update.selectionSet) return
    positions.set(noteKey, update.state.selection.main.head)
  })
}

/**
 * Atomic Editor mounts its CodeMirror view below an imperative wrapper.
 * Retry for a few animation frames so a just-switched note can mount, then
 * restore the launch-local caret (or position zero on first open) and focus.
 */
export function focusNoteAtRememberedCursor(
  editorHandleRef: MutableRefObject<AtomicCodeMirrorEditorHandle | null>,
  noteKey: string,
  positions: NoteCursorPositions
): () => void {
  let cancelled = false
  let frame = 0
  let attempts = 0

  const focus = (): void => {
    if (cancelled) return
    const handle = editorHandleRef.current
    const contentDOM = handle?.getContentDOM()
    const view = contentDOM ? EditorView.findFromDOM(contentDOM) : null
    if (!handle || !view) {
      if (++attempts < 6) frame = requestAnimationFrame(focus)
      return
    }

    const position = Math.min(positions.get(noteKey) ?? 0, view.state.doc.length)
    view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
    handle.focus()
    positions.set(noteKey, position)
  }

  frame = requestAnimationFrame(focus)
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
  }
}
