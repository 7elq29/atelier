import { useEffect, useRef } from 'react'
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle
} from '@atomic-editor/editor'
import '@atomic-editor/editor/styles.css'
import { EditorView } from '@codemirror/view'

/**
 * Notes-style inline Markdown presentation beneath the composer's textarea.
 * The textarea remains the editing/source-of-truth layer so all established
 * keyboard, paste, mention, slash-command, and accessibility behavior stays
 * intact. Its selection is mirrored into Atomic Editor, which reveals source
 * syntax on the active line and renders inactive lines like Notes.
 */
export default function ComposerMarkdownInput({
  value,
  selectionStart,
  selectionEnd,
  scrollTop
}: {
  value: string
  selectionStart: number
  selectionEnd: number
  scrollTop: number
}): JSX.Element {
  const editorRef = useRef<AtomicCodeMirrorEditorHandle | null>(null)

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
}
