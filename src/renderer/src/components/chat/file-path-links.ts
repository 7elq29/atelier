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

export function resolveSessionFilePath(
  raw: string,
  workspaceRoot: string,
  _projectRoot: string
): string | null {
  const trimmed = raw.trim()
  if (!looksLikeFilePath(trimmed)) return null
  // Home-relative paths must not be joined to the session workspace — that
  // produces `~/project/~/.mcp.json` and worse on repeated resolution.
  if (trimmed.startsWith('~') || trimmed.startsWith('/')) return trimmed
  const root = workspaceRoot.replace(/\/$/, '')
  const rel = trimmed.replace(/^\.\//, '')
  return `${root}/${rel}`
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
  projectRoot: string
): string {
  if (isInsideMarkdownLink(whole, offset, offset + matchLen)) return path
  if (isInsideWebUrl(whole, offset, offset + matchLen)) return path
  const prefix = whole.slice(Math.max(0, offset - 12), offset)
  if (/https?:\/\/$/i.test(prefix) || prefix.includes('://')) return path
  if (whole.slice(offset + matchLen).startsWith('](')) return path
  if (!path.includes('/') && isFilenameBasenameOfLongerPath(whole, offset)) return path
  if (!looksLikeFilePath(path)) return path
  const resolved = resolveSessionFilePath(path, workspaceRoot, projectRoot)
  if (!resolved) return path
  return `[${path}](${ATELIER_FILE_SCHEME}${encodeURIComponent(resolved)})`
}

function linkifyPlainSegment(text: string, workspaceRoot: string, projectRoot: string): string {
  let out = text.replace(TILDE_PATH_RE, (match, offset, whole) =>
    tryLinkPath(match, whole, offset, match.length, workspaceRoot, projectRoot)
  )
  out = out.replace(MULTI_SEGMENT_PATH_RE, (match, _dot, offset, whole) =>
    tryLinkPath(match, whole, offset, match.length, workspaceRoot, projectRoot)
  )
  out = out.replace(ABSOLUTE_PATH_RE, (match, offset, whole) =>
    tryLinkPath(match, whole, offset, match.length, workspaceRoot, projectRoot)
  )
  out = out.replace(SINGLE_FILE_RE, (match, offset, whole) =>
    tryLinkPath(match, whole, offset, match.length, workspaceRoot, projectRoot)
  )
  return out
}

/** Turn bare file paths in assistant markdown into `atelier-file:` links (skips code spans/fences). */
export function linkifyFilePathsInMarkdown(
  markdown: string,
  workspaceRoot: string,
  projectRoot: string
): string {
  if (!workspaceRoot) return markdown
  const out: string[] = []
  let last = 0
  for (const m of markdown.matchAll(CODE_FENCE_RE)) {
    const idx = m.index ?? 0
    out.push(linkifyPlainSegment(markdown.slice(last, idx), workspaceRoot, projectRoot))
    out.push(m[0])
    last = idx + m[0].length
  }
  out.push(linkifyPlainSegment(markdown.slice(last), workspaceRoot, projectRoot))
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
