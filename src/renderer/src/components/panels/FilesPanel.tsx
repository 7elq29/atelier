import { useEffect, useRef, useState, useCallback } from 'react'
import * as monaco from 'monaco-editor'
import type { FileReadResult, FileTreeNode } from '../../../../shared/panel-types'

// ── Monaco theme matching the Soft Paper / Gardenia dark palette ─────────────
monaco.editor.defineTheme('gardenia-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '9096c9' },
    { token: 'keyword.control', foreground: '9096c9' },
    { token: 'storage.type', foreground: '9096c9' },
    { token: 'storage.modifier', foreground: '9096c9' },
    { token: 'entity.name.type', foreground: '7fc0c4' },
    { token: 'entity.name.class', foreground: 'ece7d9' },
    { token: 'entity.name.function', foreground: '8fc17f' },
    { token: 'support.function', foreground: '8fc17f' },
    { token: 'string', foreground: 'd9b374' },
    { token: 'string.quoted', foreground: 'd9b374' },
    { token: 'constant.numeric', foreground: 'd9b374' },
    { token: 'constant.language', foreground: '9096c9' },
    { token: 'comment', foreground: '5c5647', fontStyle: 'italic' },
    { token: 'punctuation', foreground: '837c6b' },
    { token: 'variable.parameter', foreground: 'c9a87c' },
    { token: 'variable', foreground: 'd9c7a8' },
  ],
  colors: {
    'editor.background': '#17150f',
    'editor.foreground': '#b3ac9a',
    'editor.lineHighlightBackground': '#1f1d17',
    'editor.selectionBackground': '#3d382c',
    'editor.inactiveSelectionBackground': '#2a2721',
    'editorLineNumber.foreground': '#5c5647',
    'editorLineNumber.activeForeground': '#ece7d9',
    'editorCursor.foreground': '#ece7d9',
    'editorWhitespace.foreground': '#302c25',
    'editorIndentGuide.background1': '#2a2721',
    'editorIndentGuide.activeBackground1': '#3d382c',
    'editor.findMatchBackground': '#3d3010',
    'editor.findMatchHighlightBackground': '#2a2210',
    'editorWidget.background': '#2a2721',
    'editorWidget.border': '#3d382c',
    'input.background': '#302c25',
    'input.border': '#3d382c',
    'input.foreground': '#ece7d9',
    'scrollbarSlider.background': '#302c2580',
    'scrollbarSlider.hoverBackground': '#3d382c80',
    'scrollbarSlider.activeBackground': '#3d382ca0',
    'editorGutter.background': '#17150f',
    'minimap.background': '#120f0a',
  }
})

// ── Language detection ────────────────────────────────────────────────────────
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', cpp: 'cpp', cc: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', swift: 'swift', kt: 'kotlin',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', env: 'ini',
  md: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', graphql: 'graphql', xml: 'xml',
  dockerfile: 'dockerfile', tf: 'hcl',
}

function detectLanguage(ext: string): string {
  return EXT_TO_LANG[ext.toLowerCase()] ?? 'plaintext'
}

// ── FileTree component ────────────────────────────────────────────────────────
function FileTree({
  nodes,
  depth,
  selected,
  dirtyPath,
  onSelect
}: {
  nodes: FileTreeNode[]
  depth: number
  selected: string | null
  dirtyPath: string | null
  onSelect: (node: FileTreeNode) => void
}): JSX.Element {
  return (
    <>
      {nodes.map((n) => (
        <div key={n.path}>
          <div
            className={`ft-item${n.type === 'dir' ? ' dir' : ''}${selected === n.path ? ' active' : ''}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onSelect(n)}
            data-testid={n.type === 'file' ? 'file-tree-file' : 'file-tree-dir'}
            data-path={n.relativePath}
          >
            {n.type === 'dir' ? '📁' : '📄'} {n.name}
            {n.type === 'file' && dirtyPath === n.path && (
              <span style={{ marginLeft: 5, width: 6, height: 6, borderRadius: '50%', background: 'var(--text-tertiary)', display: 'inline-block', verticalAlign: 'middle' }} />
            )}
          </div>
          {n.type === 'dir' && n.children && (
            <FileTree nodes={n.children} depth={depth + 1} selected={selected} dirtyPath={dirtyPath} onSelect={onSelect} />
          )}
        </div>
      ))}
    </>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

/**
 * Files/Explorer panel (07-secondary-panels §3): real `fs`-backed tree of the
 * session's workspace (worktreePath ?? projectPath), with a Monaco code editor
 * replacing the old regex-highlighter <pre> viewer. Supports read + Ctrl/Cmd+S
 * save for both local and remote (devpod) sessions.
 */
export default function FilesPanel({ projectPath, hostname }: { projectPath: string; hostname: string | null }): JSX.Element {
  const [tree, setTree] = useState<FileTreeNode[] | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileResult, setFileResult] = useState<FileReadResult | null>(null)
  const [isDirty, setIsDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const htmlPreviewRef = useRef<HTMLIFrameElement | null>(null)
  const selectedPathRef = useRef<string | null>(null)
  const saveCurrentFileRef = useRef<(() => Promise<void>) | null>(null)

  // Keep ref in sync so the save keybinding closure can read it
  useEffect(() => { selectedPathRef.current = selectedPath }, [selectedPath])

  // ── Load file tree ─────────────────────────────────────────────────────────
  useEffect(() => {
    setTree(null)
    setSelectedPath(null)
    setFileResult(null)
    setIsDirty(false)
    void window.gardenia.filesTree(projectPath, hostname).then(setTree)
  }, [projectPath, hostname])

  // ── Bootstrap Monaco via callback ref ────────────────────────────────────
  // useEffect([]) fires at initial mount when tree===null (async load), so the
  // container div isn't in the DOM yet and editorRef.current is null. A callback
  // ref fires precisely when the element enters the DOM, regardless of when that is.
  const editorContainerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      editorRef.current?.dispose()
      editorRef.current = null
      return
    }
    if (editorRef.current) return
    const editor = monaco.editor.create(node, {
      theme: 'gardenia-dark',
      automaticLayout: true,
      readOnly: false,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 13,
      lineHeight: 21,
      fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      padding: { top: 10 },
      folding: true,
      wordWrap: 'off',
      renderWhitespace: 'none',
      bracketPairColorization: { enabled: true },
      suggest: { showWords: false },
    })
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveCurrentFileRef.current?.()
    })
  }, [])

  const showEditor = fileResult?.kind === 'text'

  // ── Save handler — kept in a stable ref so the keybinding closure never goes stale
  const saveCurrentFile = useCallback(async () => {
    const path = selectedPathRef.current
    const editor = editorRef.current
    if (!path || !editor) return
    setSaveError(null)
    const result = await window.gardenia.filesWrite(path, editor.getValue(), hostname)
    if (result.ok) {
      setIsDirty(false)
    } else {
      setSaveError(result.error)
    }
  }, [hostname])
  useEffect(() => { saveCurrentFileRef.current = saveCurrentFile }, [saveCurrentFile])

  // ── Mount/update Monaco model when a text file is selected ────────────────
  useEffect(() => {
    const editor = editorRef.current
    if (!editor || fileResult?.kind !== 'text') return

    const lang = detectLanguage(fileResult.extension)
    const uri = monaco.Uri.parse(`file://${selectedPath ?? 'untitled'}`)

    // Reuse existing model for the same URI, create otherwise
    let model = monaco.editor.getModel(uri)
    if (model) {
      // Only reset value if content actually changed (e.g. external reload)
      if (model.getValue() !== fileResult.content) {
        model.setValue(fileResult.content)
      }
      monaco.editor.setModelLanguage(model, lang)
    } else {
      model = monaco.editor.createModel(fileResult.content, lang, uri)
    }

    // Dispose previous model if it was for a different file
    const prev = modelRef.current
    if (prev && prev !== model) prev.dispose()
    modelRef.current = model

    editor.setModel(model)
    editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 })
    editor.layout() // force re-measure after container transitions from display:none
    setIsDirty(false)

    const sub = model.onDidChangeContent(() => setIsDirty(true))
    return () => sub.dispose()
  }, [fileResult, selectedPath])

  // ── HTML preview srcdoc must be set imperatively after mount ───────────────
  useEffect(() => {
    if (fileResult?.kind === 'html' && htmlPreviewRef.current) {
      htmlPreviewRef.current.srcdoc = fileResult.content
    }
  }, [fileResult])

  // ── File selection ─────────────────────────────────────────────────────────
  async function handleSelect(node: FileTreeNode): Promise<void> {
    if (node.type === 'dir') return
    setSelectedPath(node.path)
    setFileResult(null)
    setIsDirty(false)
    setSaveError(null)
    const result = await window.gardenia.filesRead(node.path, hostname)
    setFileResult(result)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div data-testid="files-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {tree === null ? (
        <div className="empty-main" style={{ height: '100%' }}>
          <div className="empty-icon">📁</div>
          <div>Loading files…</div>
        </div>
      ) : tree.length === 0 ? (
        <div className="empty-main" style={{ height: '100%' }}>
          <div className="empty-icon icon-standalone">📁</div>
          <div>Project files will appear here</div>
        </div>
      ) : (
        <div className="files-body">
          <div className="files-tree" data-testid="files-tree">
            <FileTree
              nodes={tree}
              depth={0}
              selected={selectedPath}
              dirtyPath={isDirty ? selectedPath : null}
              onSelect={(n) => void handleSelect(n)}
            />
          </div>

          <div className="file-view" data-testid="file-view" style={{ position: 'relative', padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {/* Monaco editor — always mounted at full size so it always has correct dimensions */}
            <div
              ref={editorContainerRef}
              data-testid="monaco-editor"
              style={{ display: 'flex', flex: 1, minHeight: 0 }}
            />

            {/* Non-text overlays: cover Monaco with an absolute panel when needed */}
            {!fileResult && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-code)', color: 'var(--text-tertiary)' }}>
                Select a file to edit
              </div>
            )}
            {fileResult?.kind === 'image' && (
              <div style={{ position: 'absolute', inset: 0, background: 'var(--bg-code)', display: 'flex', alignItems: 'flex-start', padding: 14, overflow: 'auto' }}>
                <img
                  className="file-preview-image"
                  src={fileResult.content}
                  alt={selectedPath ?? ''}
                  data-testid="file-preview-image"
                  style={{ maxWidth: '100%', objectFit: 'contain' }}
                />
              </div>
            )}
            {fileResult?.kind === 'html' && (
              <iframe
                ref={htmlPreviewRef}
                className="file-preview-html"
                data-testid="file-preview-html"
                title="html preview"
                sandbox=""
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
              />
            )}
            {fileResult?.kind === 'binary' && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-code)', color: 'var(--text-tertiary)' }}>
                Binary file — no preview available
              </div>
            )}

            {/* Save error toast */}
            {saveError && (
              <div
                style={{
                  position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
                  background: 'var(--danger-dim)', border: '1px solid var(--danger)',
                  color: 'var(--danger)', borderRadius: 8, padding: '6px 14px', fontSize: 13,
                  zIndex: 10, whiteSpace: 'nowrap',
                }}
              >
                Save failed: {saveError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
