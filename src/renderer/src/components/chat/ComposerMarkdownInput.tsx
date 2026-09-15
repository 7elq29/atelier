import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle
} from '@atomic-editor/editor'
import '@atomic-editor/editor/styles.css'
import { EditorView } from '@codemirror/view'

export interface ComposerMarkdownInputHandle {
  getCursorCoordinates(position: number): { top: number; left: number; height: number } | null
}

/**
 * Notes-style inline Markdown presentation beneath the composer's textarea.
 * The textarea remains the editing/source-of-truth layer so all established
 * keyboard, paste, mention, slash-command, and accessibility behavior stays
 * intact. Its selection is mirrored into Atomic Editor, which reveals source
 * syntax on the active line and renders inactive lines like Notes.
 */
export default forwardRef<ComposerMarkdownInputHandle, {
  value: string
  selectionStart: number
  selectionEnd: number
  scrollTop: number
}>(function ComposerMarkdownInput({
  value,
  selectionStart,
  selectionEnd,
  scrollTop
}, ref): JSX.Element {
  const editorRef = useRef<AtomicCodeMirrorEditorHandle | null>(null)

  useImperativeHandle(ref, () => ({
    getCursorCoordinates(position: number): { top: number; left: number; height: number } | null {
      const content = editorRef.current?.getContentDOM()
      if (!content) return null
      const view = EditorView.findFromDOM(content)
      if (!view) return null
      const offset = Math.max(0, Math.min(position, view.state.doc.length))
      const coordinates = view.coordsAtPos(offset)
      if (!coordinates) return null
      const lineHeight = coordinates.bottom - coordinates.top
      const computedFontSize = Number.parseFloat(getComputedStyle(content).fontSize)
      const height = Number.isFinite(computedFontSize) ? computedFontSize : lineHeight
      return {
        top: coordinates.top + (lineHeight - height) / 2,
        left: coordinates.left,
        height
      }
    }
  }), [])

  useEffect(() => {
    const content = editorRef.current?.getContentDOM()
    const view = content ? EditorView.findFromDOM(content) : null
    if (!view) return
    const anchor = Math.max(0, Math.min(selectionStart, value.length))
    const head = Math.max(0, Math.min(selectionEnd, value.length))
    const current = view.state.doc.toString()
    view.dispatch({
      changes: current === value ? undefined : { from: 0, to: current.length, insert: value },
      selection: { anchor, head },
      scrollIntoView: true
    })
    view.scrollDOM.scrollTop = scrollTop
  }, [value, selectionStart, selectionEnd, scrollTop])

  return (
    <div className="composer-markdown-input" aria-hidden="true">
      <AtomicCodeMirrorEditor
        documentId="composer-inline-markdown"
        markdownSource={value}
        editorHandleRef={editorRef}
        blurEditorOnMount
      />
    </div>
  )
})
