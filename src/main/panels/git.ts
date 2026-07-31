/**
 * Real git operations backing the Diff/Review panel + Git-worktree UI
 * (07-secondary-panels §2 and §4) — everything here shells out to the real
 * `git` binary via `child_process.execFile` against the session's actual
 * `project_path`, no mocked data.
 */
import { execFile } from 'node:child_process'
import type { CommitInfo, DiffFileChange, DiffFileStatus, DiffHunk, DiffLine, DiffSummary, WorktreeInfo } from '../../shared/panel-types'

function run(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException & { code?: number })?.code
      resolve({ stdout, stderr, code: typeof code === 'number' ? code : err ? 1 : 0 })
    })
  })
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const res = await run(cwd, ['rev-parse', '--is-inside-work-tree'])
  return res.code === 0 && res.stdout.trim() === 'true'
}

async function currentBranch(cwd: string): Promise<string | null> {
  const res = await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (res.code !== 0) return null
  const name = res.stdout.trim()
  return name === 'HEAD' ? null : name
}

async function hasHead(cwd: string): Promise<boolean> {
  const res = await run(cwd, ['rev-parse', '--verify', 'HEAD'])
  return res.code === 0
}

/** Parses a unified `git diff` patch into per-file hunk structures for rendering. */
function parseUnifiedDiff(patch: string): DiffFileChange[] {
  const files: DiffFileChange[] = []
  const lines = patch.split('\n')
  let i = 0

  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git')) {
      i++
      continue
    }
    const diffLine = lines[i]
    i++
    let oldPath = ''
    let newPath = ''
    let status: DiffFileStatus = 'modified'
    // Consume the extended header lines until we hit the hunk markers or the next file.
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
      const line = lines[i]
      if (line.startsWith('--- ')) oldPath = line.slice(4).replace(/^a\//, '')
      else if (line.startsWith('+++ ')) newPath = line.slice(4).replace(/^b\//, '')
      else if (line.startsWith('new file mode')) status = 'added'
      else if (line.startsWith('deleted file mode')) status = 'deleted'
      else if (line.startsWith('rename to ')) {
        status = 'renamed'
        newPath = line.slice('rename to '.length)
      } else if (line.startsWith('rename from ')) {
        oldPath = line.slice('rename from '.length)
      }
      i++
    }
    const path = newPath === '/dev/null' ? oldPath : newPath || oldPath
    if (status === 'modified' && oldPath && newPath && oldPath !== newPath) status = 'renamed'
    if (newPath === '/dev/null') status = 'deleted'
    if (oldPath === '/dev/null') status = 'added'

    const hunks: DiffHunk[] = []
    let additions = 0
    let deletions = 0

    while (i < lines.length && lines[i].startsWith('@@')) {
      const header = lines[i]
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header)
      let oldLine = match ? parseInt(match[1], 10) : 0
      let newLine = match ? parseInt(match[2], 10) : 0
      i++
      const hunkLines: DiffLine[] = []
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
        const raw = lines[i]
        if (raw.startsWith('\\ No newline')) {
          i++
          continue
        }
        if (raw.startsWith('+')) {
          hunkLines.push({ kind: 'add', oldLine: null, newLine, content: raw.slice(1) })
          newLine++
          additions++
        } else if (raw.startsWith('-')) {
          hunkLines.push({ kind: 'del', oldLine, newLine: null, content: raw.slice(1) })
          oldLine++
          deletions++
        } else {
          hunkLines.push({ kind: 'context', oldLine, newLine, content: raw.slice(1) })
          oldLine++
          newLine++
        }
        i++
      }
      hunks.push({ header, lines: hunkLines })
    }

    files.push({ path, oldPath: oldPath !== path ? oldPath : undefined, status, additions, deletions, hunks })
  }

  return files
}

/** Real uncommitted-changes diff (working tree + index vs HEAD) for the session's project folder. */
export async function getDiffSummary(projectPath: string): Promise<DiffSummary> {
  if (!(await isGitRepo(projectPath))) {
    return { isRepo: false, branch: null, files: [] }
  }
  const branch = await currentBranch(projectPath)
  const head = await hasHead(projectPath)
  // Diff against HEAD when it exists (covers staged + unstaged); otherwise
  // diff the empty tree so a freshly-initialized repo with only untracked/
  // staged files still shows something real instead of an empty result.
  const target = head ? 'HEAD' : '4b825dc642cb6eb9a060e54bf8d69288fbee4904' // git's canonical empty-tree hash
  const diff = await run(projectPath, ['diff', '--no-color', '-U3', target])
  const files = parseUnifiedDiff(diff.stdout)
  return { isRepo: true, branch, files }
}

export async function listCommits(projectPath: string, limit = 50): Promise<CommitInfo[]> {
  if (!(await isGitRepo(projectPath)) || !(await hasHead(projectPath))) return []
  const res = await run(projectPath, [
    'log',
    `-n${limit}`,
    '--date=relative',
    '--pretty=format:%H%x1f%an%x1f%ad%x1f%s'
  ])
  if (res.code !== 0 || !res.stdout.trim()) return []
  return res.stdout
    .trim()
    .split('\n')
    .map((line) => {
      const [hash, author, date, message] = line.split('\x1f')
      return { hash, author, date, message }
    })
}

export async function listWorktrees(projectPath: string): Promise<WorktreeInfo[]> {
  if (!(await isGitRepo(projectPath))) return []
  const res = await run(projectPath, ['worktree', 'list', '--porcelain'])
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
  return worktrees.map((w, idx) => ({ ...w, isMain: idx === 0 }))
}

export async function addWorktree(projectPath: string, worktreePath: string, branch: string): Promise<void> {
  const res = await run(projectPath, ['worktree', 'add', '-b', branch, worktreePath])
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git worktree add failed')
}

export async function removeWorktree(projectPath: string, worktreePath: string): Promise<void> {
  const res = await run(projectPath, ['worktree', 'remove', worktreePath, '--force'])
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git worktree remove failed')
}

export async function mergeWorktreeBranch(projectPath: string, branch: string): Promise<void> {
  const res = await run(projectPath, ['merge', '--no-edit', branch])
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'git merge failed')
}
