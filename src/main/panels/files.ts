/**
 * Real filesystem walk + file reads/writes for the Files/Explorer panel
 * (07-secondary-panels §3). For local sessions: walks the session's actual
 * `project_path` on disk via Node's `fs`. For remote/devpod sessions: runs
 * equivalent operations over SSH using ControlMaster-multiplexed connections
 * (same pattern as git.ts), so repeated calls after the first pay ~5ms auth
 * cost instead of ~4.5s.
 */
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { shQuote, remoteCdTarget } from '../shell-quote'
import { logger } from '../logger'
import type { FileKind, FileReadResult, FileTreeNode, FileWriteResult } from '../../shared/panel-types'

const ALWAYS_IGNORED = new Set(['.git', 'node_modules', '.DS_Store'])
const MAX_ENTRIES = 3000

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])
const HTML_EXTENSIONS = new Set(['html', 'htm'])
const BINARY_EXTENSIONS = new Set(['pdf', 'zip', 'gz', 'tar', 'exe', 'dll', 'so', 'dylib', 'woff', 'woff2', 'ttf', 'mp4', 'mp3', 'wasm'])

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

/**
 * SSH multiplexing options — same values as pty.ts so file reads/writes reuse
 * the existing ControlMaster socket the terminal already established, making
 * repeated SSH calls to the same host take ~5ms instead of ~4.5s each.
 */
const SSH_MUX_OPTS = [
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPath=/tmp/atelier-ssh-%C',
  '-o', 'ControlPersist=300',
]

function sshExec(sshHost: string, remoteCmd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('ssh', [...SSH_MUX_OPTS, sshHost, '--', remoteCmd], { maxBuffer: 1024 * 1024 * 32 }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException & { code?: number })?.code
      resolve({ stdout, stderr, code: typeof code === 'number' ? code : err ? 1 : 0 })
    })
  })
}

// ── Local helpers ────────────────────────────────────────────────────────────

/** Very small `.gitignore` matcher: supports plain names, trailing-slash dir patterns, and `*.ext` globs. Not a full gitignore implementation by design (spec: "don't over-engineer"). */
function loadIgnoreMatchers(root: string): ((relPath: string, isDir: boolean) => boolean)[] {
  const gitignorePath = join(root, '.gitignore')
  if (!existsSync(gitignorePath)) return []
  const lines = readFileSync(gitignorePath, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))

  return lines.map((pattern) => {
    const dirOnly = pattern.endsWith('/')
    const clean = dirOnly ? pattern.slice(0, -1) : pattern
    if (clean.startsWith('*.')) {
      const ext = clean.slice(2)
      return (relPath: string, isDir: boolean) => !isDir && relPath.split('/').pop()?.endsWith(`.${ext}`) === true
    }
    return (relPath: string, isDir: boolean) => {
      const segments = relPath.split('/')
      const matches = segments.includes(clean)
      return dirOnly ? matches && isDir : matches
    }
  })
}

function isIgnored(name: string, relPath: string, isDir: boolean, matchers: ((relPath: string, isDir: boolean) => boolean)[]): boolean {
  if (ALWAYS_IGNORED.has(name)) return true
  return matchers.some((m) => m(relPath, isDir))
}

function walkLocalDir(root: string, dir: string, matchers: ReturnType<typeof loadIgnoreMatchers>): FileTreeNode[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const nodes: FileTreeNode[] = []
  for (const name of entries.sort()) {
    const full = join(dir, name)
    const rel = relative(root, full)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    const isDir = stat.isDirectory()
    if (isIgnored(name, rel, isDir, matchers)) continue
    nodes.push(isDir
      ? { name, path: full, relativePath: rel, type: 'dir' }
      : { name, path: full, relativePath: rel, type: 'file' }
    )
  }
  return nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
}

function walkLocal(root: string): FileTreeNode[] {
  const matchers = loadIgnoreMatchers(root)
  return walkLocalDir(root, root, matchers)
}

function walkLocalChildren(root: string, dir: string): FileTreeNode[] {
  const matchers = loadIgnoreMatchers(root)
  return walkLocalDir(root, dir, matchers)
}

// ── Remote helpers ───────────────────────────────────────────────────────────

/**
 * Parses `find . -printf '%y %P\n'` output (relative paths, Linux/devpod).
 * Lines look like: `f src/index.ts` or `d src`. Empty path = starting point, skipped.
 */
function buildRemoteTree(root: string, findOutput: string): FileTreeNode[] {
  const lines = findOutput.split('\n').filter((l) => l.length > 2)
  const nodeMap = new Map<string, FileTreeNode>()
  const childMap = new Map<string, FileTreeNode[]>()
  let count = 0

  for (const line of lines) {
    if (count >= MAX_ENTRIES) break
    const typeChar = line[0]
    const relPath = line.slice(2) // skip "f " or "d "
    if (!relPath) continue        // empty = starting point itself

    const segments = relPath.split('/')
    const name = segments[segments.length - 1]
    if (ALWAYS_IGNORED.has(name)) continue

    const absPath = `${root}/${relPath}`
    const isDir = typeChar === 'd'
    const node: FileTreeNode = {
      name,
      path: absPath,
      relativePath: relPath,
      type: isDir ? 'dir' : 'file',
      children: isDir ? [] : undefined
    }
    nodeMap.set(absPath, node)

    const parentRelPath = segments.slice(0, -1).join('/')
    const parentAbs = parentRelPath ? `${root}/${parentRelPath}` : root
    if (!childMap.has(parentAbs)) childMap.set(parentAbs, [])
    childMap.get(parentAbs)!.push(node)
    count++
  }

  // Attach children to their parents
  for (const [parentAbs, kids] of childMap) {
    const parent = nodeMap.get(parentAbs)
    if (parent?.type === 'dir') {
      parent.children = kids.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
      )
    }
  }

  return (childMap.get(root) ?? []).sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
}

async function walkRemote(root: string, sshHost: string): Promise<FileTreeNode[]> {
  const ignoredNames = [...ALWAYS_IGNORED].map((n) => `-name ${shQuote(n)}`).join(' -o ')
  const cmd = `cd ${remoteCdTarget(root)} && find . -maxdepth 1 \\( ${ignoredNames} \\) -prune -o -printf '%y %P\\n' 2>/dev/null`
  const { stdout, code } = await sshExec(sshHost, cmd)
  logger.info('files:tree:remote:done', { root, sshHost, code, lines: stdout.split('\n').length })
  return buildRemoteTree(root, stdout)
}

async function walkRemoteChildren(root: string, dir: string, sshHost: string): Promise<FileTreeNode[]> {
  const ignoredNames = [...ALWAYS_IGNORED].map((n) => `-name ${shQuote(n)}`).join(' -o ')
  const cmd = `cd ${remoteCdTarget(dir)} && find . -maxdepth 1 \\( ${ignoredNames} \\) -prune -o -printf '%y %P\\n' 2>/dev/null`
  const { stdout, code } = await sshExec(sshHost, cmd)
  logger.info('files:dir:remote:done', { root, dir, sshHost, code })
  return buildRemoteTree(dir, stdout)
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Walks only the top-level of `root`, returning a flat list of first-level entries (dirs have no children until expanded). */
export function walkFileTree(root: string, sshHost?: string | null): Promise<FileTreeNode[]> | FileTreeNode[] {
  logger.info('files:tree', { root, remote: Boolean(sshHost) })
  if (sshHost) return walkRemote(root, sshHost)
  const result = walkLocal(root)
  logger.info('files:tree:done', { root, count: result.length })
  return result
}

/** Walks one level of `dir` and returns its children (for lazy directory expansion). */
export function walkDirChildren(root: string, dir: string, sshHost?: string | null): Promise<FileTreeNode[]> | FileTreeNode[] {
  logger.info('files:dir', { root, dir, remote: Boolean(sshHost) })
  if (sshHost) return walkRemoteChildren(root, dir, sshHost)
  return walkLocalChildren(root, dir)
}

export async function readFileForPreview(path: string, sshHost?: string | null): Promise<FileReadResult> {
  const ext = extname(path).slice(1).toLowerCase()

  if (sshHost) {
    if (BINARY_EXTENSIONS.has(ext)) {
      return { kind: 'binary' as FileKind, content: '', extension: ext }
    }
    if (IMAGE_EXTENSIONS.has(ext)) {
      const { stdout } = await sshExec(sshHost, `base64 ${shQuote(path)}`)
      const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
      return { kind: 'image' as FileKind, content: `data:${mime};base64,${stdout.replace(/\s/g, '')}`, extension: ext }
    }
    const { stdout } = await sshExec(sshHost, `cat ${shQuote(path)}`)
    if (HTML_EXTENSIONS.has(ext)) {
      return { kind: 'html' as FileKind, content: stdout, extension: ext }
    }
    return { kind: 'text' as FileKind, content: stdout, extension: ext || basename(path) }
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    const buf = readFileSync(path)
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream'
    return { kind: 'image' as FileKind, content: `data:${mime};base64,${buf.toString('base64')}`, extension: ext }
  }

  if (BINARY_EXTENSIONS.has(ext)) {
    return { kind: 'binary' as FileKind, content: '', extension: ext }
  }

  const text = readFileSync(path, 'utf-8')
  if (HTML_EXTENSIONS.has(ext)) {
    return { kind: 'html' as FileKind, content: text, extension: ext }
  }
  return { kind: 'text' as FileKind, content: text, extension: ext || basename(path) }
}

export async function writeFileContent(path: string, content: string, sshHost?: string | null): Promise<FileWriteResult> {
  if (sshHost) {
    return new Promise((resolve) => {
      const proc = spawn('ssh', [...SSH_MUX_OPTS, sshHost, '--', `cat > ${shQuote(path)}`])
      proc.stdin.write(content, 'utf8')
      proc.stdin.end()
      proc.on('close', (code) => {
        if (code === 0) resolve({ ok: true })
        else resolve({ ok: false, error: `SSH write failed with exit code ${code}` })
      })
      proc.on('error', (err) => resolve({ ok: false, error: err.message }))
    })
  }

  try {
    writeFileSync(path, content, 'utf8')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
