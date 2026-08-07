/**
 * Low-level git process execution + diff parsing shared by git-repository.ts.
 */
import { execFile } from 'node:child_process'
import type { DiffFileChange, DiffFileStatus, DiffHunk, DiffLine } from '../../shared/panel-types'
import { remoteCdTarget, shQuote } from '../shell-quote'
import { sshExec, warmSshMux } from '../ssh-exec'

export function runGit(
  cwd: string,
  args: string[],
  sshHost?: string | null
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (sshHost) {
    return (async () => {
      await warmSshMux(sshHost)
      const remote = `cd ${remoteCdTarget(cwd)} && git ${args.map(shQuote).join(' ')}`
      return sshExec(sshHost, remote)
    })()
  }
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
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

/** `git diff` exits 1 when patches differ (0 = identical). Treat 0/1 as success if stdout looks like a patch. */
export function gitPatchOutputUsable(code: number, stdout: string): boolean {
  if (code === 2 || code > 2) return false
  const t = stdout.trim()
  return t.length > 0 && (t.includes('diff --git') || t.includes('@@'))
}

/** Numstat path field — use the destination path when git reports `old => new`. */
export function numstatPathForGit(path: string): string {
  const arrow = path.indexOf(' => ')
  return arrow === -1 ? path : path.slice(arrow + 4).trim()
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
