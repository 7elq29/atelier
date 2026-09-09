/**
 * Low-level git process execution + diff parsing shared by git-repository.ts.
 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import type { DiffFileChange, DiffFileStatus, DiffHunk, DiffLine } from '../../shared/panel-types'
import { expandTildePath } from '../../shared/project-path-autocomplete'
import { remoteCdTarget, shQuote } from '../shell-quote'
import { sshExec, warmSshMux } from '../ssh-exec'

/** Every git call, local or one SSH round trip. Sampled as a delta to attribute refresh cost. */
let gitInvocations = 0

export function getGitInvocationCount(): number {
  return gitInvocations
}

export function runGit(
  cwd: string,
  args: string[],
  sshHost?: string | null
): Promise<{ stdout: string; stderr: string; code: number }> {
  gitInvocations += 1
  const trimmedCwd = cwd.trim()
  if (sshHost) {
    return (async () => {
      await warmSshMux(sshHost)
      // Preserve `~` until this reaches the remote shell. Expanding it here
      // with local homedir() turns `~/repo` into `/Users/<local>/repo`, which
      // does not exist on a Linux DevPod. remoteCdTarget maps it to $HOME.
      const remote = `cd ${remoteCdTarget(trimmedCwd)} && git ${args.map(shQuote).join(' ')}`
      return sshExec(sshHost, remote)
    })()
  }
  const resolvedCwd = expandTildePath(trimmedCwd, homedir())
  return new Promise((resolve) => {
    execFile('git', args, { cwd: resolvedCwd, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException & { code?: number })?.code
      resolve({ stdout, stderr, code: typeof code === 'number' ? code : err ? 1 : 0 })
    })
  })
}

/** Strips `a/`/`b/` prefixes and optional `\t<timestamp>` suffixes from `---`/`+++` paths. */
export function normalizeDiffPath(raw: string): string {
  let p = raw.trim()
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2)
  const tab = p.indexOf('\t')
  if (tab !== -1) p = p.slice(0, tab)
  return p
}

/** `-c` flags that must appear before the git subcommand. */
export const GIT_PATCH_CONFIG_ARGS = ['-c', 'diff.external=', '-c', 'core.quotepath=false'] as const

/** After `git diff` / `git show` — disables `.gitattributes` diff drivers and textconv. */
export const GIT_NO_EXTERNAL_DIFF = ['--no-ext-diff', '--no-textconv'] as const

const repoRootCache = new Map<string, string>()

function repoRootCacheKey(projectPath: string, sshHost?: string | null): string {
  return `${sshHost ?? 'local'}\0${projectPath}`
}

/** Git toplevel when `projectPath` is inside a repo; null when not a git checkout. */
export async function resolveActualGitRepoRoot(
  projectPath: string,
  sshHost?: string | null
): Promise<string | null> {
  const res = await runGit(projectPath, ['rev-parse', '--show-toplevel'], sshHost)
  if (res.code !== 0 || !res.stdout.trim()) return null
  return res.stdout.trim()
}

/** Git toplevel for `projectPath` (may be a nested directory inside a monorepo). */
export async function resolveGitRepoRoot(
  projectPath: string,
  sshHost?: string | null
): Promise<string> {
  const key = repoRootCacheKey(projectPath, sshHost)
  const hit = repoRootCache.get(key)
  if (hit) return hit
  const root = (await resolveActualGitRepoRoot(projectPath, sshHost)) ?? projectPath
  repoRootCache.set(key, root)
  return root
}

export function clearGitRepoRootCache(projectPath: string, sshHost?: string | null): void {
  repoRootCache.delete(repoRootCacheKey(projectPath, sshHost))
}

/**
 * Memoized `resolveActualGitRepoRoot`, keyed by the probed directory.
 *
 * `resolveCapGitContext` probes one directory per session-touched path and is called 6-8 times
 * per path across the cap rebuild and hint-merge loops. Unmemoized that is ~150 serial SSH round
 * trips per refresh on a devpod, which is what pushes a background refresh past its timeout.
 * `resolveGitRepoRoot` cannot be substituted: callers here need `null` for "not a git checkout"
 * rather than a fallback to the probed path.
 */
const actualRepoRootCache = new Map<string, Promise<string | null>>()

export function resolveActualGitRepoRootCached(
  projectPath: string,
  sshHost?: string | null
): Promise<string | null> {
  const key = repoRootCacheKey(projectPath, sshHost)
  const hit = actualRepoRootCache.get(key)
  if (hit) return hit

  const pending = resolveActualGitRepoRoot(projectPath, sshHost).then((root) => {
    // Only a hit is durable. A miss means "no repo *yet*" — the directory may not exist until a
    // tool writes the first file into it (untracked plan files), or the probe may just have lost
    // its SSH connection. Neither is covered by the invalidation hooks below.
    if (root === null) actualRepoRootCache.delete(key)
    return root
  })
  actualRepoRootCache.set(key, pending)
  return pending
}

/**
 * Drops every memoized probe for a host. Entries are keyed by arbitrary nested directories, so a
 * worktree add/remove cannot be invalidated by repo path alone.
 */
export function clearActualGitRepoRootCache(sshHost?: string | null): void {
  const prefix = `${sshHost ?? 'local'}\0`
  for (const key of actualRepoRootCache.keys()) {
    if (key.startsWith(prefix)) actualRepoRootCache.delete(key)
  }
}

/** Run git with `-C <toplevel>` so repo-root-relative pathspecs match numstat paths. */
export async function runGitAtRepoRoot(
  projectPath: string,
  args: string[],
  sshHost?: string | null
): Promise<{ stdout: string; stderr: string; code: number }> {
  const root = await resolveGitRepoRoot(projectPath, sshHost)
  return runGit(projectPath, ['-C', root, ...args], sshHost)
}

export async function runGitDiffPatch(
  projectPath: string,
  args: string[],
  sshHost?: string | null
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runGitAtRepoRoot(
    projectPath,
    [...GIT_PATCH_CONFIG_ARGS, 'diff', ...GIT_NO_EXTERNAL_DIFF, ...args],
    sshHost
  )
}

export async function runGitShowPatch(
  projectPath: string,
  args: string[],
  sshHost?: string | null
): Promise<{ stdout: string; stderr: string; code: number }> {
  return runGitAtRepoRoot(
    projectPath,
    [...GIT_PATCH_CONFIG_ARGS, 'show', ...GIT_NO_EXTERNAL_DIFF, ...args],
    sshHost
  )
}

/** `git diff` exits 1 when patches differ (0 = identical). Treat 0/1 as success if stdout looks like a patch. */
export function gitPatchOutputUsable(code: number, stdout: string): boolean {
  if (code === 2 || code > 2) return false
  const t = stdout.trim()
  return t.length > 0 && (t.includes('diff --git') || t.includes('@@'))
}

/** Match a parsed diff file to the numstat path; fall back when git uses a slightly different path string. */
export function pickParsedDiffFile(
  parsed: DiffFileChange[],
  filePath: string,
  gitPath: string
): DiffFileChange | undefined {
  const matchesPath = (f: DiffFileChange): boolean =>
    f.path === filePath ||
    f.path === gitPath ||
    f.oldPath === filePath ||
    f.oldPath === gitPath ||
    (gitPath.length > 0 && (f.path.endsWith(`/${gitPath}`) || gitPath.endsWith(`/${f.path}`)))

  const direct = parsed.find(matchesPath)
  if (direct?.hunks.length) return direct

  const withHunks = parsed.filter((f) => f.hunks.length > 0)
  if (withHunks.length === 1) {
    const sole = withHunks[0]
    return { ...sole, path: filePath || gitPath || sole.path }
  }

  const hunksMatch = withHunks.find(matchesPath)
  if (hunksMatch) return { ...hunksMatch, path: filePath || gitPath || hunksMatch.path }

  return direct
}

/** Numstat path field — use the destination path when git reports `old => new`. */
export function numstatPathForGit(path: string): string {
  const arrow = path.indexOf(' => ')
  return arrow === -1 ? path : path.slice(arrow + 4).trim()
}

/** Prefer a text diff over binary (-/- numstat) when opening a commit. */
export function pickDefaultCommitFile(files: DiffFileChange[]): string | null {
  const withStats = files.find((f) => f.additions > 0 || f.deletions > 0)
  return withStats?.path ?? files[0]?.path ?? null
}

export function parseNumstatLines(lines: string[]): DiffFileChange[] {
  const files: DiffFileChange[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [addRaw, delRaw, ...pathParts] = parts
    const rawPath = pathParts.join('\t')
    const path = numstatPathForGit(rawPath)
    const additions = addRaw === '-' ? 0 : parseInt(addRaw, 10) || 0
    const deletions = delRaw === '-' ? 0 : parseInt(delRaw, 10) || 0
    let status: DiffFileStatus = 'modified'
    if (additions > 0 && deletions === 0) status = 'added'
    else if (additions === 0 && deletions > 0) status = 'deleted'
    files.push({ path, status, additions, deletions, hunks: [] })
  }
  return files
}

/** Parses a unified `git diff` patch into per-file hunk structures for rendering. */
export function parseUnifiedDiff(patch: string): DiffFileChange[] {
  const files: DiffFileChange[] = []
  const lines = patch.split('\n')
  let i = 0

  while (i < lines.length) {
    if (!lines[i].startsWith('diff --git')) {
      i++
      continue
    }
    i++
    let oldPath = ''
    let newPath = ''
    let status: DiffFileStatus = 'modified'
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff --git')) {
      const line = lines[i]
      if (line.startsWith('--- ')) oldPath = normalizeDiffPath(line.slice(4))
      else if (line.startsWith('+++ ')) newPath = normalizeDiffPath(line.slice(4))
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
        if (raw === '') {
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
