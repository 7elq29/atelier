import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommitInfo, DiffFileChange, DiffSummary, WorktreeInfo } from '../../../../shared/panel-types'
import Linkify, { openExternalLink } from './Linkify'

type DiffSubTab = 'changes' | 'commits' | 'worktrees'

const POLL_MS = 3000

/**
 * Diff/Review panel (07-secondary-panels §2): SCM-first changes list with
 * lazy per-file hunks, lazy commits/worktrees sub-tabs, and background refresh
 * while mounted (VS Code–style remote git economics via session-scoped cache in main).
 */
export default function DiffPanel({
  projectPath,
  hostname,
  onAddComment
}: {
  projectPath: string
  hostname?: string | null
  onAddComment: (note: string) => void
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
  const loadedHunksRef = useRef<Set<string>>(new Set())

  const mergeFileIntoSummary = useCallback((file: DiffFileChange) => {
    setSummary((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        files: prev.files.map((f) => (f.path === file.path ? file : f))
      }
    })
  }, [])

  const loadFileHunks = useCallback(
    async (filePath: string, force = false): Promise<void> => {
      if (!force && loadedHunksRef.current.has(filePath)) return
      setFileDiffLoading(true)
      try {
        const file = await window.atelier.gitFileDiff(projectPath, filePath, hostname)
        if (file) {
          loadedHunksRef.current.add(filePath)
          mergeFileIntoSummary(file)
        }
      } finally {
        setFileDiffLoading(false)
      }
    },
    [projectPath, hostname, mergeFileIntoSummary]
  )

  const refreshChanges = useCallback(
    async (force = false): Promise<void> => {
      const diff = await window.atelier.gitDiff(projectPath, hostname, force)
      setSummary((prev) => {
        if (!prev?.isRepo) return diff
        return {
          ...diff,
          files: diff.files.map((f) => {
            const old = prev.files.find((o) => o.path === f.path)
            if (old && old.hunks.length > 0 && loadedHunksRef.current.has(f.path)) {
              return { ...f, hunks: old.hunks }
            }
            return f
          })
        }
      })
      if (diff.files.length === 0) {
        setSelectedFile(null)
        loadedHunksRef.current.clear()
        return
      }
      setSelectedFile((prev) => {
        const next = prev && diff.files.some((f) => f.path === prev) ? prev : diff.files[0].path
        if (next && !loadedHunksRef.current.has(next)) {
          void loadFileHunks(next)
        }
        return next
      })
    },
    [projectPath, hostname, loadFileHunks]
  )

  useEffect(() => {
    loadedHunksRef.current.clear()
    setSummary(null)
    setCommits(null)
    setWorktrees(null)
    void refreshChanges(true)
  }, [projectPath, hostname, refreshChanges])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshChanges(false)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshChanges])

  useEffect(() => {
    if (sub === 'commits' && commits === null && !commitsLoading) {
      setCommitsLoading(true)
      void window.atelier
        .gitCommits(projectPath, hostname, true)
        .then(setCommits)
        .finally(() => setCommitsLoading(false))
    }
  }, [sub, commits, commitsLoading, projectPath, hostname])

  useEffect(() => {
    if (sub === 'worktrees' && worktrees === null && !worktreesLoading) {
      setWorktreesLoading(true)
      void window.atelier
        .gitWorktrees(projectPath, hostname, true)
        .then(setWorktrees)
        .finally(() => setWorktreesLoading(false))
    }
  }, [sub, worktrees, worktreesLoading, projectPath, hostname])

  useEffect(() => {
    if (selectedFile) void loadFileHunks(selectedFile)
  }, [selectedFile, loadFileHunks])

  const activeFile: DiffFileChange | undefined = summary?.files.find((f) => f.path === selectedFile)

  async function refreshAfterGitMutation(): Promise<void> {
    loadedHunksRef.current.clear()
    setCommits(null)
    setWorktrees(null)
    await refreshChanges(true)
    if (sub === 'commits') {
      setCommitsLoading(true)
      void window.atelier
        .gitCommits(projectPath, hostname, true)
        .then(setCommits)
        .finally(() => setCommitsLoading(false))
    }
    if (sub === 'worktrees') {
      setWorktreesLoading(true)
      void window.atelier
        .gitWorktrees(projectPath, hostname, true)
        .then(setWorktrees)
        .finally(() => setWorktreesLoading(false))
    }
  }

  async function handleAddWorktree(): Promise<void> {
    setWorktreeError(null)
    const branch = newWorktreeBranch.trim()
    if (!branch) return
    const path = `${projectPath}/.atelier/worktrees/${branch}`
    try {
      await window.atelier.gitWorktreeAdd(projectPath, path, branch, hostname)
      setNewWorktreeBranch('')
      await refreshAfterGitMutation()
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleMergeWorktree(branch: string): Promise<void> {
    setWorktreeError(null)
    try {
      await window.atelier.gitWorktreeMerge(projectPath, branch, hostname)
      await refreshAfterGitMutation()
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemoveWorktree(path: string): Promise<void> {
    setWorktreeError(null)
    try {
      await window.atelier.gitWorktreeRemove(projectPath, path, hostname)
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
        <div data-testid="diff-empty-not-repo">Not a git repository — nothing to diff</div>
      </div>
    )
  }

  return (
    <div data-testid="diff-panel" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="diff-sub-tabs">
        <button className={sub === 'changes' ? 'active' : ''} onClick={() => setSub('changes')} data-testid="diff-sub-changes">
          Changes
        </button>
        <button className={sub === 'commits' ? 'active' : ''} onClick={() => setSub('commits')} data-testid="diff-sub-commits">
          Commits
        </button>
        <button className={sub === 'worktrees' ? 'active' : ''} onClick={() => setSub('worktrees')} data-testid="diff-sub-worktrees">
          Worktrees
        </button>
      </div>

      {sub === 'changes' &&
        (summary.files.length === 0 ? (
          <div className="empty-main" style={{ height: '100%' }}>
            <div className="empty-icon icon-standalone">🔀</div>
            <div>No uncommitted changes — see Files for the current state</div>
          </div>
        ) : (
          <div className="diff-sub-content" data-testid="diff-changes">
            <div className="review-body">
              <div className="file-tree">
                <div className="ft-summary" data-testid="diff-file-summary">
                  {summary.files.length} file{summary.files.length === 1 ? '' : 's'} changed ·{' '}
                  <span className="ft-add">+{summary.files.reduce((n, f) => n + f.additions, 0)}</span>
                  <span className="ft-del">−{summary.files.reduce((n, f) => n + f.deletions, 0)}</span>
                </div>
                {summary.files.map((f) => (
                  <div
                    key={f.path}
                    className={`ft-item${selectedFile === f.path ? ' active' : ''}`}
                    onClick={() => setSelectedFile(f.path)}
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
              <div className="diff-area">
                {activeFile && (
                  <div className="diff-file-card" data-testid="diff-file-card">
                    <div className="diff-file-header">
                      {activeFile.path} <span className="badge-mod">{activeFile.status}</span>
                      {fileDiffLoading && activeFile.hunks.length === 0 && (
                        <span style={{ marginLeft: 8, opacity: 0.7 }}>Loading…</span>
                      )}
                    </div>
                    <div className="diff-lines">
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
                                    onClick={() => setCommentingLine(commentingLine === lineKey ? null : lineKey)}
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
                                    onChange={(e) => setCommentText(e.target.value)}
                                    data-testid="diff-comment-input"
                                  />
                                  <div className="inline-comment-actions">
                                    <button
                                      className="btn btn-primary btn-sm"
                                      data-testid="diff-comment-submit"
                                      onClick={() => submitComment(activeFile.path, lineKey, line.content)}
                                    >
                                      Add to next message
                                    </button>
                                    <button className="btn btn-sm" onClick={() => setCommentingLine(null)}>
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
                )}
              </div>
            </div>
          </div>
        ))}

      {sub === 'commits' && (
        <div className="diff-sub-content" data-testid="diff-commits">
          {commitsLoading || commits === null ? (
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
              <div className="commit-row" key={c.hash} data-testid="commit-row">
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
