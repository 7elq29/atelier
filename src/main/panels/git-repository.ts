/**
 * Session-scoped git state for the Diff panel (VS Code SCM model): one batched
 * status fetch per refresh, cached snapshots, lazy per-file hunks, lazy
 * commits/worktrees. Remote devpod sessions use multiplexed SSH via ssh-exec.ts.
 */
import type { CommitInfo, DiffFileChange, DiffFileContentPair, DiffFileStatus, DiffSummary, WorktreeInfo } from '../../shared/panel-types'
import { readFileForPreview } from './files'
import { join } from 'node:path'
import { warmSshMux } from '../ssh-exec'
import {
  clearGitRepoRootCache,
  gitPatchOutputUsable,
  numstatPathForGit,
  parseNumstatLines,
  parseUnifiedDiff,
  pickParsedDiffFile,
  resolveGitRepoRoot,
  runGit,
  runGitAtRepoRoot,
  runGitDiffPatch,
  runGitShowPatch
} from './git-core'

const EMPTY_TREE = '4b825dc642cb6eb6a060e54bf8d69288fbee4904'

function repoKey(projectPath: string, sshHost?: string | null): string {
  return `${sshHost ?? 'local'}\0${projectPath}`
}

/** Working tree vs HEAD at the git toplevel (not scoped to session projectPath). */
async function fetchWorkingTreeChanges(
  projectPath: string,
  sshHost?: string | null
): Promise<{ isRepo: boolean; branch: string | null; hasHead: boolean; files: DiffFileChange[] }> {
  const inside = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], sshHost)
  if (inside.stdout.trim() !== 'true') {
    return { isRepo: false, branch: null, hasHead: false, files: [] }
  }

  const branchRes = await runGitAtRepoRoot(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], sshHost)
  const branchRaw = branchRes.stdout.trim()
  const branch = branchRaw === 'HEAD' || !branchRaw ? null : branchRaw

  const hasHead = (await runGitAtRepoRoot(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
  const diffTarget = hasHead ? 'HEAD' : EMPTY_TREE
  const numstat = await runGitAtRepoRoot(projectPath, ['diff', '--no-color', '--numstat', diffTarget], sshHost)

  const files = parseNumstatLines(numstat.stdout.split('\n'))
  const seen = new Set(files.map((f) => f.path))

  const untracked = await runGitAtRepoRoot(
    projectPath,
    ['ls-files', '--others', '--exclude-standard'],
    sshHost
  )
  for (const line of untracked.stdout.split('\n')) {
    const path = line.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    files.push({ path, status: 'added', additions: 0, deletions: 0, hunks: [] })
  }

  return { isRepo: true, branch, hasHead, files }
}

interface RepoCache {
  summary: DiffSummary
  hasHead: boolean
  commits: CommitInfo[] | null
  worktrees: WorktreeInfo[] | null
  fetchedAt: number
}

class GitRepositoryManager {
  private readonly cache = new Map<string, RepoCache>()
  private readonly inFlight = new Map<string, Promise<DiffSummary>>()

  invalidate(projectPath: string, sshHost?: string | null): void {
    clearGitRepoRootCache(projectPath, sshHost)
    this.cache.delete(repoKey(projectPath, sshHost))
  }

  async warmRemote(sshHost: string): Promise<void> {
    await warmSshMux(sshHost)
  }

  async refreshChanges(projectPath: string, sshHost?: string | null, force = false): Promise<DiffSummary> {
    const key = repoKey(projectPath, sshHost)
    const cached = this.cache.get(key)
    if (!force && cached && Date.now() - cached.fetchedAt < 2500) {
      return cached.summary
    }
    const pending = this.inFlight.get(key)
    if (pending) return pending

    const work = (async (): Promise<DiffSummary> => {
      const parsed = await fetchWorkingTreeChanges(projectPath, sshHost)
      if (!parsed.isRepo) {
        const summary: DiffSummary = { isRepo: false, branch: null, files: [] }
        this.cache.set(key, { summary, hasHead: false, commits: null, worktrees: null, fetchedAt: Date.now() })
        return summary
      }
      const summary: DiffSummary = {
        isRepo: true,
        branch: parsed.branch,
        files: parsed.files.map((f) => ({ ...f, hunks: [] }))
      }
      this.cache.set(key, {
        summary,
        hasHead: parsed.hasHead,
        commits: cached?.commits ?? null,
        worktrees: cached?.worktrees ?? null,
        fetchedAt: Date.now()
      })
      return summary
    })()

    this.inFlight.set(key, work)
    try {
      return await work
    } finally {
      this.inFlight.delete(key)
    }
  }

  /** File list for a single commit (numstat; empty hunks until loadCommitFileDiff). */
  async loadCommitDiff(projectPath: string, commit: string, sshHost?: string | null): Promise<DiffSummary> {
    const summary = await this.refreshChanges(projectPath, sshHost)
    if (!summary.isRepo) return { isRepo: false, branch: null, files: [] }

    // -m --first-parent: merge commits and root commits get a real patch (plain `git show` is often empty).
    const res = await runGitAtRepoRoot(
      projectPath,
      ['show', '-m', '--first-parent', '--no-color', '--numstat', '--format=', commit],
      sshHost
    )
    if (res.code !== 0) return { isRepo: true, branch: null, files: [] }
    const files = parseNumstatLines(res.stdout.split('\n')).map((f) => ({ ...f, hunks: [] }))
    return { isRepo: true, branch: null, files }
  }

  private mergeCommitFileStub(stub: DiffFileChange, parsed: DiffFileChange): DiffFileChange {
    return {
      ...stub,
      ...parsed,
      path: stub.path,
      status: stub.status,
      additions: stub.additions || parsed.additions,
      deletions: stub.deletions || parsed.deletions,
      hunks: parsed.hunks
    }
  }

  private async commitDiffParentBase(
    projectPath: string,
    commit: string,
    sshHost?: string | null
  ): Promise<string> {
    const parentRev = await runGit(projectPath, ['rev-parse', `${commit}^`], sshHost)
    return parentRev.code === 0 && parentRev.stdout.trim() ? `${commit}^` : EMPTY_TREE
  }

  async loadCommitFileDiff(
    projectPath: string,
    commit: string,
    filePath: string,
    sshHost?: string | null
  ): Promise<DiffFileChange | null> {
    const list = await this.loadCommitDiff(projectPath, commit, sshHost)
    const stub = list.files.find((f) => f.path === filePath)
    const gitPath = numstatPathForGit(filePath)

    const parseForFile = (stdout: string): DiffFileChange | undefined => {
      const parsed = parseUnifiedDiff(stdout)
      return pickParsedDiffFile(parsed, filePath, gitPath)
    }

    let parsed: DiffFileChange | undefined

    const parentRev = await runGit(projectPath, ['rev-parse', `${commit}^`], sshHost)
    if (parentRev.code === 0 && parentRev.stdout.trim()) {
      const blobDiff = await runGitDiffPatch(
        projectPath,
        ['--no-color', '-U3', `${commit}^:${gitPath}`, `${commit}:${gitPath}`],
        sshHost
      )
      if (gitPatchOutputUsable(blobDiff.code, blobDiff.stdout)) {
        parsed = parseForFile(blobDiff.stdout)
      }
    }

    const base = await this.commitDiffParentBase(projectPath, commit, sshHost)
    if (!parsed?.hunks.length) {
      const diffRes = await runGitDiffPatch(
        projectPath,
        ['--no-color', '-U3', base, commit, '--', gitPath],
        sshHost
      )
      if (gitPatchOutputUsable(diffRes.code, diffRes.stdout)) {
        parsed = parseForFile(diffRes.stdout) ?? parsed
      }
    }

    if (!parsed?.hunks.length) {
      const show = await runGitShowPatch(
        projectPath,
        ['-m', '--first-parent', '--no-color', '-U3', '--format=', commit, '--', gitPath],
        sshHost
      )
      if (gitPatchOutputUsable(show.code, show.stdout)) {
        parsed = parseForFile(show.stdout) ?? parsed
      }
    }

    if (!parsed?.hunks.length) {
      const showPlain = await runGitShowPatch(
        projectPath,
        ['--no-color', '-U3', '--format=', commit, '--', gitPath],
        sshHost
      )
      if (gitPatchOutputUsable(showPlain.code, showPlain.stdout)) {
        parsed = parseForFile(showPlain.stdout) ?? parsed
      }
    }

    if (parsed?.hunks.length) {
      return stub ? this.mergeCommitFileStub(stub, parsed) : parsed
    }
    return stub ? { ...stub, hunks: [] } : null
  }

  async loadFileDiff(projectPath: string, filePath: string, sshHost?: string | null): Promise<DiffFileChange | null> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    const hasHead = entry?.hasHead ?? (await runGitAtRepoRoot(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
    const target = hasHead ? 'HEAD' : EMPTY_TREE

    const tracked = await runGitAtRepoRoot(projectPath, ['ls-files', '--error-unmatch', '--', filePath], sshHost)
    let diff = await runGitDiffPatch(projectPath, ['--no-color', '-U3', target, '--', filePath], sshHost)
    if (!gitPatchOutputUsable(diff.code, diff.stdout) && tracked.code !== 0) {
      diff = await runGitDiffPatch(projectPath, ['--no-color', '-U3', '--no-index', '/dev/null', filePath], sshHost)
    }
    if (!gitPatchOutputUsable(diff.code, diff.stdout)) {
      const stub = entry?.summary.files.find((f) => f.path === filePath)
      return stub ? { ...stub, hunks: [] } : null
    }
    const parsed = parseUnifiedDiff(diff.stdout)
    const file = parsed[0]
    if (!file) {
      const stub = entry?.summary.files.find((f) => f.path === filePath)
      return stub ? { ...stub, hunks: [] } : null
    }
    if (entry) {
      entry.summary = {
        ...entry.summary,
        files: entry.summary.files.map((f) => (f.path === filePath ? { ...file, hunks: file.hunks } : f))
      }
    }
    return file
  }

  async listCommits(projectPath: string, limit: number, sshHost?: string | null, force = false): Promise<CommitInfo[]> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    if (!force && entry?.commits) return entry.commits

    const summary = entry?.summary ?? (await this.refreshChanges(projectPath, sshHost))
    if (!summary.isRepo) return []
    const head = entry?.hasHead ?? (await runGit(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
    if (!head) return []

    const res = await runGit(
      projectPath,
      ['log', `-n${limit}`, '--date=relative', '--pretty=format:%H%x1f%an%x1f%ad%x1f%s'],
      sshHost
    )
    if (res.code !== 0 || !res.stdout.trim()) return []
    const commits = res.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [hash, author, date, message] = line.split('\x1f')
        return { hash, author, date, message }
      })
    if (entry) entry.commits = commits
    return commits
  }

  async listWorktrees(projectPath: string, sshHost?: string | null, force = false): Promise<WorktreeInfo[]> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    if (!force && entry?.worktrees) return entry.worktrees

    const summary = entry?.summary ?? (await this.refreshChanges(projectPath, sshHost))
    if (!summary.isRepo) return []

    const res = await runGit(projectPath, ['worktree', 'list', '--porcelain'], sshHost)
    if (res.code !== 0) return []
    const worktrees: WorktreeInfo[] = []
    let current: Partial<WorktreeInfo> | null = null
    for (const line of res.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current?.path) worktrees.push(current as WorktreeInfo)
        current = { path: line.slice('worktree '.length), branch: '', head: '', isMain: worktrees.length === 0 && !current }
      } else if (line.startsWith('HEAD ')) {
        if (current) current.head = line.slice('HEAD '.length)
      } else if (line.startsWith('branch ')) {
        if (current) current.branch = line.slice('branch '.length).replace('refs/heads/', '')
      }
    }
    if (current?.path) worktrees.push(current as WorktreeInfo)
    const list = worktrees.map((w, idx) => ({ ...w, isMain: idx === 0 }))
    if (entry) entry.worktrees = list
    return list
  }

  onMutatingGitOp(projectPath: string, sshHost?: string | null): void {
    this.invalidate(projectPath, sshHost)
  }

  private async repoHasHead(projectPath: string, sshHost?: string | null): Promise<boolean> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    if (entry != null) return entry.hasHead
    return (await runGit(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
  }

  /** Working tree vs HEAD (or empty tree) — for Diff › Expand file. */
  async loadWorkingTreeFilePair(
    projectPath: string,
    filePath: string,
    status: DiffFileStatus,
    sshHost?: string | null
  ): Promise<DiffFileContentPair | null> {
    let original = ''
    if (status !== 'added') {
      const hasHead = await this.repoHasHead(projectPath, sshHost)
      const ref = hasHead ? 'HEAD' : EMPTY_TREE
      const res = await runGit(projectPath, ['show', `${ref}:${filePath}`], sshHost)
      if (res.code === 0) original = res.stdout
    }

    let modified = ''
    if (status !== 'deleted') {
      const root = await resolveGitRepoRoot(projectPath, sshHost)
      const abs = join(root, filePath)
      const read = await readFileForPreview(abs, sshHost)
      if (read.kind !== 'text' && read.kind !== 'html') return null
      modified = read.content
    }

    return { original, modified }
  }

  /** Parent commit vs commit — for Diff › Commits › Expand file. */
  async loadCommitFilePair(
    projectPath: string,
    commit: string,
    filePath: string,
    status: DiffFileStatus,
    sshHost?: string | null
  ): Promise<DiffFileContentPair | null> {
    const gitPath = numstatPathForGit(filePath)
    let original = ''
    const parent = await runGit(projectPath, ['show', `${commit}^:${gitPath}`], sshHost)
    if (parent.code === 0) original = parent.stdout

    let modified = ''
    if (status !== 'deleted') {
      const atCommit = await runGit(projectPath, ['show', `${commit}:${gitPath}`], sshHost)
      if (atCommit.code === 0) modified = atCommit.stdout
      else return null
    }

    if (status === 'added' && !modified) return null
    if (original.includes('\0') || modified.includes('\0')) return null
    return { original, modified }
  }
}

export const gitRepositories = new GitRepositoryManager()

/** Back-compat: changes snapshot (file list, empty hunks until gitFileDiff). */
export async function getDiffSummary(projectPath: string, sshHost?: string | null, force = false): Promise<DiffSummary> {
  return gitRepositories.refreshChanges(projectPath, sshHost, force)
}

export async function getFileDiff(projectPath: string, filePath: string, sshHost?: string | null): Promise<DiffFileChange | null> {
  return gitRepositories.loadFileDiff(projectPath, filePath, sshHost)
}

export async function getCommitDiff(projectPath: string, commit: string, sshHost?: string | null): Promise<DiffSummary> {
  return gitRepositories.loadCommitDiff(projectPath, commit, sshHost)
}

export async function getCommitFileDiff(
  projectPath: string,
  commit: string,
  filePath: string,
  sshHost?: string | null
): Promise<DiffFileChange | null> {
  return gitRepositories.loadCommitFileDiff(projectPath, commit, filePath, sshHost)
}

export async function getWorkingTreeFilePair(
  projectPath: string,
  filePath: string,
  status: DiffFileStatus,
  sshHost?: string | null
): Promise<DiffFileContentPair | null> {
  return gitRepositories.loadWorkingTreeFilePair(projectPath, filePath, status, sshHost)
}

export async function getCommitFilePair(
  projectPath: string,
  commit: string,
  filePath: string,
  status: DiffFileStatus,
  sshHost?: string | null
): Promise<DiffFileContentPair | null> {
  return gitRepositories.loadCommitFilePair(projectPath, commit, filePath, status, sshHost)
}

export async function listCommits(
  projectPath: string,
  limit = 50,
  sshHost?: string | null,
  force = false
): Promise<CommitInfo[]> {
  return gitRepositories.listCommits(projectPath, limit, sshHost, force)
}

export async function listWorktrees(projectPath: string, sshHost?: string | null, force = false): Promise<WorktreeInfo[]> {
  return gitRepositories.listWorktrees(projectPath, sshHost, force)
}

export async function addWorktree(projectPath: string, worktreePath: string, branch: string, sshHost?: string | null): Promise<void> {
  const res = await runGit(projectPath, ['worktree', 'add', '-b', branch, worktreePath], sshHost)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git worktree add failed')
  gitRepositories.onMutatingGitOp(projectPath, sshHost)
}

export async function removeWorktree(projectPath: string, worktreePath: string, sshHost?: string | null): Promise<void> {
  const res = await runGit(projectPath, ['worktree', 'remove', worktreePath, '--force'], sshHost)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git worktree remove failed')
  gitRepositories.onMutatingGitOp(projectPath, sshHost)
}

export async function mergeWorktreeBranch(projectPath: string, branch: string, sshHost?: string | null): Promise<void> {
  const res = await runGit(projectPath, ['merge', '--no-edit', branch], sshHost)
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git merge failed')
  gitRepositories.onMutatingGitOp(projectPath, sshHost)
}

export function invalidateGitRepository(projectPath: string, sshHost?: string | null): void {
  gitRepositories.invalidate(projectPath, sshHost)
}

export async function warmRemoteGitHost(sshHost: string): Promise<void> {
  await gitRepositories.warmRemote(sshHost)
}

/** Current branch for composer context bar (null if not a repo or detached). */
export async function getGitBranch(projectPath: string, sshHost?: string | null): Promise<string | null> {
  const inside = await runGit(projectPath, ['rev-parse', '--is-inside-work-tree'], sshHost)
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null
  const res = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD'], sshHost)
  if (res.code !== 0) return null
  const name = res.stdout.trim()
  return name === 'HEAD' ? null : name
}
