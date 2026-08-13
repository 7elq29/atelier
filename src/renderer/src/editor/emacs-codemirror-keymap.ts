import {
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorGroupBackward,
  cursorGroupForward,
  cursorLineDown,
  cursorLineEnd,
  cursorLineStart,
  cursorLineUp,
  cursorPageDown,
  cursorPageUp,
  deleteGroupBackward,
  deleteToLineEnd,
  deleteToLineStart
} from '@codemirror/commands'
import { Prec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

function isCtrlOnly(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey
}

function isMetaKey(e: KeyboardEvent): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey
}

/**
 * Linux/Emacs navigation for CodeMirror markdown editors.
 * Uses domEventHandlers + event.code (not CM keymap names) so Option/Meta
 * chords work on macOS — CodeMirror's keymap facet deliberately ignores
 * bare Alt bindings on Mac because Option types alternate characters.
 */
export const emacsCodemirrorKeymapExtension = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      if (isMetaKey(event)) {
        if (event.code === 'KeyF') {
          event.preventDefault()
          return cursorGroupForward(view)
        }
        if (event.code === 'KeyB') {
          event.preventDefault()
          return cursorGroupBackward(view)
        }
        if (event.code === 'KeyV') {
          event.preventDefault()
          return cursorPageUp(view)
        }
        if (event.shiftKey && event.code === 'Comma') {
          event.preventDefault()
          return cursorDocStart(view)
        }
        if (event.shiftKey && event.code === 'Period') {
          event.preventDefault()
          return cursorDocEnd(view)
        }
      }

      if (isCtrlOnly(event)) {
        if (event.code === 'KeyV') {
          event.preventDefault()
          return cursorPageDown(view)
        }
        if (event.code === 'KeyA') {
          event.preventDefault()
          return cursorLineStart(view)
        }
        if (event.code === 'KeyE') {
          event.preventDefault()
          return cursorLineEnd(view)
        }
        if (event.code === 'KeyF') {
          event.preventDefault()
          return cursorCharRight(view)
        }
        if (event.code === 'KeyB') {
          event.preventDefault()
          return cursorCharLeft(view)
        }
        if (event.code === 'KeyN') {
          event.preventDefault()
          return cursorLineDown(view)
        }
        if (event.code === 'KeyP') {
          event.preventDefault()
          return cursorLineUp(view)
        }
        if (event.code === 'KeyU') {
          event.preventDefault()
          return deleteToLineStart(view)
        }
        if (event.code === 'KeyW') {
          event.preventDefault()
          return deleteGroupBackward(view)
        }
        if (event.code === 'KeyK') {
          event.preventDefault()
          return deleteToLineEnd(view)
        }
      }

      return false
    }
  })
)
