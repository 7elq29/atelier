/** Custom markdown href scheme — resolved to Files tab, never navigated in-app as a URL. */
export const ATELIER_FILE_SCHEME = 'atelier-file:'

const CODE_FENCE_RE = /(```[\s\S]*?```|`[^`\n]+`)/g

const TILDE_PATH_RE = /~\/[\w@./-]+/g

const KNOWN_FILE_EXT =
  'tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|html?|py|rs|go|yaml|yml|toml|sh|sql|uql|vue|svelte|wasm|png|jpe?g|gif|svg|webp|lock|env|spec\\.ts'

const SOURCE_EXT = new RegExp(`\\.(${KNOWN_FILE_EXT})(?:$|[?#:])`, 'i')

const MULTI_SEGMENT_PATH_RE = /(\.\/)?(?:[\w@.-]+\/)+[\w@.-]+(?:\.[\w]+)?/g
const ABSOLUTE_PATH_RE = /\/(?:[\w@.-]+\/)+[\w.-]+(?:\.[\w]+)?/g
const SINGLE_FILE_RE = new RegExp(`\\b[\\w@.-]+\\.(?:${KNOWN_FILE_EXT})\\b`, 'gi')

function hasEllipsisPathSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '...' || segment.includes('...'))
}

export function looksLikeFilePath(raw: string): boolean {
  const s = raw.trim()
  if (!s || s.length > 512) return false
  if (/^https?:\/\//i.test(s) || s.includes('://')) return false
  if (/\s/.test(s)) return false
  if (hasEllipsisPathSegment(s)) return false
  if (s.startsWith('~/')) return true
  if (SOURCE_EXT.test(s)) return true
  if (s.startsWith('/') && s.split('/').length >= 3) return true
  if (s.includes('/')) return true
  return false
}

function isBasenameOnly(raw: string): boolean {
  const s = raw.trim()
  return looksLikeFilePath(s) && !s.includes('/') && !s.startsWith('~') && !s.startsWith('/')
}

function basenameOfPath(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path
}

function isAbsoluteFilePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('~')
}

/** Prefer absolute cap/files paths over git-relative duplicates, then shortest path. */
function findPathByBasename(basename: string, candidates: readonly string[]): string | null {
  const want = basename.toLowerCase()
  const matches = candidates.filter((p) => basenameOfPath(p).toLowerCase() === want)
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]!
  return [...matches].sort((a, b) => {
    const absDiff = Number(isAbsoluteFilePath(b)) - Number(isAbsoluteFilePath(a))
    if (absDiff !== 0) return absDiff
    return a.length - b.length
  })[0]!
}

function joinToWorkspaceRoot(relativeOrAbs: string, workspaceRoot: string): string {
  if (isAbsoluteFilePath(relativeOrAbs)) return relativeOrAbs
  const root = workspaceRoot.replace(/\/$/, '')
  return `${root}/${relativeOrAbs.replace(/^\.\//, '')}`
}

/** Session cwd for file links — the worktree when present, else projectPath. */
export function sessionFileLinkWorkspaceRoot(session: {
  profileId?: string | null
  worktreePath?: string | null
  projectPath: string
}): string {
  return session.worktreePath ?? session.projectPath
}

export function collectFilePathCandidates(sources: {
  capPaths?: readonly string[]
  filesList?: readonly { path: string; relativePath: string }[]
  diffPaths?: readonly string[]
}): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (p: string) => {
    const key = p.replace(/\\/g, '/')
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(p)
  }
  for (const p of sources.capPaths ?? []) add(p)
  for (const e of sources.filesList ?? []) {
    add(e.path)
    add(e.relativePath)
  }
  for (const p of sources.diffPaths ?? []) add(p)
  return out
}

function extractRelativeUnderRoot(path: string, root: string): string | null {
  const normalized = path.trim().replace(/\/$/, '')
  const normalizedRoot = root.trim().replace(/\/$/, '')
  if (!normalizedRoot) return null
  if (normalized === normalizedRoot) return ''
  if (normalized.startsWith(`${normalizedRoot}/`)) return normalized.slice(normalizedRoot.length + 1)
  if (normalizedRoot.startsWith('~/') && normalized.startsWith('~/')) {
    const rootTail = normalizedRoot.slice(2)
    const pathTail = normalized.slice(2)
    if (pathTail === rootTail) return ''
    if (pathTail.startsWith(`${rootTail}/`)) return pathTail.slice(rootTail.length + 1)
  }
  return null
}

/** Rewrite paths rooted at the profile monorepo dir to the active session worktree. */
export function remapSessionFilePathToWorktree(
  path: string,
  session: { projectPath: string; worktreePath?: string | null }
): string {
  const worktreePath = session.worktreePath
  if (!worktreePath || worktreePath === session.projectPath) return path
  const rel = extractRelativeUnderRoot(path, session.projectPath)
  if (rel == null) return path
  return joinToWorkspaceRoot(rel, worktreePath)
}

export function resolveSessionFilePath(
  raw: string,
  workspaceRoot: string,
  _projectRoot: string,
  candidates?: readonly string[]
): string | null {
  const trimmed = raw.trim()
  if (!looksLikeFilePath(trimmed)) return null
  // Home-relative paths must not be joined to the session workspace — that
  // produces `~/project/~/.mcp.json` and worse on repeated resolution.
  if (trimmed.startsWith('~') || trimmed.startsWith('/')) return trimmed
  if (isBasenameOnly(trimmed) && candidates?.length) {
    const match = findPathByBasename(trimmed, candidates)
    if (match) return joinToWorkspaceRoot(match, workspaceRoot)
  }
  return joinToWorkspaceRoot(trimmed, workspaceRoot)
}

function isInsideMarkdownLink(whole: string, offset: number, matchEnd: number): boolean {
  const before = whole.slice(0, offset)
  const destOpen = before.lastIndexOf('](')
  if (destOpen !== -1) {
    const destStart = destOpen + 2
    const destClose = whole.indexOf(')', destStart)
    if (destClose !== -1 && offset >= destStart && matchEnd <= destClose) return true
  }
  const textOpen = before.lastIndexOf('[')
  if (textOpen !== -1) {
    const closeBracket = whole.indexOf(']', textOpen)
    if (closeBracket !== -1 && whole.slice(closeBracket, closeBracket + 2) === '](') {
      if (offset >= textOpen + 1 && matchEnd <= closeBracket) return true
    }
  }
  return false
}

function isInsideWebUrl(whole: string, offset: number, matchEnd: number): boolean {
  const before = whole.slice(0, offset)
  // Path regexes can match from the second `/` in `https://` (offset sits on
  // `/linear.app/...` while `before` is only `… https:/`).
  if (/https?:\/$/i.test(before) || /https?:$/i.test(before)) return true
  const httpIdx = before.lastIndexOf('http://')
  const httpsIdx = before.lastIndexOf('https://')
  const start = Math.max(httpIdx, httpsIdx)
  if (start === -1) return false
  const tail = whole.slice(start)
  const endMatch = tail.match(/^https?:\/\/[^\s<>"')\]]*/i)
  if (!endMatch) return false
  return matchEnd <= start + endMatch[0].length
}

function isFilenameBasenameOfLongerPath(whole: string, offset: number): boolean {
  return offset > 0 && whole[offset - 1] === '/'
}

function tryLinkPath(
  path: string,
  whole: string,
  offset: number,
  matchLen: number,
  workspaceRoot: string,
  projectRoot: string,
  candidates?: readonly string[]
): string {
  if (isInsideMarkdownLink(whole, offset, offset + matchLen)) return path
  if (isInsideWebUrl(whole, offset, offset + matchLen)) return path
  const prefix = whole.slice(Math.max(0, offset - 12), offset)
  if (/https?:\/\/$/i.test(prefix) || prefix.includes('://')) return path
  if (whole.slice(offset + matchLen).startsWith('](')) return path
  if (!path.includes('/') && isFilenameBasenameOfLongerPath(whole, offset)) return path
  if (!looksLikeFilePath(path)) return path
  const resolved = resolveSessionFilePath(path, workspaceRoot, projectRoot, candidates)
  if (!resolved) return path
  return `[${path}](${ATELIER_FILE_SCHEME}${encodeURIComponent(resolved)})`
}

function linkifyPlainSegment(
  text: string,
  workspaceRoot: string,
  projectRoot: string,
  candidates?: readonly string[]
): string {
  let out = text.replace(TILDE_PATH_RE, (match, offset, whole) =>
    tryLinkPath(match, whole, offset, match.length, workspaceRoot, projectRoot, candidates)
  )
  out = out.replace(MULTI_SEGMENT_PATH_RE, (match, _dot, offset, whole) =>
    tryLinkPath(match, whole, offset, match.length, workspaceRoot, projectRoot, candidates)
  )
  out = out.replace(ABSOLUTE_PATH_RE, (match, offset, whole) =>
    tryLinkPath(match, whole, offset, match.length, workspaceRoot, projectRoot, candidates)
  )
  out = out.replace(SINGLE_FILE_RE, (match, offset, whole) =>
    tryLinkPath(match, whole, offset, match.length, workspaceRoot, projectRoot, candidates)
  )
  return out
}

/** Turn bare file paths in assistant markdown into `atelier-file:` links (skips code spans/fences). */
export function linkifyFilePathsInMarkdown(
  markdown: string,
  workspaceRoot: string,
  projectRoot: string,
  candidates?: readonly string[]
): string {
  if (!workspaceRoot) return markdown
  const out: string[] = []
  let last = 0
  for (const m of markdown.matchAll(CODE_FENCE_RE)) {
    const idx = m.index ?? 0
    out.push(linkifyPlainSegment(markdown.slice(last, idx), workspaceRoot, projectRoot, candidates))
    out.push(m[0])
    last = idx + m[0].length
  }
  out.push(linkifyPlainSegment(markdown.slice(last), workspaceRoot, projectRoot, candidates))
  return out.join('')
}

export function hrefToAtelierFilePath(href: string): string | null {
  if (!href.startsWith(ATELIER_FILE_SCHEME)) return null
  try {
    return decodeURIComponent(href.slice(ATELIER_FILE_SCHEME.length))
  } catch {
    return null
  }
}
