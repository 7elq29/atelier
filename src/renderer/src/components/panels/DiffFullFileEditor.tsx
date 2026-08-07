import { useCallback, useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import type { DiffFileChange, DiffHunk } from '../../../../shared/panel-types'
import { ensureAtelierMonacoThemes, monacoThemeId } from '../../editor/atelier-monaco-theme'
import { registerEmacsMonacoKeybindings } from '../../editor/emacs-monaco-keybindings'
import { detectLanguageFromPath } from '../../editor/monaco-language'

ensureAtelierMonacoThemes()

const LINE_HEIGHT = 21

function modelUri(scope: string, filePath: string): monaco.Uri {
  return monaco.Uri.parse(`atelier-diff://${scope}/${encodeURIComponent(filePath)}/modified`)
}

/** Single-gutter full file (Files-style) with add/del highlighting from loaded hunks. */
function applyHunkDecorations(
  editor: monaco.editor.IStandaloneCodeEditor,
  hunks: DiffHunk[]
): { decorations: monaco.editor.IEditorDecorationsCollection; zoneIds: string[] } {
  const decorations: monaco.editor.IModelDeltaDecoration[] = []
  const zoneSpecs: { afterLineNumber: number; lines: string[] }[] = []

  for (const hunk of hunks) {
    let pendingDel: string[] = []

    const flushDelsBefore = (beforeNewLine: number): void => {
      if (pendingDel.length === 0) return
      zoneSpecs.push({
        afterLineNumber: Math.max(0, beforeNewLine - 1),
        lines: [...pendingDel]
      })
      pendingDel = []
    }

    for (const line of hunk.lines) {
      if (line.kind === 'del') {
        pendingDel.push(line.content)
        continue
      }
      const newLn = line.newLine
      if (newLn != null) {
        flushDelsBefore(newLn)
      }
      if (line.kind === 'add' && newLn != null) {
        decorations.push({
          range: new monaco.Range(newLn, 1, newLn, 1),
          options: {
            isWholeLine: true,
            className: 'diff-full-line-add'
          }
        })
      }
    }
    if (pendingDel.length > 0) {
      const model = editor.getModel()
      const after = model ? model.getLineCount() : 0
      zoneSpecs.push({ afterLineNumber: after, lines: pendingDel })
    }
  }

  const collection = editor.createDecorationsCollection(decorations)
  const zoneIds: string[] = []
  editor.changeViewZones((accessor) => {
    for (const spec of zoneSpecs) {
      const domNode = document.createElement('div')
      domNode.className = 'diff-full-deleted-zone'
      for (const text of spec.lines) {
        const row = document.createElement('div')
        row.className = 'diff-full-deleted-line'
        row.textContent = text
        domNode.appendChild(row)
      }
      const id = accessor.addZone({
        afterLineNumber: spec.afterLineNumber,
        heightInPx: spec.lines.length * LINE_HEIGHT,
        domNode
      })
      zoneIds.push(id)
    }
  })

  return { decorations: collection, zoneIds }
}

export default function DiffFullFileEditor({
  workspacePath,
  file,
  hostname,
  effectiveTheme,
  active,
  commitHash,
  scopeKey
}: {
  workspacePath: string
  file: DiffFileChange
  hostname?: string | null
  effectiveTheme: 'light' | 'dark'
  active: boolean
  commitHash?: string | null
  scopeKey: string
}): JSX.Element {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const decorationRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const viewZoneIdsRef = useRef<string[]>([])
  const [editorReady, setEditorReady] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const clearDiffUi = useCallback((editor: monaco.editor.IStandaloneCodeEditor | null) => {
    decorationRef.current?.clear()
    decorationRef.current = null
    if (editor && viewZoneIdsRef.current.length > 0) {
      const ids = viewZoneIdsRef.current
      viewZoneIdsRef.current = []
      editor.changeViewZones((accessor) => {
        for (const id of ids) accessor.removeZone(id)
      })
    }
  }, [])

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
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        fontSize: 13,
        lineHeight: LINE_HEIGHT,
        fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
        padding: { top: 10 },
        folding: true,
        wordWrap: 'off',
        lineNumbers: 'on',
        renderValidationDecorations: 'off',
        occurrencesHighlight: 'off',
        selectionHighlight: false
      })
      registerEmacsMonacoKeybindings(editor)
      editorRef.current = editor
      setEditorReady(true)
    },
    [clearDiffUi, effectiveTheme]
  )

  useEffect(() => {
    monaco.editor.setTheme(monacoThemeId(effectiveTheme))
  }, [effectiveTheme])

  useEffect(() => {
    if (!active || !editorReady) return
    let cancelled = false
    setLoading(true)
    setError(null)

    void (async () => {
      const pair = commitHash
        ? await window.atelier.gitCommitFilePair(workspacePath, commitHash, file.path, file.status, hostname)
        : await window.atelier.gitWorkingTreeFilePair(workspacePath, file.path, file.status, hostname)

      if (cancelled) return
      const editor = editorRef.current
      if (!pair || !editor) {
        if (!pair) {
          setError('Binary or non-text file — full-file diff unavailable')
          setLoading(false)
        }
        return
      }

      const lang = detectLanguageFromPath(file.path)
      const uri = modelUri(scopeKey, file.path)
      const text = file.status === 'deleted' ? pair.original : pair.modified

      let model = monaco.editor.getModel(uri)
      if (model) model.setValue(text)
      else model = monaco.editor.createModel(text, lang, uri)

      const prev = modelRef.current
      if (prev && prev !== model && prev.uri.toString() !== model.uri.toString()) prev.dispose()
      modelRef.current = model

      clearDiffUi(editor)
      editor.setModel(model)
      const applied = applyHunkDecorations(editor, file.hunks)
      decorationRef.current = applied.decorations
      viewZoneIdsRef.current = applied.zoneIds

      editor.layout()
      setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [
    active,
    workspacePath,
    file.path,
    file.status,
    file.hunks,
    hostname,
    commitHash,
    scopeKey,
    clearDiffUi,
    editorReady
  ])

  useEffect(() => {
    if (!active) return
    editorRef.current?.layout()
  }, [active])

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
    <div className="diff-full-file-editor" data-testid="diff-full-file-editor">
      {loading && !error && (
        <div style={{ padding: 12, color: 'var(--text-tertiary)', fontSize: 13.5 }}>Loading full file…</div>
      )}
      {error && (
        <div style={{ padding: 12, color: 'var(--text-tertiary)', fontSize: 13.5 }} data-testid="diff-full-file-error">
          {error}
        </div>
      )}
      <div
        ref={mountEditor}
        data-hint-exclude-root=""
        data-testid={!loading && !error ? 'diff-full-file-ready' : 'diff-full-file-monaco'}
        style={{ flex: 1, minHeight: 120, display: error ? 'none' : 'block' }}
      />
    </div>
  )
}
