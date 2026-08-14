import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommitInfo, DiffFileChange, DiffSummary, WorktreeInfo } from '../../../../shared/panel-types'
import Linkify, { openExternalLink } from './Linkify'
import DiffFullFileEditor from './DiffFullFileEditor'
import { handleEmacsTextareaKeyDown } from '../../palette-input-keys'

type DiffSubTab = 'changes' | 'commits' | 'worktrees'
type DiffFileViewMode = 'hunks' | 'full'

function DiffFileHeader({
  file,
  viewMode,
  onToggleViewMode,
  fileDiffLoading
}: {
  file: DiffFileChange
  viewMode: DiffFileViewMode
  onToggleViewMode: () => void
  fileDiffLoading?: boolean
}): JSX.Element {
  const expandLabel = viewMode === 'full' ? 'Show hunks' : 'Expand file'
  const canExpand = file.additions > 0 || file.deletions > 0 || file.status === 'added' || file.status === 'deleted'
  const expandDisabled =
    viewMode === 'hunks' &&
    Boolean(fileDiffLoading) &&
    file.hunks.length === 0 &&
    (file.additions > 0 || file.deletions > 0)
  return (
    <div className="diff-file-header">
      <span className="diff-path">{file.path}</span>
      <span className="badge-mod">{file.status}</span>
      {fileDiffLoading && viewMode === 'hunks' && file.hunks.length === 0 && (
        <span style={{ opacity: 0.7, fontSize: 13.5 }}>Loading…</span>
      )}
      {canExpand && (
        <button
          type="button"
          className="diff-file-expand-btn"
          data-testid="diff-file-expand-btn"
          disabled={expandDisabled}
          title={
            expandDisabled
              ? 'Loading diff…'
              : viewMode === 'full'
                ? 'Return to hunk diff'
                : 'View full file with inline diff (read-only)'
          }
          onClick={(e) => {
            e.stopPropagation()
            onToggleViewMode()
          }}
        >
          {expandLabel}
        </button>
      )}
    </div>
  )
}

function DiffFileCard({
  activeFile,
  fileDiffLoading,
  commentingLine,
  commentText,
  onToggleCommentLine,
  onCommentTextChange,
  onSubmitComment,
  onCancelComment
}: {
  activeFile: DiffFileChange
  fileDiffLoading: boolean
  commentingLine: string | null
  commentText: string
  onToggleCommentLine: (lineKey: string) => void
  onCommentTextChange: (text: string) => void
  onSubmitComment: (file: string, lineKey: string, lineText: string) => void
  onCancelComment: () => void
}): JSX.Element {
  return (
    <div className="diff-file-card" data-testid="diff-file-card">
      <div className="diff-lines">
        {activeFile.hunks.length === 0 && !fileDiffLoading ? (
          <div style={{ padding: 12, color: 'var(--text-tertiary)', fontSize: 13.5 }}>
            {activeFile.additions === 0 && activeFile.deletions === 0
              ? 'Binary or non-text change — no line diff to show'
              : 'No diff lines for this file'}
          </div>
        ) : null}
        {activeFile.hunks.map((hunk, hi) =>
          hunk.lines.map((line, li) => {
            const lineKey = `${hi}-${li}`
            return (
              <div key={lineKey}>
                <div className={`diff-line ${line.kind === 'add' ? 'add' : line.kind === 'del' ? 'del' : 'ctx'}`}>
                  <div className="ln">{line.newLine ?? line.oldLine ?? ''}</div>
                  <div className="content">
                    <button
                      className="comment-add"
                      title="Add inline comment"
                      data-testid="diff-add-comment-btn"
                      onClick={() => onToggleCommentLine(lineKey)}
                    >
                      💬
                    </button>
                    {line.content}
                  </div>
                </div>
                {commentingLine === lineKey && (
                  <div className="inline-comment" data-testid="diff-inline-comment">
                    <textarea
                      rows={2}
                      placeholder="Comment on this line…"
                      value={commentText}
                      onChange={(e) => onCommentTextChange(e.target.value)}
                      onKeyDown={(e) => {
                        handleEmacsTextareaKeyDown(e, commentText, onCommentTextChange)
                      }}
                      data-testid="diff-comment-input"
                    />
                    <div className="inline-comment-actions">
                      <button
                        className="btn btn-primary btn-sm"
                        data-testid="diff-comment-submit"
                        onClick={() => onSubmitComment(activeFile.path, lineKey, line.content)}
                      >
                        Add to next message
                      </button>
                      <button className="btn btn-sm" onClick={onCancelComment}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function DiffReviewBody({
  files,
  selectedFile,
  onSelectFile,
  activeFile,
  fileDiffLoading,
  viewMode,
  onToggleViewMode,
  workspacePath,
  hostname,
  effectiveTheme,
  panelScopeKey,
  commitHash,
  panelActive,
  commentingLine,
  commentText,
  onToggleCommentLine,
  onCommentTextChange,
  onSubmitComment,
  onCancelComment
}: {
  files: DiffFileChange[]
  selectedFile: string | null
  onSelectFile: (path: string) => void
  activeFile: DiffFileChange | undefined
  fileDiffLoading: boolean
  viewMode: DiffFileViewMode
  onToggleViewMode: () => void
  workspacePath: string
  hostname?: string | null
  effectiveTheme: 'light' | 'dark'
  panelScopeKey: string
  commitHash?: string | null
  panelActive: boolean
  commentingLine: string | null
  commentText: string
  onToggleCommentLine: (lineKey: string) => void
  onCommentTextChange: (text: string) => void
  onSubmitComment: (file: string, lineKey: string, lineText: string) => void
  onCancelComment: () => void
}): JSX.Element {
  return (
    <div className="review-body">
      <div className="file-tree">
        <div className="ft-summary" data-testid="diff-file-summary">
          {files.length} file{files.length === 1 ? '' : 's'} changed ·{' '}
          <span className="ft-add">+{files.reduce((n, f) => n + f.additions, 0)}</span>
          <span className="ft-del">−{files.reduce((n, f) => n + f.deletions, 0)}</span>
        </div>
        {files.map((f) => (
          <div
            key={f.path}
            className={`ft-item${selectedFile === f.path ? ' active' : ''}`}
            onClick={() => onSelectFile(f.path)}
            data-testid="diff-file-row"
          >
            <span className="fname">{f.path}</span>
            <span className="ft-counts">
              {f.additions > 0 && <span className="ft-add">+{f.additions}</span>}
              {f.deletions > 0 && <span className="ft-del">-{f.deletions}</span>}
            </span>
          </div>
        ))}
      </div>
      <div className={`diff-area${viewMode === 'full' ? ' diff-area--full-file' : ''}`}>
        {activeFile && (
          <>
            <DiffFileHeader
              file={activeFile}
              viewMode={viewMode}
              onToggleViewMode={onToggleViewMode}
              fileDiffLoading={fileDiffLoading}
            />
            {viewMode === 'full' ? (
              <DiffFullFileEditor
                workspacePath={workspacePath}
                file={activeFile}
                hostname={hostname}
                effectiveTheme={effectiveTheme}
                active={panelActive}
                commitHash={commitHash}
                scopeKey={panelScopeKey}
              />
            ) : (
              <DiffFileCard
                activeFile={activeFile}
                fileDiffLoading={fileDiffLoading}
                commentingLine={commentingLine}
                commentText={commentText}
                onToggleCommentLine={onToggleCommentLine}
                onCommentTextChange={onCommentTextChange}
                onSubmitComment={onSubmitComment}
                onCancelComment={onCancelComment}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Prefer a text diff over binary (-/- numstat) when opening a commit. */
function defaultCommitFilePath(files: DiffFileChange[]): string | null {
  const withStats = files.find((f) => f.additions > 0 || f.deletions > 0)
  return withStats?.path ?? files[0]?.path ?? null
}

/**
 * Diff/Review panel (07-secondary-panels §2): SCM-first changes list with
 * lazy per-file hunks, lazy commits/worktrees sub-tabs, and background refresh
 * while mounted (VS Code–style remote git economics via session-scoped cache in main).
 */
export default function DiffPanel({
  workspacePath,
  repoRoot,
  hostname,
  onAddComment,
  active = true,
  effectiveTheme,
  panelScopeKey,
  revealChangePath,
  revealChangeSeq = 0,
  onRevealChangeHandled,
  injectDiffFile,
  injectDiffFileSeq = 0,
  revealCommitHash,
  revealCommitSeq = 0,
  onRevealCommitHandled,
  workspaceDiff,
  workspaceRefreshing = false,
  onRefreshWorkspace
}: {
  /** Git cwd for changes, file diffs, and commits (session worktree when set). */
  workspacePath: string
  /** Main repo root for worktree list/add/merge/remove (`.atelier/worktrees`). */
  repoRoot: string
  hostname?: string | null
  onAddComment: (note: string) => void
  /** When false, panel stays mounted but skips lazy sub-tab loads tied to visibility. */
  active?: boolean
  effectiveTheme: 'light' | 'dark'
  /** Stable id for Monaco model URIs (session id). */
  panelScopeKey: string
  /** Repo-relative path to select on Changes (from chat uncommitted-changes cap). */
  revealChangePath?: string
  revealChangeSeq?: number
  onRevealChangeHandled?: () => void
  /** Cap file preloaded from its own git repo (nested repo when session cwd is `~`). */
  injectDiffFile?: DiffFileChange
  injectDiffFileSeq?: number
  /** Full commit hash to open on Commits (from chat changes cap). */
  revealCommitHash?: string
  revealCommitSeq?: number
  onRevealCommitHandled?: () => void
  /** Preloaded / pushed diff summary from main workspace service. */
  workspaceDiff?: DiffSummary | null
  /** Main-process workspace diff refresh in flight for this session. */
  workspaceRefreshing?: boolean
  /** Request immediate git refresh in main (Diff › Changes). */
  onRefreshWorkspace?: () => void
}): JSX.Element {
  const [sub, setSub] = useState<DiffSubTab>('changes')
  const [summary, setSummary] = useState<DiffSummary | null>(null)
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  const [worktrees, setWorktrees] = useState<WorktreeInfo[] | null>(null)
  const [commitsLoading, setCommitsLoading] = useState(false)
  const [worktreesLoading, setWorktreesLoading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileDiffLoading, setFileDiffLoading] = useState(false)
  const [commentingLine, setCommentingLine] = useState<string | null>(null)
  const [commentText, setCommentText] = useState('')
  const [newWorktreeBranch, setNewWorktreeBranch] = useState('')
  const [worktreeError, setWorktreeError] = useState<string | null>(null)
  const [selectedCommit, setSelectedCommit] = useState<CommitInfo | null>(null)
  const [commitFiles, setCommitFiles] = useState<DiffFileChange[] | null>(null)
  const [commitSelectedFile, setCommitSelectedFile] = useState<string | null>(null)
  const [commitDiffLoading, setCommitDiffLoading] = useState(false)
  const [commitFileDiffLoading, setCommitFileDiffLoading] = useState(false)
  const [changesViewMode, setChangesViewMode] = useState<DiffFileViewMode>('hunks')
  const [commitViewMode, setCommitViewMode] = useState<DiffFileViewMode>('hunks')
  const loadedHunksRef = useRef<Set<string>>(new Set())
  const summaryRef = useRef<DiffSummary | null>(null)
  const commitLoadedHunksRef = useRef<Set<string>>(new Set())
  type CommitDetailSnapshot = {
    files: DiffFileChange[]
    selectedFile: string | null
    loadedHunks: string[]
  }
  const commitDetailCacheRef = useRef<Map<string, CommitDetailSnapshot>>(new Map())

  const persistCommitDetailCache = useCallback(
    (commitHash: string, files: DiffFileChange[], selectedFile: string | null) => {
      commitDetailCacheRef.current.set(commitHash, {
        files,
        selectedFile,
        loadedHunks: [...commitLoadedHunksRef.current]
      })
    },
    []
  )

  const loadCommitFileHunks = useCallback(
    async (commitHash: string, filePath: string, force = false): Promise<void> => {
      if (!force && commitLoadedHunksRef.current.has(filePath)) return
      setCommitFileDiffLoading(true)
      try {
        const file = await window.atelier.gitCommitFileDiff(workspacePath, commitHash, filePath, hostname)
        if (file?.hunks.length) {
          commitLoadedHunksRef.current.add(filePath)
          setCommitFiles((prev) => {
            if (!prev) return [file]
            const next = prev.map((f) => (f.path === filePath ? file : f))
            const snap = commitDetailCacheRef.current.get(commitHash)
            if (snap) {
              commitDetailCacheRef.current.set(commitHash, {
                ...snap,
                files: next,
                loadedHunks: [...commitLoadedHunksRef.current]
              })
            }
            return next
          })
        }
      } finally {
        setCommitFileDiffLoading(false)
      }
    },
    [workspacePath, hostname]
  )

  const openCommit = useCallback(
    async (commit: CommitInfo): Promise<void> => {
      setCommentingLine(null)
      const cached = commitDetailCacheRef.current.get(commit.hash)
      if (cached) {
        setSelectedCommit(commit)
        setCommitFiles(cached.files)
        setCommitSelectedFile(cached.selectedFile)
        commitLoadedHunksRef.current = new Set(cached.loadedHunks)
        setCommitDiffLoading(false)
        return
      }

      setSelectedCommit(commit)
      setCommitFiles(null)
      setCommitSelectedFile(null)
      commitLoadedHunksRef.current.clear()
      setCommitDiffLoading(true)
      try {
        const diff = await window.atelier.gitCommitOpen(workspacePath, commit.hash, hostname)
        const first = defaultCommitFilePath(diff.files)
        commitLoadedHunksRef.current.clear()
        for (const f of diff.files) {
          if (f.hunks.length > 0) commitLoadedHunksRef.current.add(f.path)
        }
        setCommitFiles(diff.files)
        setCommitSelectedFile(first)
        persistCommitDetailCache(commit.hash, diff.files, first)
      } finally {
        setCommitDiffLoading(false)
      }
    },
    [workspacePath, hostname, persistCommitDetailCache]
  )

  const mergeFileIntoSummary = useCallback((file: DiffFileChange) => {
    setSummary((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        files: prev.files.map((f) => (f.path === file.path ? file : f))
      }
    })
  }, [])

  const mergeIncomingSummary = useCallback((diff: DiffSummary, prev: DiffSummary | null): DiffSummary => {
    if (!prev?.isRepo) return diff
    return {
      ...diff,
      files: diff.files.map((f) => {
        if (f.hunks.length > 0) return f
        const old = prev.files.find((o) => o.path === f.path)
        if (old?.hunks.length) return { ...f, hunks: old.hunks }
        return f
      })
    }
  }, [])

  const loadFileHunks = useCallback(
    async (filePath: string, force = false): Promise<void> => {
      const cached = summaryRef.current?.files.find((f) => f.path === filePath)
      if (!force && cached?.hunks.length) {
        loadedHunksRef.current.add(filePath)
        return
      }
      if (!force && loadedHunksRef.current.has(filePath)) return
      setFileDiffLoading(true)
      try {
        const file = await window.atelier.gitFileDiff(workspacePath, filePath, hostname)
        if (file) {
          loadedHunksRef.current.add(filePath)
          mergeFileIntoSummary(file)
        }
      } finally {
        setFileDiffLoading(false)
      }
    },
    [workspacePath, hostname, mergeFileIntoSummary]
  )

  const applySummary = useCallback(
    (diff: DiffSummary) => {
      summaryRef.current = diff
      for (const f of diff.files) {
        if (f.hunks.length > 0) loadedHunksRef.current.add(f.path)
      }
      setSummary((prev) => {
        const merged = mergeIncomingSummary(diff, prev)
        summaryRef.current = merged
        return merged
      })
      if (diff.files.length === 0) {
        setSelectedFile(null)
        loadedHunksRef.current.clear()
        return
      }
      setSelectedFile((prev) => {
        const next = prev && diff.files.some((f) => f.path === prev) ? prev : diff.files[0]!.path
        const file = diff.files.find((f) => f.path === next)
        if (next && !loadedHunksRef.current.has(next) && !file?.hunks.length) {
          void loadFileHunks(next)
        }
        return next
      })
    },
    [loadFileHunks, mergeIncomingSummary]
  )

  const refreshChanges = useCallback(
    async (force = false): Promise<void> => {
      const diff = await window.atelier.gitDiff(workspacePath, hostname, force)
      applySummary(diff)
    },
    [workspacePath, hostname, applySummary]
  )

  useEffect(() => {
    if (workspaceDiff == null) return
    applySummary(workspaceDiff)
  }, [workspaceDiff, applySummary])

  // Diff › Changes uses preloaded workspace data; background refresh runs from main.
  // Do not force a full git rescan on every tab switch — that duplicated preload work.

  // When the Diff tab becomes visible before workspace push arrives, bootstrap from IPC.
  useEffect(() => {
    if (!active || summaryRef.current != null) return
    if (workspaceDiff != null) {
      applySummary(workspaceDiff)
      return
    }
    void refreshChanges(true)
  }, [active, workspaceDiff, applySummary, refreshChanges])

  // Reset local UI when repo identity changes; fetch only if workspace push hasn't arrived yet.
  useEffect(() => {
    loadedHunksRef.current.clear()
    summaryRef.current = null
    setSummary(null)
    setCommits(null)
    setWorktrees(null)
    setSelectedCommit(null)
    setCommitFiles(null)
    setCommitSelectedFile(null)
    commitLoadedHunksRef.current.clear()
    commitDetailCacheRef.current.clear()
    if (workspaceDiff != null) {
      applySummary(workspaceDiff)
    } else if (active) {
      void refreshChanges(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only reset on repo identity, not on active toggle
  }, [workspacePath, hostname, refreshChanges])

  useEffect(() => {
    if (sub === 'commits' && commits === null && !commitsLoading) {
      setCommitsLoading(true)
      void window.atelier
        .gitCommits(workspacePath, hostname, false)
        .then(setCommits)
        .finally(() => setCommitsLoading(false))
    }
  }, [sub, commits, commitsLoading, workspacePath, hostname])

  useEffect(() => {
    if (sub === 'worktrees' && worktrees === null && !worktreesLoading) {
      setWorktreesLoading(true)
      void window.atelier
        .gitWorktrees(repoRoot, hostname, false)
        .then(setWorktrees)
        .finally(() => setWorktreesLoading(false))
    }
  }, [sub, worktrees, worktreesLoading, repoRoot, hostname])

  useEffect(() => {
    if (selectedFile) void loadFileHunks(selectedFile)
  }, [selectedFile, loadFileHunks])

  useEffect(() => {
    setChangesViewMode('hunks')
  }, [selectedFile])

  useEffect(() => {
    setCommitViewMode('hunks')
  }, [commitSelectedFile])

  useEffect(() => {
    if (!injectDiffFile || !injectDiffFileSeq) return
    loadedHunksRef.current.add(injectDiffFile.path)
    const prev = summaryRef.current
    const base: DiffSummary =
      prev?.isRepo === true
        ? prev
        : { isRepo: true, branch: prev?.branch ?? null, files: prev?.files ?? [] }
    const exists = base.files.some((f) => f.path === injectDiffFile.path)
    const files = exists
      ? base.files.map((f) => (f.path === injectDiffFile.path ? injectDiffFile : f))
      : [...base.files, injectDiffFile]
    const merged = { ...base, files }
    summaryRef.current = merged
    setSummary(merged)
  }, [injectDiffFile, injectDiffFileSeq])

  useEffect(() => {
    if (!revealChangePath || !revealChangeSeq) return
    setSub('changes')
    setSelectedFile(revealChangePath)
    const cached = summaryRef.current?.files.find((f) => f.path === revealChangePath)
    if (!cached?.hunks.length && !loadedHunksRef.current.has(revealChangePath)) {
      void loadFileHunks(revealChangePath)
    } else {
      loadedHunksRef.current.add(revealChangePath)
    }
    onRevealChangeHandled?.()
  }, [revealChangeSeq, revealChangePath, loadFileHunks, onRevealChangeHandled])

  useEffect(() => {
    if (!revealCommitHash || !revealCommitSeq) return
    setSub('commits')
    void (async () => {
      let list = commits
      if (!list?.length) {
        setCommitsLoading(true)
        try {
          list = await window.atelier.gitCommits(workspacePath, hostname, true)
          setCommits(list)
        } finally {
          setCommitsLoading(false)
        }
      }
      const hash = revealCommitHash
      const match =
        list?.find((c) => c.hash === hash) ??
        list?.find((c) => c.hash.startsWith(hash) || hash.startsWith(c.hash))
      if (match) await openCommit(match)
      onRevealCommitHandled?.()
    })()
  }, [revealCommitSeq, revealCommitHash, commits, workspacePath, hostname, openCommit, onRevealCommitHandled])

  useEffect(() => {
    if (selectedCommit && commitSelectedFile) void loadCommitFileHunks(selectedCommit.hash, commitSelectedFile)
  }, [selectedCommit, commitSelectedFile, loadCommitFileHunks])

  useEffect(() => {
    if (!selectedCommit || commitFiles == null) return
    persistCommitDetailCache(selectedCommit.hash, commitFiles, commitSelectedFile)
  }, [selectedCommit, commitFiles, commitSelectedFile, persistCommitDetailCache])

  const activeFile: DiffFileChange | undefined = summary?.files.find((f) => f.path === selectedFile)
  const commitActiveFile: DiffFileChange | undefined = commitFiles?.find((f) => f.path === commitSelectedFile)

  function showCommitList(): void {
    setSelectedCommit(null)
    setCommitFiles(null)
    setCommitSelectedFile(null)
    setCommentingLine(null)
  }

  function selectSub(next: DiffSubTab): void {
    if (next !== sub && next === 'commits') showCommitList()
    setSub(next)
  }

  async function refreshAfterGitMutation(): Promise<void> {
    loadedHunksRef.current.clear()
    commitDetailCacheRef.current.clear()
    setCommits(null)
    setWorktrees(null)
    showCommitList()
    await refreshChanges(true)
    if (sub === 'commits') {
      setCommitsLoading(true)
      void window.atelier
        .gitCommits(workspacePath, hostname, true)
        .then(setCommits)
        .finally(() => setCommitsLoading(false))
    }
    if (sub === 'worktrees') {
      setWorktreesLoading(true)
      void window.atelier
        .gitWorktrees(repoRoot, hostname, true)
        .then(setWorktrees)
        .finally(() => setWorktreesLoading(false))
    }
  }

  async function handleAddWorktree(): Promise<void> {
    setWorktreeError(null)
    const branch = newWorktreeBranch.trim()
    if (!branch) return
    const path = `${repoRoot}/.atelier/worktrees/${branch}`
    try {
      await window.atelier.gitWorktreeAdd(repoRoot, path, branch, hostname)
      setNewWorktreeBranch('')
      await refreshAfterGitMutation()
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleMergeWorktree(branch: string): Promise<void> {
    setWorktreeError(null)
    try {
      await window.atelier.gitWorktreeMerge(repoRoot, branch, hostname)
      await refreshAfterGitMutation()
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemoveWorktree(path: string): Promise<void> {
    setWorktreeError(null)
    try {
      await window.atelier.gitWorktreeRemove(repoRoot, path, hostname)
      await refreshAfterGitMutation()
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : String(err))
    }
  }

  function submitComment(file: string, lineKey: string, lineText: string): void {
    if (!commentText.trim()) return
    onAddComment(`Re ${file} (${lineKey}):\n> ${lineText.trim()}\n\n${commentText.trim()}`)
    setCommentText('')
    setCommentingLine(null)
  }

  function toggleCommentLine(lineKey: string): void {
    setCommentingLine((prev) => (prev === lineKey ? null : lineKey))
  }

  if (!summary) {
    return (
      <div className="empty-main" style={{ height: '100%' }}>
        <div className="empty-icon">🔀</div>
        <div>Loading diff…</div>
      </div>
    )
  }

  if (!summary.isRepo) {
    return (
      <div className="empty-main" style={{ height: '100%' }}>
        <div className="empty-icon icon-standalone">🔀</div>
        <div data-testid={active ? 'diff-empty-not-repo' : undefined}>Not a git repository — nothing to diff</div>
      </div>
    )
  }

  return (
    <div data-testid={active ? 'diff-panel-active' : undefined} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="diff-sub-tabs">
        <button className={sub === 'changes' ? 'active' : ''} onClick={() => selectSub('changes')} data-testid="diff-sub-changes">
          Changes
        </button>
        <button className={sub === 'commits' ? 'active' : ''} onClick={() => selectSub('commits')} data-testid="diff-sub-commits">
          Commits
        </button>
        <button className={sub === 'worktrees' ? 'active' : ''} onClick={() => selectSub('worktrees')} data-testid="diff-sub-worktrees">
          Worktrees
        </button>
      </div>

      {workspaceRefreshing && (
        <div className="diff-refreshing-banner" data-testid="diff-refreshing">
          Refreshing diff…
        </div>
      )}

      {sub === 'changes' &&
        (summary.files.length === 0 ? (
          <div className="empty-main" style={{ height: '100%' }}>
            <div className="empty-icon icon-standalone">🔀</div>
            <div>No uncommitted changes — see Files for the current state</div>
          </div>
        ) : (
          <div className="diff-sub-content" data-testid="diff-changes">
            <DiffReviewBody
              files={summary.files}
              selectedFile={selectedFile}
              onSelectFile={setSelectedFile}
              activeFile={activeFile}
              fileDiffLoading={fileDiffLoading}
              viewMode={changesViewMode}
              onToggleViewMode={() => setChangesViewMode((m) => (m === 'hunks' ? 'full' : 'hunks'))}
              workspacePath={workspacePath}
              hostname={hostname}
              effectiveTheme={effectiveTheme}
              panelScopeKey={panelScopeKey}
              panelActive={active}
              commentingLine={commentingLine}
              commentText={commentText}
              onToggleCommentLine={toggleCommentLine}
              onCommentTextChange={setCommentText}
              onSubmitComment={submitComment}
              onCancelComment={() => setCommentingLine(null)}
            />
          </div>
        ))}

      {sub === 'commits' && (
        <div className="diff-sub-content commits-panel" data-testid="diff-commits">
          {selectedCommit ? (
            <div className="commit-detail-view" data-testid="diff-commit-detail">
              <div className="commit-detail-bar">
                <button type="button" className="back" data-testid="diff-commit-back" onClick={showCommitList}>
                  ← All commits
                </button>
                <span className="commit-title">
                  <Linkify text={selectedCommit.message} />
                </span>
                <span className="commit-meta-inline">
                  {selectedCommit.hash.slice(0, 7)} · {selectedCommit.author} · {selectedCommit.date}
                </span>
                {commitFiles && commitFiles.length > 0 && (
                  <span className="commit-stat">
                    {commitFiles.length} file{commitFiles.length === 1 ? '' : 's'} ·{' '}
                    <span className="ft-add">+{commitFiles.reduce((n, f) => n + f.additions, 0)}</span>
                    <span className="ft-del">−{commitFiles.reduce((n, f) => n + f.deletions, 0)}</span>
                  </span>
                )}
              </div>
              {commitDiffLoading || commitFiles === null ? (
                <div className="empty-main" style={{ flex: 1 }}>
                  <div className="empty-icon icon-standalone">🔀</div>
                  <div>Loading commit diff…</div>
                </div>
              ) : commitFiles.length === 0 ? (
                <div className="empty-main" style={{ flex: 1 }}>
                  <div className="empty-icon icon-standalone">🔀</div>
                  <div>No file changes in this commit</div>
                </div>
              ) : (
                <DiffReviewBody
                  files={commitFiles}
                  selectedFile={commitSelectedFile}
                  onSelectFile={setCommitSelectedFile}
                  activeFile={commitActiveFile}
                  fileDiffLoading={commitFileDiffLoading}
                  viewMode={commitViewMode}
                  onToggleViewMode={() => setCommitViewMode((m) => (m === 'hunks' ? 'full' : 'hunks'))}
                  workspacePath={workspacePath}
                  hostname={hostname}
                  effectiveTheme={effectiveTheme}
                  panelScopeKey={panelScopeKey}
                  commitHash={selectedCommit.hash}
                  panelActive={active}
                  commentingLine={commentingLine}
                  commentText={commentText}
                  onToggleCommentLine={toggleCommentLine}
                  onCommentTextChange={setCommentText}
                  onSubmitComment={submitComment}
                  onCancelComment={() => setCommentingLine(null)}
                />
              )}
            </div>
          ) : commitsLoading || commits === null ? (
            <div className="empty-main" style={{ height: '100%' }}>
              <div className="empty-icon icon-standalone">🕒</div>
              <div>Loading commits…</div>
            </div>
          ) : commits.length === 0 ? (
            <div className="empty-main" style={{ height: '100%' }}>
              <div className="empty-icon icon-standalone">🕒</div>
              <div>No commits yet</div>
            </div>
          ) : (
            commits.map((c) => (
              <div
                className="commit-row"
                key={c.hash}
                data-testid="commit-row"
                onClick={() => void openCommit(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    void openCommit(c)
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="commit-msg">
                  <Linkify text={c.message} />
                </div>
                <div className="commit-meta">
                  {c.hash.slice(0, 7)} · {c.author} · {c.date}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {sub === 'worktrees' && (
        <div className="diff-sub-content" data-testid="diff-worktrees">
          <div className="worktree-list">
            {worktreeError && (
              <div style={{ color: 'var(--danger)', fontSize: 13.5 }} data-testid="worktree-error">
                {worktreeError}
              </div>
            )}
            {worktreesLoading || worktrees === null ? (
              <div style={{ padding: 12, opacity: 0.8 }}>Loading worktrees…</div>
            ) : (
              worktrees
                .filter((w) => !w.isMain)
                .map((w) => (
                  <div className="worktree-row" key={w.path} data-testid="worktree-row">
                    <div className="wpath">
                      {w.path} <span className="wbranch">{w.branch}</span>
                    </div>
                    <button className="btn btn-sm" data-testid="worktree-merge" onClick={() => void handleMergeWorktree(w.branch)}>
                      Merge
                    </button>
                    <button className="btn btn-sm btn-danger" data-testid="worktree-remove" onClick={() => void handleRemoveWorktree(w.path)}>
                      Remove
                    </button>
                  </div>
                ))
            )}
            <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-start' }}>
              <input
                className="input"
                placeholder="new branch name"
                value={newWorktreeBranch}
                onChange={(e) => setNewWorktreeBranch(e.target.value)}
                data-testid="worktree-branch-input"
                style={{
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--r-sm)',
                  color: 'var(--text-primary)',
                  padding: '6px 9px'
                }}
              />
              <button className="btn btn-sm" data-testid="worktree-add" onClick={() => void handleAddWorktree()}>
                + New worktree
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export { openExternalLink }
