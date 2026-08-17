import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import * as monaco from 'monaco-editor'
import type { FileReadResult, FileTreeNode, DiffFileChange, DiffFileContentPair } from '../../../../shared/panel-types'
import DiffFullFileEditor from './DiffFullFileEditor'
import { registerEmacsMonacoKeybindings } from '../../editor/emacs-monaco-keybindings'
import { handleEmacsTextareaKeyDown } from '../../palette-input-keys'
import { ensureAtelierMonacoThemes, monacoThemeId } from '../../editor/atelier-monaco-theme'
import { detectLanguage } from '../../editor/monaco-language'
import { expandTildePath, REMOTE_SESSION_HOME } from '../../../../shared/project-path-autocomplete'

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

/** Resolve location-bar / listing paths against the session workspace root. */
function resolveBrowsePath(inputPath: string, workspaceRoot: string, homeDir: string): string {
  const trimmed = inputPath.trim().replace(/\/$/, '')
  if (!trimmed) return workspaceRoot
  if (trimmed.startsWith('~')) {
    return expandTildePath(trimmed, homeDir)
  }
  if (trimmed.startsWith('/')) return trimmed
  const root = workspaceRoot.replace(/\/$/, '')
  const rel = trimmed.replace(/^\.\//, '')
  return `${root}/${rel}`
}

/** Parent directory + final path segment for location-bar completion queries. */
function resolveLocationCompletionQuery(
  inputPath: string,
  workspaceRoot: string,
  homeDir: string
): { dir: string; prefix: string } {
  const trimmed = inputPath.trim()
  if (!trimmed) return { dir: workspaceRoot, prefix: '' }
  const endsWithSlash = trimmed.endsWith('/')
  const resolved = resolveBrowsePath(trimmed, workspaceRoot, homeDir)
  const normalized = resolved.replace(/\/$/, '')
  const lastSlash = normalized.lastIndexOf('/')
  if (endsWithSlash) {
    return { dir: normalized || workspaceRoot, prefix: '' }
  }
  if (lastSlash < 0) {
    return { dir: workspaceRoot, prefix: normalized }
  }
  return {
    dir: normalized.slice(0, lastSlash) || workspaceRoot,
    prefix: normalized.slice(lastSlash + 1)
  }
}

function normalizeTreePath(path: string): string {
  return path.replace(/\/$/, '')
}

function isPathUnderRoot(path: string, root: string): boolean {
  const p = normalizeTreePath(path)
  const r = normalizeTreePath(root)
  return p === r || p.startsWith(`${r}/`)
}

function collectAncestorDirs(targetPath: string, workspaceRoot: string): string[] {
  const ancestors: string[] = []
  let cur = normalizeTreePath(targetPath)
  const root = normalizeTreePath(workspaceRoot)
  if (cur === root) return ancestors
  cur = dirnamePath(cur)
  while (isPathUnderRoot(cur, root) && cur !== root) {
    ancestors.unshift(cur)
    cur = dirnamePath(cur)
  }
  return ancestors
}

function treePathMatches(selected: string | null, candidate: string): boolean {
  if (!selected) return false
  return normalizeTreePath(selected) === normalizeTreePath(candidate)
}

function serializeFileTreeRoots(roots: FileTreeRoot[] | null | undefined): string {
  if (!roots?.length) return ''
  return roots.map((r) => `${r.label}\0${r.path}`).join('\n')
}

function deserializeFileTreeRoots(key: string): FileTreeRoot[] {
  if (!key) return []
  return key.split('\n').map((line) => {
    const sep = line.indexOf('\0')
    if (sep < 0) return { label: line, path: line }
    return { label: line.slice(0, sep), path: line.slice(sep + 1) }
  })
}

function treeWorkspaceRootForPath(
  path: string,
  defaultRoot: string,
  fileTreeRoots: Array<{ label: string; path: string }> | null | undefined
): string {
  if (fileTreeRoots?.length) {
    for (const root of fileTreeRoots) {
      if (treePathMatches(path, root.path) || isPathUnderRoot(path, root.path)) return root.path
    }
  }
  return defaultRoot
}

/** Which workspace root to pass as `filesDir`/`filesList` root for a target path. */
function filesDirListRootForPath(
  path: string,
  defaultRoot: string,
  fileTreeRoots: Array<{ label: string; path: string }> | null | undefined
): string {
  return treeWorkspaceRootForPath(path, defaultRoot, fileTreeRoots)
}

function canBrowseDirectoryInSession(
  dir: string,
  workspaceRoot: string,
  fileTreeRoots: Array<{ label: string; path: string }> | null | undefined
): boolean {
  const normalized = normalizeTreePath(dir)
  const workspace = normalizeTreePath(workspaceRoot)
  if (normalized === workspace || isPathUnderRoot(normalized, workspace)) return true
  if (!fileTreeRoots?.length) return false
  return fileTreeRoots.some((root) => {
    const rootPath = normalizeTreePath(root.path)
    return (
      normalized === rootPath ||
      isPathUnderRoot(normalized, rootPath) ||
      isPathUnderRoot(rootPath, normalized)
    )
  })
}

type ProfileBarInfo = {
  name: string
  workspacePath: string
  dirCount: number
}

type FileTreeRoot = {
  label: string
  path: string
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
              className={`ft-item${n.type === 'dir' ? ' dir' : ''}${treePathMatches(selected, n.path) ? ' active' : ''}`}
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => n.type === 'dir' ? onToggleDir(n) : onSelect(n)}
              data-testid={n.type === 'file' ? 'file-tree-file' : 'file-tree-dir'}
              data-path={n.relativePath}
              data-abs-path={n.path}
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
  sessionId,
  hostname,
  effectiveTheme,
  active = true,
  revealFilePath,
  revealFileSeq = 0,
  onRevealFileHandled,
  revealFileDiffPath,
  revealFileDiffSeq = 0,
  onRevealFileDiffHandled,
  onAddComment,
  onOpenFileQuickOpen,
  initialFilesTree,
  profileBar = null,
  fileTreeRoots = null
}: {
  projectPath: string
  sessionId?: string
  hostname: string | null
  /** Matches `data-theme` on `<html>` — drives Monaco editor colors. */
  effectiveTheme: 'light' | 'dark'
  /** When false, panel stays mounted (session buffered); Monaco layout refreshes on re-show. */
  active?: boolean
  /** Absolute path to select in the editor when `revealFileSeq` bumps (plan card → Files). */
  revealFilePath?: string
  revealFileSeq?: number
  onRevealFileHandled?: () => void
  /** Absolute cap path outside workspace — opens inline diff in Files (not Diff tab). */
  revealFileDiffPath?: string
  revealFileDiffSeq?: number
  onRevealFileDiffHandled?: () => void
  /** Push an inline file-line comment into the session composer (same as Diff panel). */
  onAddComment?: (note: string) => void
  /** Ctrl+X Ctrl+F from the Monaco editor — opens the file quick open palette. */
  onOpenFileQuickOpen?: () => void
  /** Preloaded one-level tree from session workspace (main process). */
  initialFilesTree?: FileTreeNode[] | null
  profileBar?: ProfileBarInfo | null
  fileTreeRoots?: FileTreeRoot[] | null
}): JSX.Element {
  /** Harness cwd / worktree — where files are actually read and written. */
  const browseRoot = projectPath
  const [localHomeDir, setLocalHomeDir] = useState<string | null>(null)
  useEffect(() => {
    if (hostname) return
    void window.atelier.getHomedir().then(setLocalHomeDir)
  }, [hostname])
  const homeDir = hostname ? REMOTE_SESSION_HOME : (localHomeDir ?? '/')
  const [tree, setTree] = useState<FileTreeNode[] | null>(null)
  const [profileRootTrees, setProfileRootTrees] = useState<Map<string, FileTreeNode[]>>(new Map())
  const [openTabs, setOpenTabs] = useState<OpenEditorTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const nextTabIdRef = useRef(0)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
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
  const onOpenFileQuickOpenRef = useRef(onOpenFileQuickOpen)
  onOpenFileQuickOpenRef.current = onOpenFileQuickOpen

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
  const fileResultRef = useRef<FileReadResult | null>(null)
  const openSeqRef = useRef(0)
  const [editorEpoch, setEditorEpoch] = useState(0)
  const saveCurrentFileRef = useRef<(() => Promise<void>) | null>(null)
  const lastRevealSeqRef = useRef(0)
  const lastRevealDiffSeqRef = useRef(0)
  const handleLocationCommitRef = useRef<(path: string) => Promise<void>>(async () => {})
  const locationCommitInFlightRef = useRef(false)
  const fileViewRef = useRef<HTMLDivElement | null>(null)
  const treeScrollRef = useRef<HTMLDivElement | null>(null)
  const [treeFocusPath, setTreeFocusPath] = useState<string | null>(null)
  const [capDiff, setCapDiff] = useState<{ file: DiffFileChange; pair: DiffFileContentPair } | null>(null)
  const [browseDirPath, setBrowseDirPath] = useState<string | null>(null)
  const [browseDirChildren, setBrowseDirChildren] = useState<FileTreeNode[] | null>(null)
  const [browseDirLoading, setBrowseDirLoading] = useState(false)
  const treeSelectedPath = browseDirPath ?? selectedPath

  const [gutterHoverLine, setGutterHoverLine] = useState<number | null>(null)
  const [commentingLine, setCommentingLine] = useState<number | null>(null)
  const [commentText, setCommentText] = useState('')
  /** Bumped on Monaco scroll/layout so gutter overlays track visible lines. */
  const [overlayTick, setOverlayTick] = useState(0)

  // Keep ref in sync so the save keybinding closure can read it
  useEffect(() => { selectedPathRef.current = selectedPath }, [selectedPath])
  useEffect(() => { fileResultRef.current = fileResult }, [fileResult])
  useEffect(() => { dirChildrenRef.current = dirChildren }, [dirChildren])
  // Sync location bar when selection/browsing changes — not when edit mode toggles (that reverts typed paths).
  useEffect(() => {
    if (locationEditing || locationCommitInFlightRef.current) return
    setLocationInput(browseDirPath ?? selectedPath ?? projectPath)
  }, [browseDirPath, selectedPath, projectPath])

  const fileTreeRootsKey = serializeFileTreeRoots(fileTreeRoots)
  const workspaceScopeKey = `${projectPath}\0${hostname ?? ''}\0${fileTreeRootsKey}`
  const workspaceScopeRef = useRef<string | null>(null)

  // Reset editor tabs only when the workspace scope changes — not when the
  // session workspace snapshot refreshes (new filesTree array) or when the
  // Files tab becomes visible again after viewing Chat.
  useEffect(() => {
    if (!active) return
    const prevScope = workspaceScopeRef.current
    if (prevScope === workspaceScopeKey) return
    workspaceScopeRef.current = workspaceScopeKey

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
    lastRevealDiffSeqRef.current = 0
    setCapDiff(null)
    setBrowseDirPath(null)
    setBrowseDirChildren(null)
    setBrowseDirLoading(false)
    setTreeFocusPath(null)
  }, [active, workspaceScopeKey, projectPath])

  // ── Load file tree ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return
    if (fileTreeRootsKey) return
    if (initialFilesTree != null) {
      setTree(initialFilesTree)
      return
    }
    void window.atelier.filesTree(projectPath, hostname).then(setTree)
  }, [active, projectPath, hostname, fileTreeRootsKey, initialFilesTree])

  useEffect(() => {
    if (!active || !fileTreeRootsKey) {
      if (!active) return
      setProfileRootTrees(new Map())
      return undefined
    }
    const roots = deserializeFileTreeRoots(fileTreeRootsKey)
    let cancelled = false
    void Promise.all(
      roots.map(async (root) => {
        const children = await window.atelier.filesDir(root.path, root.path, hostname)
        return [root.path, children] as const
      })
    ).then((entries) => {
      if (cancelled) return
      setProfileRootTrees(new Map(entries))
    })
    return () => {
      cancelled = true
    }
    // Only fileTreeRootsKey — parent passes a new array ref every render during streaming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fileTreeRootsKey, hostname])

  useEffect(() => {
    if (!active) return
    editorRef.current?.layout()
  }, [active])

  useEffect(() => {
    monaco.editor.setTheme(monacoThemeId(effectiveTheme))
  }, [effectiveTheme])

  const applyTextFileToEditor = useCallback((): monaco.editor.ITextModel | null => {
    const editor = editorRef.current
    const result = fileResultRef.current
    const path = selectedPathRef.current
    if (!editor || result?.kind !== 'text') return null

    const lang = detectLanguage(result.extension)
    const uri = modelUriForPath(path ?? 'untitled')

    let model = monaco.editor.getModel(uri)
    const modelExisted = Boolean(model)
    if (model) {
      if (model.getValue() !== result.content) {
        model.setValue(result.content)
      }
      monaco.editor.setModelLanguage(model, lang)
    } else {
      model = monaco.editor.createModel(result.content, lang, uri)
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
    editor.layout()
    return model
  }, [])

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
    registerEmacsMonacoKeybindings(editor, {
      onFileQuickOpen: () => onOpenFileQuickOpenRef.current?.()
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveCurrentFileRef.current?.()
    })
    setEditorEpoch((n) => n + 1)
    queueMicrotask(() => applyTextFileToEditor())
  }, [applyTextFileToEditor, effectiveTheme])

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
    setOpenError(null)
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
    const model = applyTextFileToEditor()
    if (!model) return

    const sub = model.onDidChangeContent(() => {
      const path = selectedPathRef.current
      if (!path) return
      setOpenTabs((prev) => prev.map((t) => (t.path === path ? { ...t, isDirty: true } : t)))
    })
    return () => sub.dispose()
  }, [fileResult, selectedPath, editorEpoch, applyTextFileToEditor])

  // ── HTML preview srcdoc must be set imperatively after mount ───────────────
  useEffect(() => {
    if (fileResult?.kind === 'html' && htmlPreviewRef.current) {
      htmlPreviewRef.current.srcdoc = fileResult.content
    }
  }, [fileResult, editorEpoch])

  // ── Completion fetch (debounced 120ms) ────────────────────────────────────
  function fetchCompletions(input: string): void {
    if (completionTimerRef.current) clearTimeout(completionTimerRef.current)
    completionTimerRef.current = setTimeout(async () => {
      if (!input) { setCompletions([]); return }
      const { dir, prefix } = resolveLocationCompletionQuery(input, browseRoot, homeDir)
      const listRoot = filesDirListRootForPath(dir, browseRoot, fileTreeRoots)
      try {
        const children = await window.atelier.filesDir(listRoot, dir || listRoot, hostname)
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
  async function revealInTree(focusPath: string): Promise<void> {
    const normalized = normalizeTreePath(focusPath)
    const treeRoot = treeWorkspaceRootForPath(normalized, browseRoot, fileTreeRoots)
    const ancestors = collectAncestorDirs(normalized, treeRoot)
    const fetched = new Map<string, FileTreeNode[]>()
    await Promise.all(ancestors.map(async (dir) => {
      if (!dirChildrenRef.current.has(dir)) {
        const listRoot = treeWorkspaceRootForPath(dir, browseRoot, fileTreeRoots)
        const children = await window.atelier.filesDir(listRoot, dir, hostname)
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
    setTreeFocusPath(normalized)
  }

  useEffect(() => {
    if (!treeFocusPath || !treeScrollRef.current) return
    let outer = 0
    let inner = 0
    outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const root = treeScrollRef.current
        if (!root) return
        for (const el of root.querySelectorAll<HTMLElement>('[data-abs-path]')) {
          if (treePathMatches(treeFocusPath, el.dataset.absPath ?? '')) {
            el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
            break
          }
        }
      })
    })
    return () => {
      cancelAnimationFrame(outer)
      cancelAnimationFrame(inner)
    }
  }, [treeFocusPath, expanded, dirChildren, treeSelectedPath])

  // ── Open a directory in the content pane ───────────────────────────────────
  async function openDirectoryInView(inputPath: string, seq?: number): Promise<void> {
    const dirPath = resolveBrowsePath(inputPath, browseRoot, homeDir)
    const mySeq = seq ?? ++openSeqRef.current
    setBrowseDirLoading(true)
    setBrowseDirPath(dirPath)
    setBrowseDirChildren(null)
    setLocationInput(dirPath)
    setCapDiff(null)
    try {
      const cached = dirChildrenRef.current.get(dirPath)
      const listRoot = filesDirListRootForPath(dirPath, browseRoot, fileTreeRoots)
      const children = cached ?? await window.atelier.filesDir(listRoot, dirPath, hostname)
      if (mySeq !== openSeqRef.current) return
      setBrowseDirChildren(children)
      setDirChildren((prev) => new Map(prev).set(dirPath, children))
      setExpanded((prev) => new Set(prev).add(dirPath))
      await revealInTree(dirPath)
    } catch {
      if (mySeq !== openSeqRef.current) return
      setBrowseDirPath(null)
      setBrowseDirChildren(null)
      setLocationInput(selectedPath ?? dirPath ?? projectPath)
    } finally {
      if (mySeq === openSeqRef.current) {
        setBrowseDirLoading(false)
      }
    }
  }

  // ── Open / switch / close editor tabs ─────────────────────────────────────
  async function openInCurrentTab(
    path: string,
    cachedResult?: FileReadResult,
    seq?: number
  ): Promise<void> {
    const mySeq = seq ?? ++openSeqRef.current
    const activeId = activeTabIdRef.current
    const active = openTabsRef.current.find((t) => t.id === activeId)
    setBrowseDirPath(null)
    setBrowseDirChildren(null)
    if (active?.path === path && cachedResult === undefined) {
      setLocationInput(path)
      setSaveError(null)
      setOpenError(null)
      await revealInTree(path)
      return
    }

    const result = cachedResult ?? (await window.atelier.filesRead(path, hostname))
    if (mySeq !== openSeqRef.current) return

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
    setOpenError(null)
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
    setBrowseDirPath(null)
    setBrowseDirChildren(null)
    setActiveTabId(tabId)
    setLocationInput(tab.path ?? projectPath)
    setSaveError(null)
    setOpenError(null)
    if (tab.path) void revealInTree(tab.path)
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
    const resolvedPath = resolveBrowsePath(path, browseRoot, homeDir)
    const mySeq = ++openSeqRef.current
    locationCommitInFlightRef.current = true
    setLocationInput(resolvedPath)
    setCompletions([])
    setOpenError(null)
    try {
      if (await window.atelier.filesIsDirectory(resolvedPath, hostname)) {
        if (mySeq !== openSeqRef.current) return
        setLocationEditing(false)
        await openDirectoryInView(resolvedPath, mySeq)
        return
      }
      const result = await window.atelier.filesRead(resolvedPath, hostname)
      if (mySeq !== openSeqRef.current) return
      setLocationEditing(false)
      await openInCurrentTab(resolvedPath, result, mySeq)
    } catch {
      if (mySeq !== openSeqRef.current) return
      const parentDir = dirnamePath(resolvedPath)
      if (
        parentDir !== resolvedPath &&
        canBrowseDirectoryInSession(parentDir, browseRoot, fileTreeRoots)
      ) {
        try {
          setLocationEditing(false)
          await openDirectoryInView(parentDir, mySeq)
          setOpenError(`Could not open ${basenamePath(resolvedPath)}`)
          return
        } catch {
          if (mySeq !== openSeqRef.current) return
        }
      }
      setLocationInput(resolvedPath)
      setLocationEditing(false)
      setOpenError(`Could not open ${basenamePath(resolvedPath)}`)
    } finally {
      locationCommitInFlightRef.current = false
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

  useEffect(() => {
    if (!active || !sessionId || !revealFileDiffPath || !revealFileDiffSeq) return
    if (revealFileDiffSeq === lastRevealDiffSeqRef.current) return
    lastRevealDiffSeqRef.current = revealFileDiffSeq
    void (async () => {
      const loaded = await window.atelier.capOutsideFileDiff(sessionId, projectPath, revealFileDiffPath)
      if (loaded) {
        setCapDiff(loaded)
        setLocationInput(revealFileDiffPath)
      }
      onRevealFileDiffHandled?.()
    })()
  }, [
    active,
    sessionId,
    projectPath,
    hostname,
    revealFileDiffPath,
    revealFileDiffSeq,
    onRevealFileDiffHandled
  ])

  // ── Directory expansion ────────────────────────────────────────────────────
  async function handleToggleDir(node: FileTreeNode): Promise<void> {
    if (expanded.has(node.path)) {
      setExpanded((prev) => { const s = new Set(prev); s.delete(node.path); return s })
      return
    }
    setExpanded((prev) => new Set(prev).add(node.path))
    if (!dirChildren.has(node.path)) {
      setLoadingDirs((prev) => new Set(prev).add(node.path))
      const listRoot = treeWorkspaceRootForPath(node.path, browseRoot, fileTreeRoots)
      const children = await window.atelier.filesDir(listRoot, node.path, hostname)
      setDirChildren((prev) => new Map(prev).set(node.path, children))
      setLoadingDirs((prev) => { const s = new Set(prev); s.delete(node.path); return s })
    }
  }

  // ── File selection ─────────────────────────────────────────────────────────
  async function handleSelect(node: FileTreeNode): Promise<void> {
    if (node.type === 'dir') return
    setCapDiff(null)
    await openInCurrentTab(node.path)
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const profileMode = Boolean(fileTreeRoots?.length)
  const profileTreesLoading =
    profileMode && fileTreeRoots!.some((root) => !profileRootTrees.has(root.path))
  const filesTreeLoading = profileMode ? profileTreesLoading : tree === null

  return (
    <div data-testid={active ? 'files-panel-active' : undefined} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {filesTreeLoading ? (
        <div className="empty-main" style={{ height: '100%' }}>
          <div className="empty-icon">📁</div>
          <div>Loading files…</div>
        </div>
      ) : !profileMode && tree!.length === 0 ? (
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
                if (locationCommitInFlightRef.current) return
                setLocationEditing(false)
                setCompletions([])
                setLocationInput(browseDirPath ?? selectedPath ?? projectPath)
              }, 150)
            }}
            onChange={(e) => { setLocationInput(e.target.value); fetchCompletions(e.target.value) }}
            onKeyDown={(e) => {
              if (completions.length > 0) {
                if (e.key === 'ArrowDown') { e.preventDefault(); setCompletionIdx((i) => Math.min(i + 1, completions.length - 1)); return }
                if (e.key === 'ArrowUp') { e.preventDefault(); setCompletionIdx((i) => Math.max(i - 1, 0)); return }
                if (e.key === 'Tab') {
                  e.preventDefault(); acceptCompletion(completions[completionIdx]); return
                }
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                setCompletions([])
                void handleLocationCommit(locationInput)
              }
              if (e.key === 'Escape') { setLocationEditing(false); setCompletions([]); setLocationInput(browseDirPath ?? selectedPath ?? projectPath); (e.target as HTMLInputElement).blur() }
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
        {(openTabs.length > 0 || (tree?.length ?? 0) > 0 || (fileTreeRoots?.length ?? 0) > 0) && (
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
          {profileBar && (
            <div className="files-profile-bar" data-testid="files-profile-bar">
              <span className="profile-badge">{profileBar.name}</span>
              <span>
                workspace{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>{profileBar.workspacePath}</span>
              </span>
              <span>·</span>
              <span>
                {profileBar.dirCount} file director{profileBar.dirCount === 1 ? 'y' : 'ies'}
              </span>
            </div>
          )}
          <div className="files-body-inner">
          <div className="files-tree" data-testid="files-tree" ref={treeScrollRef}>
            {fileTreeRoots?.length ? (
              fileTreeRoots.map((root) => (
                <div className="files-tree-root" key={root.path} data-testid="files-tree-root">
                  <div className="files-tree-root-label">
                    <span className="root-kind">{root.label}</span> {root.path}
                  </div>
                  <FileTree
                    nodes={profileRootTrees.get(root.path) ?? []}
                    depth={0}
                    selected={treeSelectedPath}
                    dirtyPaths={dirtyPaths}
                    expanded={expanded}
                    loadingDirs={loadingDirs}
                    dirChildren={dirChildren}
                    onSelect={(n) => void handleSelect(n)}
                    onToggleDir={(n) => void handleToggleDir(n)}
                  />
                </div>
              ))
            ) : (
              <FileTree
                nodes={tree ?? []}
                depth={0}
                selected={treeSelectedPath}
                dirtyPaths={dirtyPaths}
                expanded={expanded}
                loadingDirs={loadingDirs}
                dirChildren={dirChildren}
                onSelect={(n) => void handleSelect(n)}
                onToggleDir={(n) => void handleToggleDir(n)}
              />
            )}
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
              style={{ display: capDiff ? 'none' : 'flex', flex: 1, minHeight: 0 }}
            />

            {capDiff && sessionId ? (
              <div
                className="files-cap-diff"
                data-testid="files-cap-diff"
                style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}
              >
                <DiffFullFileEditor
                  workspacePath={projectPath}
                  file={capDiff.file}
                  contentPair={capDiff.pair}
                  hostname={hostname}
                  effectiveTheme={effectiveTheme}
                  active={active}
                  scopeKey={sessionId}
                />
              </div>
            ) : null}

            {/* Non-text overlays: cover Monaco with an absolute panel when needed */}
            {!capDiff && browseDirPath && (
              <div
                className="files-dir-listing"
                data-testid="files-dir-listing"
                style={{ position: 'absolute', inset: 0, overflow: 'auto', zIndex: 5, background: 'var(--bg-code)' }}
              >
                <div className="files-dir-listing-header">{basenamePath(browseDirPath)}</div>
                {browseDirLoading ? (
                  <div className="files-dir-listing-empty">Loading…</div>
                ) : browseDirChildren == null ? (
                  <div className="files-dir-listing-empty">Could not read directory</div>
                ) : browseDirChildren.length === 0 ? (
                  <div className="files-dir-listing-empty">Empty directory</div>
                ) : (
                  browseDirChildren.map((n) => (
                    <button
                      key={n.path}
                      type="button"
                      className={`files-dir-listing-item${n.type === 'dir' ? ' dir' : ''}`}
                      data-testid={n.type === 'dir' ? 'files-dir-listing-dir' : 'files-dir-listing-file'}
                      onClick={() => {
                        if (n.type === 'dir') void openDirectoryInView(n.path)
                        else void handleSelect(n)
                      }}
                    >
                      {n.type === 'dir' ? <IconFolder /> : <IconFile />}
                      <span>{n.name}</span>
                    </button>
                  ))
                )}
              </div>
            )}

            {!capDiff && !fileResult && !browseDirPath && !selectedPath && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-code)', color: 'var(--text-tertiary)' }}>
                Select a file to edit
              </div>
            )}
            {!capDiff && fileResult?.kind === 'image' && !browseDirPath && (
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
            {!capDiff && fileResult?.kind === 'html' && !browseDirPath && (
              <iframe
                ref={htmlPreviewRef}
                className="file-preview-html"
                data-testid="file-preview-html"
                title="html preview"
                sandbox=""
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
              />
            )}
            {!capDiff && fileResult?.kind === 'binary' && !browseDirPath && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-code)', color: 'var(--text-tertiary)' }}>
                Binary file — no preview available
              </div>
            )}

            {!capDiff && showEditor && onAddComment && (
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
                        onKeyDown={(e) => {
                          handleEmacsTextareaKeyDown(e, commentText, setCommentText)
                        }}
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
            {(saveError || openError) && (
              <div
                style={{
                  position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
                  background: 'var(--danger-dim)', border: '1px solid var(--danger)',
                  color: 'var(--danger)', borderRadius: 8, padding: '6px 14px', fontSize: 13,
                  zIndex: 10, whiteSpace: 'nowrap',
                }}
              >
                {saveError ? `Save failed: ${saveError}` : openError}
              </div>
            )}
          </div>
          </div>
        </div>
        </>
      )}
    </div>
  )
}
