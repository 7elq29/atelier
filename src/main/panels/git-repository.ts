/**
 * Session-scoped git state for the Diff panel (VS Code SCM model): one batched
 * status fetch per refresh, cached snapshots, lazy per-file hunks, lazy
 * commits/worktrees. Remote devpod sessions use multiplexed SSH via ssh-exec.ts.
 */
import { execFile } from 'node:child_process'
import type { CommitInfo, DiffFileChange, DiffFileStatus, DiffSummary, WorktreeInfo } from '../../shared/panel-types'
import { remoteCdTarget, shQuote } from '../shell-quote'
import { sshExec, warmSshMux } from '../ssh-exec'
import { parseNumstatLines, parseUnifiedDiff, runGit } from './git-core'

const EMPTY_TREE = '4b825dc642cb6eb6a060e54bf8d69288fbee4904'

const STATUS_SCRIPT = `
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo ATELIER_NOT_REPO
  exit 0
fi
branch=$(git rev-parse --abbrev-ref HEAD)
echo "ATELIER_BRANCH=$branch"
if git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo ATELIER_HAS_HEAD=1
  git diff --no-color --numstat HEAD
else
  echo ATELIER_HAS_HEAD=0
  git diff --no-color --numstat ${EMPTY_TREE}
fi
`.trim()

function repoKey(projectPath: string, sshHost?: string | null): string {
  return `${sshHost ?? 'local'}\0${projectPath}`
}

async function execStatusScript(projectPath: string, sshHost?: string | null): Promise<ExecResult> {
  if (sshHost) {
    await warmSshMux(sshHost)
    const cmd = `cd ${remoteCdTarget(projectPath)} && ${STATUS_SCRIPT}`
    return sshExec(sshHost, cmd)
  }
  return new Promise((resolve) => {
    execFile('sh', ['-c', `cd ${shQuote(projectPath)} && ${STATUS_SCRIPT}`], { maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException & { code?: number })?.code
      resolve({ stdout, stderr, code: typeof code === 'number' ? code : err ? 1 : 0 })
    })
  })
}

type ExecResult = { stdout: string; stderr: string; code: number }

function parseStatusOutput(raw: string): { isRepo: boolean; branch: string | null; hasHead: boolean; files: DiffFileChange[] } {
  const lines = raw.split('\n')
  if (lines[0]?.trim() === 'ATELIER_NOT_REPO') {
    return { isRepo: false, branch: null, hasHead: false, files: [] }
  }
  let branch: string | null = null
  let hasHead = false
  const numstatLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('ATELIER_BRANCH=')) {
      const name = line.slice('ATELIER_BRANCH='.length).trim()
      branch = name === 'HEAD' ? null : name
    }     else if (line.startsWith('ATELIER_HAS_HEAD=1')) hasHead = true
    else if (line.startsWith('ATELIER_HAS_HEAD=0')) hasHead = false
    else if (line.trim() && !line.startsWith('ATELIER_')) numstatLines.push(line)
  }
  const files = parseNumstatLines(numstatLines)
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
      const res = await execStatusScript(projectPath, sshHost)
      const parsed = parseStatusOutput(res.stdout)
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

  async loadFileDiff(projectPath: string, filePath: string, sshHost?: string | null): Promise<DiffFileChange | null> {
    const key = repoKey(projectPath, sshHost)
    const entry = this.cache.get(key)
    const hasHead = entry?.hasHead ?? (await runGit(projectPath, ['rev-parse', '--verify', 'HEAD'], sshHost)).code === 0
    const target = hasHead ? 'HEAD' : EMPTY_TREE
    const diff = await runGit(projectPath, ['diff', '--no-color', '-U3', target, '--', filePath], sshHost)
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
}

export const gitRepositories = new GitRepositoryManager()

/** Back-compat: changes snapshot (file list, empty hunks until gitFileDiff). */
export async function getDiffSummary(projectPath: string, sshHost?: string | null, force = false): Promise<DiffSummary> {
  return gitRepositories.refreshChanges(projectPath, sshHost, force)
}

export async function getFileDiff(projectPath: string, filePath: string, sshHost?: string | null): Promise<DiffFileChange | null> {
  return gitRepositories.loadFileDiff(projectPath, filePath, sshHost)
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
