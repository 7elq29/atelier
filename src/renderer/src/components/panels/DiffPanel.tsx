import { useEffect, useState } from 'react'
import type { CommitInfo, DiffFileChange, DiffSummary, WorktreeInfo } from '../../../../shared/panel-types'
import Linkify, { openExternalLink } from './Linkify'

type DiffSubTab = 'changes' | 'commits' | 'worktrees'

/**
 * Diff/Review panel (07-secondary-panels §2): real `git diff`/`git log`/
 * `git worktree` state for the session's actual `project_path`, matching the
 * mock's `.diff-sub-tabs` (Changes/Commits/Worktrees) structure. Commenting
 * on a diff line is the simplest real version of "push into the session's
 * prompt": it appends a formatted note to the composer text via
 * `onAddComment`, which the user then sends like any other message.
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
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [commentingLine, setCommentingLine] = useState<string | null>(null)
  const [commentText, setCommentText] = useState('')
  const [newWorktreeBranch, setNewWorktreeBranch] = useState('')
  const [worktreeError, setWorktreeError] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    const [diff, log, wts] = await Promise.all([
      window.atelier.gitDiff(projectPath, hostname),
      window.atelier.gitCommits(projectPath, hostname),
      window.atelier.gitWorktrees(projectPath, hostname)
    ])
    setSummary(diff)
    setCommits(log)
    setWorktrees(wts)
    if (!selectedFile && diff.files.length > 0) setSelectedFile(diff.files[0].path)
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, hostname])

  const activeFile: DiffFileChange | undefined = summary?.files.find((f) => f.path === selectedFile)

  async function handleAddWorktree(): Promise<void> {
    setWorktreeError(null)
    const branch = newWorktreeBranch.trim()
    if (!branch) return
    const path = `${projectPath}/.atelier/worktrees/${branch}`
    try {
      await window.atelier.gitWorktreeAdd(projectPath, path, branch, hostname)
      setNewWorktreeBranch('')
      await refresh()
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleMergeWorktree(branch: string): Promise<void> {
    setWorktreeError(null)
    try {
      await window.atelier.gitWorktreeMerge(projectPath, branch, hostname)
      await refresh()
    } catch (err) {
      setWorktreeError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleRemoveWorktree(path: string): Promise<void> {
    setWorktreeError(null)
    try {
      await window.atelier.gitWorktreeRemove(projectPath, path, hostname)
      await refresh()
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
          {commits.length === 0 ? (
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
            {worktrees
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
              ))}
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

// re-export so callers that only need the external-link opener don't have to
// reach into Linkify.tsx directly.
export { openExternalLink }
