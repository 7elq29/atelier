import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as monaco from 'monaco-editor'
import type { FileReadResult, FileTreeNode } from '../../../../shared/panel-types'
import { registerEmacsMonacoKeybindings } from '../../editor/emacs-monaco-keybindings'
import { ensureAtelierMonacoThemes, monacoThemeId } from '../../editor/atelier-monaco-theme'
import { detectLanguage } from '../../editor/monaco-language'

ensureAtelierMonacoThemes()

// ── Path helpers ────────────────────────────────────────────────────────────────
function dirnamePath(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function basenamePath(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

type OpenEditorTab = {
  id: string
  path: string | null
  fileResult: FileReadResult | null
  isDirty: boolean
}

function modelUriForPath(path: string): monaco.Uri {
  return monaco.Uri.parse(`file://${path}`)
}

function disposeModelForPathIfUnused(tabs: OpenEditorTab[], path: string): void {
  if (tabs.some((t) => t.path === path)) return
  monaco.editor.getModel(modelUriForPath(path))?.dispose()
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
  dirtyPaths,
  expanded,
  loadingDirs,
  dirChildren,
  onSelect,
  onToggleDir,
}: {
  nodes: FileTreeNode[]
  depth: number
  selected: string | null
  dirtyPaths: Set<string>
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
              {n.type === 'file' && dirtyPaths.has(n.path) && (
                <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%', background: 'var(--text-tertiary)', display: 'inline-block', flexShrink: 0 }} />
              )}
            </div>
            {n.type === 'dir' && isExpanded && children && children.length > 0 && (
              <FileTree
                nodes={children}
                depth={depth + 1}
                selected={selected}
                dirtyPaths={dirtyPaths}
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
export default function FilesPanel({
  projectPath,
  hostname,
  effectiveTheme,
  active = true,
  revealFilePath,
  revealFileSeq = 0,
  onRevealFileHandled,
  onAddComment,
  initialFilesTree
}: {
  projectPath: string
  hostname: string | null
  /** Matches `data-theme` on `<html>` — drives Monaco editor colors. */
  effectiveTheme: 'light' | 'dark'
  /** When false, panel stays mounted (session buffered); Monaco layout refreshes on re-show. */
  active?: boolean
  /** Absolute path to select in the editor when `revealFileSeq` bumps (plan card → Files). */
  revealFilePath?: string
  revealFileSeq?: number
  onRevealFileHandled?: () => void
  /** Push an inline file-line comment into the session composer (same as Diff panel). */
  onAddComment?: (note: string) => void
  /** Preloaded one-level tree from session workspace (main process). */
  initialFilesTree?: FileTreeNode[] | null
}): JSX.Element {
  const [tree, setTree] = useState<FileTreeNode[] | null>(null)
  const [openTabs, setOpenTabs] = useState<OpenEditorTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const nextTabIdRef = useRef(0)
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
  const locationInputRef = useRef<HTMLInputElement | null>(null)
  const openTabsRef = useRef(openTabs)
  const activeTabIdRef = useRef<string | null>(null)

  function newEditorTabId(): string {
    nextTabIdRef.current += 1
    return `file-tab-${nextTabIdRef.current}`
  }

  const activeTab = openTabs.find((t) => t.id === activeTabId) ?? null
  const fileResult = activeTab?.fileResult ?? null
  const selectedPath = activeTab?.path ?? null
  const isDirty = activeTab?.isDirty ?? false
  const dirtyPaths = useMemo(
    () => new Set(openTabs.filter((t) => t.isDirty && t.path).map((t) => t.path as string)),
    [openTabs]
  )

  openTabsRef.current = openTabs
  activeTabIdRef.current = activeTabId

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monaco.editor.ITextModel | null>(null)
  const htmlPreviewRef = useRef<HTMLIFrameElement | null>(null)
  const selectedPathRef = useRef<string | null>(null)
  const saveCurrentFileRef = useRef<(() => Promise<void>) | null>(null)
  const lastRevealSeqRef = useRef(0)
  const handleLocationCommitRef = useRef<(path: string) => Promise<void>>(async () => {})
  const fileViewRef = useRef<HTMLDivElement | null>(null)

  const [gutterHoverLine, setGutterHoverLine] = useState<number | null>(null)
  const [commentingLine, setCommentingLine] = useState<number | null>(null)
  const [commentText, setCommentText] = useState('')
  /** Bumped on Monaco scroll/layout so gutter overlays track visible lines. */
  const [overlayTick, setOverlayTick] = useState(0)

  // Keep ref in sync so the save keybinding closure can read it
  useEffect(() => { selectedPathRef.current = selectedPath }, [selectedPath])
  useEffect(() => { dirChildrenRef.current = dirChildren }, [dirChildren])
  // Sync location bar when file selection changes (tree click)
  useEffect(() => { if (!locationEditing) setLocationInput(selectedPath ?? projectPath) }, [selectedPath, projectPath, locationEditing])

  // ── Load file tree ─────────────────────────────────────────────────────────
  useEffect(() => {
    setTree(null)
    setOpenTabs([])
    setActiveTabId(null)
    nextTabIdRef.current = 0
    setExpanded(new Set())
    setLoadingDirs(new Set())
    setDirChildren(new Map())
    dirChildrenRef.current = new Map()
    setLocationInput(projectPath)
    lastRevealSeqRef.current = 0
    if (initialFilesTree != null) {
      setTree(initialFilesTree)
    } else {
      void window.atelier.filesTree(projectPath, hostname).then(setTree)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- workspace tree syncs via dedicated effect below
  }, [projectPath, hostname])

  useEffect(() => {
    if (initialFilesTree == null) return
    setTree(initialFilesTree)
  }, [initialFilesTree])

  useEffect(() => {
    if (!active) return
    editorRef.current?.layout()
  }, [active])

  useEffect(() => {
    monaco.editor.setTheme(monacoThemeId(effectiveTheme))
  }, [effectiveTheme])

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
      theme: monacoThemeId(effectiveTheme),
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
    registerEmacsMonacoKeybindings(editor)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveCurrentFileRef.current?.()
    })
  }, [])

  const showEditor = fileResult?.kind === 'text'

  const lineHeight = 21

  function fileLabelForComment(filePath: string | null): string {
    if (!filePath) return 'file'
    const root = projectPath.replace(/\/$/, '')
    if (filePath.startsWith(root)) {
      const rel = filePath.slice(root.length).replace(/^\//, '')
      return rel || (filePath.split('/').pop() ?? filePath)
    }
    return filePath
  }

  function lineOverlayTop(lineNumber: number): number | null {
    void overlayTick
    const editor = editorRef.current
    if (!editor) return null
    const pos = editor.getScrolledVisiblePosition({ lineNumber, column: 1 })
    return pos?.top ?? null
  }

  function submitFileComment(lineNumber: number): void {
    if (!commentText.trim() || !onAddComment) return
    const model = editorRef.current?.getModel()
    const lineText = model?.getLineContent(lineNumber) ?? ''
    const file = fileLabelForComment(selectedPath)
    onAddComment(`Re ${file} (line ${lineNumber}):\n> ${lineText.trim()}\n\n${commentText.trim()}`)
    setCommentText('')
    setCommentingLine(null)
    setGutterHoverLine(null)
  }

  useEffect(() => {
    setCommentingLine(null)
    setCommentText('')
    setGutterHoverLine(null)
  }, [selectedPath])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || !showEditor || !active || !onAddComment) {
      setGutterHoverLine(null)
      return
    }

    const gutterTypes = new Set<number>([
      monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS,
      monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN
    ])

    const moveSub = editor.onMouseMove((e) => {
      const line = e.target.position?.lineNumber
      if (line && gutterTypes.has(e.target.type)) {
        setGutterHoverLine(line)
      } else {
        setGutterHoverLine(null)
      }
    })

    const scrollSub = editor.onDidScrollChange(() => setOverlayTick((t) => t + 1))
    const layoutSub = editor.onDidLayoutChange(() => setOverlayTick((t) => t + 1))

    return () => {
      moveSub.dispose()
      scrollSub.dispose()
      layoutSub.dispose()
    }
  }, [showEditor, active, onAddComment, selectedPath, fileResult])

  // ── Save handler — kept in a stable ref so the keybinding closure never goes stale
  const saveCurrentFile = useCallback(async () => {
    const path = selectedPathRef.current
    const editor = editorRef.current
    if (!path || !editor) return
    setSaveError(null)
    const result = await window.atelier.filesWrite(path, editor.getValue(), hostname)
    if (result.ok) {
      setOpenTabs((prev) => prev.map((t) => (t.path === path ? { ...t, isDirty: false } : t)))
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
    const uri = modelUriForPath(selectedPath ?? 'untitled')

    // Reuse existing model for the same URI, create otherwise
    let model = monaco.editor.getModel(uri)
    const modelExisted = Boolean(model)
    if (model) {
      // Only reset value if content actually changed (e.g. external reload)
      if (model.getValue() !== fileResult.content) {
        model.setValue(fileResult.content)
      }
      monaco.editor.setModelLanguage(model, lang)
    } else {
      model = monaco.editor.createModel(fileResult.content, lang, uri)
    }

    const prev = modelRef.current
    if (prev && prev !== model) {
      const stillUsed = openTabsRef.current.some(
        (t) => t.path != null && modelUriForPath(t.path).toString() === prev.uri.toString()
      )
      if (!stillUsed) prev.dispose()
    }
    modelRef.current = model

    editor.setModel(model)
    if (!modelExisted) {
      editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 })
    }
    editor.layout() // force re-measure after container transitions from display:none

    const sub = model.onDidChangeContent(() => {
      const path = selectedPathRef.current
      if (!path) return
      setOpenTabs((prev) => prev.map((t) => (t.path === path ? { ...t, isDirty: true } : t)))
    })
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

  // ── Open / switch / close editor tabs ─────────────────────────────────────
  async function openInCurrentTab(path: string, cachedResult?: FileReadResult): Promise<void> {
    const activeId = activeTabIdRef.current
    const active = openTabsRef.current.find((t) => t.id === activeId)
    if (active?.path === path) {
      setLocationInput(path)
      setSaveError(null)
      await revealInTree(path)
      return
    }

    const result = cachedResult ?? await window.atelier.filesRead(path, hostname)

    if (!active) {
      const id = newEditorTabId()
      setOpenTabs([{ id, path, fileResult: result, isDirty: false }])
      setActiveTabId(id)
    } else {
      const oldPath = active.path
      setOpenTabs((prev) => {
        const next = prev.map((t) =>
          t.id === active.id ? { ...t, path, fileResult: result, isDirty: false } : t
        )
        if (oldPath) disposeModelForPathIfUnused(next, oldPath)
        return next
      })
      setActiveTabId(active.id)
    }

    setLocationInput(path)
    setSaveError(null)
    await revealInTree(path)
  }

  function duplicateCurrentTab(): void {
    const id = newEditorTabId()
    let locationPath: string | null = null

    setOpenTabs((prev) => {
      if (prev.length === 0) {
        locationPath = null
        return [{ id, path: null, fileResult: null, isDirty: false }]
      }
      const sourceId = activeTabId ?? prev[prev.length - 1].id
      const source = prev.find((t) => t.id === sourceId) ?? prev[prev.length - 1]
      locationPath = source.path
      const idx = prev.findIndex((t) => t.id === source.id)
      const next = [...prev]
      next.splice(idx + 1, 0, {
        id,
        path: source.path,
        fileResult: source.fileResult,
        isDirty: source.isDirty,
      })
      return next
    })
    setActiveTabId(id)
    setLocationInput(locationPath ?? projectPath)
  }

  function activateEditorTab(tabId: string): void {
    const tab = openTabsRef.current.find((t) => t.id === tabId)
    if (!tab) return
    setActiveTabId(tabId)
    setLocationInput(tab.path ?? projectPath)
    setSaveError(null)
  }

  function closeEditorTab(tabId: string, e: React.MouseEvent): void {
    e.stopPropagation()
    setOpenTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId)
      if (idx < 0) return prev
      const closed = prev[idx]
      const next = prev.filter((t) => t.id !== tabId)
      if (closed.path) {
        disposeModelForPathIfUnused(next, closed.path)
        if (modelRef.current && modelUriForPath(closed.path).toString() === modelRef.current.uri.toString()) {
          if (!next.some((t) => t.path === closed.path)) {
            modelRef.current = null
          }
        }
      }
      if (activeTabIdRef.current === tabId) {
        const newActive = idx > 0 ? next[idx - 1]?.id : next[0]?.id ?? null
        setActiveTabId(newActive)
        const newTab = newActive ? next.find((t) => t.id === newActive) : null
        setLocationInput(newTab?.path ?? projectPath)
      }
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
      const result = await window.atelier.filesRead(path, hostname)
      await openInCurrentTab(path, result)
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
  useEffect(() => {
    handleLocationCommitRef.current = handleLocationCommit
  })

  useEffect(() => {
    if (!active || !revealFilePath || !revealFileSeq || revealFileSeq === lastRevealSeqRef.current) return
    lastRevealSeqRef.current = revealFileSeq
    void handleLocationCommitRef.current(revealFilePath).finally(() => onRevealFileHandled?.())
  }, [active, revealFilePath, revealFileSeq, onRevealFileHandled])

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
    await openInCurrentTab(node.path)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div data-testid={active ? 'files-panel-active' : undefined} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
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
            ref={locationInputRef}
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
        {(openTabs.length > 0 || tree.length > 0) && (
          <div className="files-editor-tabs" data-testid="files-editor-tabs">
            {openTabs.map((tab) => {
              const rel = tab.path
                ? tab.path.startsWith(projectPath)
                  ? tab.path.slice(projectPath.length).replace(/^\//, '') || basenamePath(tab.path)
                  : basenamePath(tab.path)
                : 'untitled'
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`files-editor-tab${tab.id === activeTabId ? ' active' : ''}${tab.isDirty ? ' dirty' : ''}`}
                  data-testid="files-editor-tab"
                  data-tab-id={tab.id}
                  data-path={rel}
                  onClick={() => activateEditorTab(tab.id)}
                >
                  <span className="fname">{tab.path ? basenamePath(tab.path) : 'Untitled'}</span>
                  {tab.isDirty && <span className="files-tab-dirty" aria-hidden />}
                  <span
                    className="files-tab-close"
                    data-testid="files-editor-tab-close"
                    role="presentation"
                    onClick={(e) => closeEditorTab(tab.id, e)}
                  >
                    ×
                  </span>
                </button>
              )
            })}
            <button
              type="button"
              className="files-editor-tab-add"
              data-testid="files-editor-tab-add"
              title="Duplicate current tab"
              onClick={duplicateCurrentTab}
            >
              +
            </button>
          </div>
        )}
        <div className="files-body">
          <div className="files-tree" data-testid="files-tree">
            <FileTree
              nodes={tree}
              depth={0}
              selected={selectedPath}
              dirtyPaths={dirtyPaths}
              expanded={expanded}
              loadingDirs={loadingDirs}
              dirChildren={dirChildren}
              onSelect={(n) => void handleSelect(n)}
              onToggleDir={(n) => void handleToggleDir(n)}
            />
          </div>

          <div
            className="file-view"
            ref={fileViewRef}
            data-testid="file-view"
            style={{ position: 'relative', padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
            onMouseLeave={(e) => {
              const next = e.relatedTarget
              if (next instanceof Node && fileViewRef.current?.contains(next)) return
              setGutterHoverLine(null)
            }}
          >
            {/* Monaco editor — always mounted at full size so it always has correct dimensions */}
            <div
              ref={editorContainerRef}
              data-hint-exclude-root=""
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

            {showEditor && onAddComment && (
              <div className="files-editor-overlays" aria-hidden={commentingLine === null && gutterHoverLine === null}>
                {gutterHoverLine !== null && commentingLine === null && (() => {
                  const top = lineOverlayTop(gutterHoverLine)
                  if (top === null) return null
                  return (
                    <button
                      type="button"
                      className="files-line-comment-btn"
                      data-testid="files-line-comment-btn"
                      title="Add inline comment"
                      style={{ top }}
                      onMouseEnter={() => setGutterHoverLine(gutterHoverLine)}
                      onClick={() => {
                        setCommentingLine(gutterHoverLine)
                        setCommentText('')
                      }}
                    >
                      💬
                    </button>
                  )
                })()}
                {commentingLine !== null && (() => {
                  const top = lineOverlayTop(commentingLine)
                  if (top === null) return null
                  return (
                    <div
                      className="inline-comment files-inline-comment"
                      data-testid="files-inline-comment"
                      style={{ top: top + lineHeight }}
                    >
                      <textarea
                        rows={2}
                        placeholder="Comment on this line…"
                        value={commentText}
                        onChange={(e) => setCommentText(e.target.value)}
                        data-testid="files-comment-input"
                        autoFocus
                      />
                      <div className="inline-comment-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          data-testid="files-comment-submit"
                          onClick={() => submitFileComment(commentingLine)}
                        >
                          Add to next message
                        </button>
                        <button type="button" className="btn btn-sm" onClick={() => setCommentingLine(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )
                })()}
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
