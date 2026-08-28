import * as monaco from 'monaco-editor'

const C = monaco.KeyMod.WinCtrl
const M = monaco.KeyMod.Alt

function runAction(editor: monaco.editor.IStandaloneCodeEditor, commandId: string, args?: unknown): void {
  editor.trigger('emacs', commandId, args ?? null)
}

function gotoDocumentStart(editor: monaco.editor.IStandaloneCodeEditor): void {
  editor.setPosition({ lineNumber: 1, column: 1 })
  editor.revealLineInCenterIfOutsideViewport(1)
}

function gotoDocumentEnd(editor: monaco.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel()
  if (!model) return
  const line = model.getLineCount()
  editor.setPosition({ lineNumber: line, column: model.getLineMaxColumn(line) })
  editor.revealLineInCenterIfOutsideViewport(line)
}

/** Kill from cursor to end of line (simplified C-k). */
function killLine(editor: monaco.editor.IStandaloneCodeEditor): void {
  const model = editor.getModel()
  const selections = editor.getSelections()
  if (!model || !selections?.length) return

  editor.pushUndoStop()
  editor.executeEdits(
    'emacs-kill-line',
    selections.map((sel) => {
      const line = sel.startLineNumber
      const col = sel.startColumn
      const maxCol = model.getLineMaxColumn(line)
      if (col >= maxCol && line < model.getLineCount()) {
        return { range: new monaco.Range(line, col, line + 1, 1), text: '', forceMoveMarkers: true }
      }
      return { range: new monaco.Range(line, col, line, maxCol), text: '', forceMoveMarkers: true }
    })
  )
}

const FILE_QUICK_OPEN_CHORD_MS = 1500

/** Emacs-style navigation in a Monaco standalone editor (Control = C, Alt/Option = M). */
export function registerEmacsMonacoKeybindings(
  editor: monaco.editor.IStandaloneCodeEditor,
  opts?: { onFileQuickOpen?: () => void }
): void {
  const bind = (key: number, handler: () => void) => {
    editor.addCommand(key, handler)
  }

  let fileQuickOpenLeaderAt: number | null = null

  bind(M | monaco.KeyCode.KeyF, () => runAction(editor, 'cursorWordEndRight'))
  bind(M | monaco.KeyCode.KeyB, () => runAction(editor, 'cursorWordStartLeft'))
  bind(M | monaco.KeyCode.KeyD, () => runAction(editor, 'deleteWordRight'))
  bind(C | monaco.KeyCode.KeyV, () => runAction(editor, 'scrollPageDown'))
  bind(M | monaco.KeyCode.KeyV, () => runAction(editor, 'scrollPageUp'))

  bind(M | monaco.KeyMod.Shift | monaco.KeyCode.Comma, () => gotoDocumentStart(editor))
  bind(M | monaco.KeyMod.Shift | monaco.KeyCode.Period, () => gotoDocumentEnd(editor))

  bind(C | monaco.KeyCode.KeyA, () => runAction(editor, 'cursorLineStart'))
  bind(C | monaco.KeyCode.KeyE, () => runAction(editor, 'cursorLineEnd'))
  bind(C | monaco.KeyCode.KeyN, () => runAction(editor, 'cursorDown'))
  bind(C | monaco.KeyCode.KeyP, () => runAction(editor, 'cursorUp'))
  bind(C | monaco.KeyCode.KeyX, () => {
    fileQuickOpenLeaderAt = Date.now()
  })
  bind(C | monaco.KeyCode.KeyF, () => {
    if (
      opts?.onFileQuickOpen &&
      fileQuickOpenLeaderAt != null &&
      Date.now() - fileQuickOpenLeaderAt <= FILE_QUICK_OPEN_CHORD_MS
    ) {
      fileQuickOpenLeaderAt = null
      opts.onFileQuickOpen()
      return
    }
    fileQuickOpenLeaderAt = null
    runAction(editor, 'cursorRight')
  })
  bind(C | monaco.KeyCode.KeyB, () => runAction(editor, 'cursorLeft'))
  bind(C | monaco.KeyCode.KeyU, () => runAction(editor, 'deleteAllLeft'))
  bind(C | monaco.KeyCode.KeyW, () => runAction(editor, 'deleteWordLeft'))
  bind(C | monaco.KeyCode.KeyK, () => killLine(editor))
  bind(C | monaco.KeyMod.Shift | monaco.KeyCode.Minus, () => runAction(editor, 'undo'))
}
