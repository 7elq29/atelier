import { useEffect, useRef, useState, useCallback } from 'react'
import * as monaco from 'monaco-editor'
import type { FileReadResult, FileTreeNode } from '../../../../shared/panel-types'

// ── Monaco theme matching the Soft Paper / Atelier dark palette ─────────────
monaco.editor.defineTheme('atelier-dark', {
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

function dirnamePath(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

// ── Icons (paths from the mock's SVG symbol definitions) ─────────────────────
function IconFolder(): JSX.Element {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>
    </svg>
  )
}

function IconFile(): JSX.Element {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2h8l4 4v16H6z"/>
      <path d="M14 2v4h4"/>
    </svg>
  )
}

// ── FileTree component ────────────────────────────────────────────────────────
function FileTree({
  nodes,
  depth,
  selected,
  dirtyPath,
  expanded,
  loadingDirs,
  dirChildren,
  onSelect,
  onToggleDir,
}: {
  nodes: FileTreeNode[]
  depth: number
  selected: string | null
  dirtyPath: string | null
  expanded: Set<string>
  loadingDirs: Set<string>
  dirChildren: Map<string, FileTreeNode[]>
  onSelect: (node: FileTreeNode) => void
  onToggleDir: (node: FileTreeNode) => void
}): JSX.Element {
  return (
    <>
      {nodes.map((n) => {
        const isExpanded = expanded.has(n.path)
        const isLoading = loadingDirs.has(n.path)
        const children = dirChildren.get(n.path)
        return (
          <div key={n.path}>
            <div
              className={`ft-item${n.type === 'dir' ? ' dir' : ''}${selected === n.path ? ' active' : ''}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => n.type === 'dir' ? onToggleDir(n) : onSelect(n)}
              data-testid={n.type === 'file' ? 'file-tree-file' : 'file-tree-dir'}
              data-path={n.relativePath}
            >
              {n.type === 'dir'
                ? isLoading
                  ? <div className="spinner" style={{ width: 13, height: 13, flexShrink: 0 }} />
                  : <IconFolder />
                : <IconFile />
              }
              {n.name}
              {n.type === 'file' && dirtyPath === n.path && (
                <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%', background: 'var(--text-tertiary)', display: 'inline-block', flexShrink: 0 }} />
              )}
            </div>
            {n.type === 'dir' && isExpanded && children && children.length > 0 && (
              <FileTree
                nodes={children}
                depth={depth + 1}
                selected={selected}
                dirtyPath={dirtyPath}
                expanded={expanded}
                loadingDirs={loadingDirs}
                dirChildren={dirChildren}
                onSelect={onSelect}
                onToggleDir={onToggleDir}
              />
            )}
          </div>
        )
      })}
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [dirChildren, setDirChildren] = useState<Map<string, FileTreeNode[]>>(new Map())
  const [locationInput, setLocationInput] = useState('')
  const [locationEditing, setLocationEditing] = useState(false)
  const [completions, setCompletions] = useState<FileTreeNode[]>([])
  const [completionIdx, setCompletionIdx] = useState(0)
  const dirChildrenRef = useRef<Map<string, FileTreeNode[]>>(new Map())
  const completionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const htmlPreviewRef = useRef<HTMLIFrameElement | null>(null)
  const selectedPathRef = useRef<string | null>(null)
  const saveCurrentFileRef = useRef<(() => Promise<void>) | null>(null)

  // Keep ref in sync so the save keybinding closure can read it
  useEffect(() => { selectedPathRef.current = selectedPath }, [selectedPath])
  useEffect(() => { dirChildrenRef.current = dirChildren }, [dirChildren])
  // Sync location bar when file selection changes (tree click)
  useEffect(() => { if (!locationEditing) setLocationInput(selectedPath ?? projectPath) }, [selectedPath, projectPath, locationEditing])

  // ── Load file tree ─────────────────────────────────────────────────────────
  useEffect(() => {
    setTree(null)
    setSelectedPath(null)
    setFileResult(null)
    setIsDirty(false)
    setExpanded(new Set())
    setLoadingDirs(new Set())
    setDirChildren(new Map())
    dirChildrenRef.current = new Map()
    setLocationInput(projectPath)
    void window.atelier.filesTree(projectPath, hostname).then(setTree)
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
      theme: 'atelier-dark',
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
    const result = await window.atelier.filesWrite(path, editor.getValue(), hostname)
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

  // ── Completion fetch (debounced 120ms) ────────────────────────────────────
  function fetchCompletions(input: string): void {
    if (completionTimerRef.current) clearTimeout(completionTimerRef.current)
    completionTimerRef.current = setTimeout(async () => {
      if (!input) { setCompletions([]); return }
      const endsWithSlash = input.endsWith('/')
      const lastSlash = input.lastIndexOf('/')
      const dir = endsWithSlash ? input.slice(0, -1) : (lastSlash >= 0 ? input.slice(0, lastSlash) : projectPath)
      const prefix = endsWithSlash ? '' : (lastSlash >= 0 ? input.slice(lastSlash + 1) : input)
      try {
        const children = await window.atelier.filesDir(projectPath, dir || projectPath, hostname)
        const lower = prefix.toLowerCase()
        const matches = children.filter((n) => n.name.toLowerCase().startsWith(lower))
        setCompletions(matches.slice(0, 12))
        setCompletionIdx(0)
      } catch {
        setCompletions([])
      }
    }, 120)
  }

  function acceptCompletion(node: FileTreeNode): void {
    const newPath = node.type === 'dir' ? node.path + '/' : node.path
    setLocationInput(newPath)
    setCompletions([])
    if (node.type === 'dir') {
      fetchCompletions(newPath)
    } else {
      void handleLocationCommit(node.path)
    }
  }

  // ── Reveal a file path in the tree (expand all ancestor dirs) ────────────
  async function revealInTree(filePath: string): Promise<void> {
    const ancestors: string[] = []
    let cur = dirnamePath(filePath)
    while (cur.startsWith(projectPath) && cur !== projectPath) {
      ancestors.unshift(cur)
      cur = dirnamePath(cur)
    }
    const fetched = new Map<string, FileTreeNode[]>()
    await Promise.all(ancestors.map(async (dir) => {
      if (!dirChildrenRef.current.has(dir)) {
        const children = await window.atelier.filesDir(projectPath, dir, hostname)
        fetched.set(dir, children)
      }
    }))
    if (fetched.size > 0) {
      setDirChildren((prev) => {
        const next = new Map(prev)
        for (const [k, v] of fetched) next.set(k, v)
        return next
      })
    }
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const dir of ancestors) next.add(dir)
      return next
    })
  }

  // ── Location bar commit ────────────────────────────────────────────────────
  async function handleLocationCommit(inputPath: string): Promise<void> {
    const path = inputPath.trim()
    if (!path) return
    setLocationEditing(false)
    setCompletions([])
    try {
      // Try as a file first
      const result = await window.atelier.filesRead(path, hostname)
      setSelectedPath(path)
      setFileResult(result)
      setLocationInput(path)
      setIsDirty(false)
      setSaveError(null)
      await revealInTree(path)
    } catch {
      // Try as a directory — expand it and reveal its ancestors
      try {
        const children = await window.atelier.filesDir(projectPath, path, hostname)
        setDirChildren((prev) => new Map(prev).set(path, children))
        setExpanded((prev) => new Set(prev).add(path))
        setLocationInput(path)
        await revealInTree(path)
      } catch {
        // Invalid path — reset to last known good value
        setLocationInput(selectedPath ?? projectPath)
      }
    }
  }

  // ── Directory expansion ────────────────────────────────────────────────────
  async function handleToggleDir(node: FileTreeNode): Promise<void> {
    if (expanded.has(node.path)) {
      setExpanded((prev) => { const s = new Set(prev); s.delete(node.path); return s })
      return
    }
    setExpanded((prev) => new Set(prev).add(node.path))
    if (!dirChildren.has(node.path)) {
      setLoadingDirs((prev) => new Set(prev).add(node.path))
      const children = await window.atelier.filesDir(projectPath, node.path, hostname)
      setDirChildren((prev) => new Map(prev).set(node.path, children))
      setLoadingDirs((prev) => { const s = new Set(prev); s.delete(node.path); return s })
    }
  }

  // ── File selection ─────────────────────────────────────────────────────────
  async function handleSelect(node: FileTreeNode): Promise<void> {
    if (node.type === 'dir') return
    setSelectedPath(node.path)
    setFileResult(null)
    setIsDirty(false)
    setSaveError(null)
    const result = await window.atelier.filesRead(node.path, hostname)
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
        <>
        <div className={`files-location-bar${locationEditing ? ' editing' : ''}`}>
          <IconFolder />
          <input
            data-testid="files-location-input"
            value={locationInput}
            placeholder={projectPath}
            onFocus={() => setLocationEditing(true)}
            onBlur={() => {
              // Delay so click on a completion item fires first
              setTimeout(() => {
                setLocationEditing(false)
                setCompletions([])
                setLocationInput(selectedPath ?? projectPath)
              }, 150)
            }}
            onChange={(e) => { setLocationInput(e.target.value); fetchCompletions(e.target.value) }}
            onKeyDown={(e) => {
              if (completions.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setCompletionIdx((i) => Math.min(i + 1, completions.length - 1)); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setCompletionIdx((i) => Math.max(i - 1, 0)); return }
                if (e.key === 'Tab' || (e.key === 'Enter' && completions.length > 0 && completionIdx < completions.length)) {
                  e.preventDefault(); acceptCompletion(completions[completionIdx]); return
                }
              }
              if (e.key === 'Enter') { setCompletions([]); void handleLocationCommit(locationInput) }
              if (e.key === 'Escape') { setLocationEditing(false); setCompletions([]); setLocationInput(selectedPath ?? projectPath); (e.target as HTMLInputElement).blur() }
            }}
          />
          {completions.length > 0 && (
            <div className="files-location-popup">
              {completions.map((n, i) => (
                <div
                  key={n.path}
                  className={`mention-item${i === completionIdx ? ' selected' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); acceptCompletion(n) }}
                  onMouseEnter={() => setCompletionIdx(i)}
                >
                  {n.type === 'dir' ? <IconFolder /> : <IconFile />}
                  <span>{n.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="files-body">
          <div className="files-tree" data-testid="files-tree">
            <FileTree
              nodes={tree}
              depth={0}
              selected={selectedPath}
              dirtyPath={isDirty ? selectedPath : null}
              expanded={expanded}
              loadingDirs={loadingDirs}
              dirChildren={dirChildren}
              onSelect={(n) => void handleSelect(n)}
              onToggleDir={(n) => void handleToggleDir(n)}
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
        </>
      )}
    </div>
  )
}
