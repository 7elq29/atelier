import { Prec } from '@codemirror/state'
import { EditorView, scrollPastEnd } from '@codemirror/view'
import { emacsCodemirrorKeymapExtension } from './emacs-codemirror-keymap'

/** Layout for app/daily note Atomic editors — scroll-past-end without a permanent empty scrollbar. */
export const noteEditorLayoutExtensions = [
  emacsCodemirrorKeymapExtension,
  scrollPastEnd(),
  Prec.low(
    EditorView.theme({
      '.cm-content': { paddingBottom: '0' }
    })
  )
]
