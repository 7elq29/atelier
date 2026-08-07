/** Custom markdown href scheme — resolved to Files tab, never navigated in-app as a URL. */
export const ATELIER_FILE_SCHEME = 'atelier-file:'

const CODE_FENCE_RE = /(```[\s\S]*?```|`[^`\n]+`)/g

const SOURCE_EXT =
  /\.(tsx?|jsx?|mjs|cjs|json|mdx?|css|scss|html?|py|rs|go|yaml|yml|toml|sh|sql|vue|svelte|wasm|png|jpe?g|gif|svg|webp|lock|env|spec\.ts)(?:$|[?#:])/i

const MULTI_SEGMENT_PATH_RE = /(\.\/)?(?:[\w@.-]+\/)+[\w@.-]+(?:\.[\w]+)?/g
const ABSOLUTE_PATH_RE = /\/(?:[\w@.-]+\/)+[\w.-]+(?:\.[\w]+)?/g
const SINGLE_FILE_RE = /\b[\w@.-]+\.[\w]+\b/g

export function looksLikeFilePath(raw: string): boolean {
  const s = raw.trim()
  if (!s || s.length > 512) return false
  if (/^https?:\/\//i.test(s) || s.includes('://')) return false
  if (/\s/.test(s)) return false
  if (SOURCE_EXT.test(s)) return true
  if (s.startsWith('/') && s.split('/').length >= 3) return true
  if (s.includes('/')) return true
  return /^[\w@.-]+\.[\w.-]+$/.test(s)
}

export function resolveSessionFilePath(
  raw: string,
  workspaceRoot: string,
  _projectRoot: string
): string | null {
  const trimmed = raw.trim()
  if (!looksLikeFilePath(trimmed)) return null
  if (trimmed.startsWith('/')) return trimmed
  const root = workspaceRoot.replace(/\/$/, '')
  const rel = trimmed.replace(/^\.\//, '')
  return `${root}/${rel}`
}

function tryLinkPath(
  path: string,
  whole: string,
  offset: number,
  matchLen: number,
  workspaceRoot: string,
  projectRoot: string
): string {
  const prefix = whole.slice(Math.max(0, offset - 12), offset)
  if (/https?:\/\/$/i.test(prefix) || prefix.includes('://')) return path
  if (whole.slice(offset + matchLen).startsWith('](')) return path
  if (!looksLikeFilePath(path)) return path
  const resolved = resolveSessionFilePath(path, workspaceRoot, projectRoot)
  if (!resolved) return path
  return `[${path}](${ATELIER_FILE_SCHEME}${encodeURIComponent(resolved)})`
}

function linkifyPlainSegment(text: string, workspaceRoot: string, projectRoot: string): string {
  let out = text.replace(MULTI_SEGMENT_PATH_RE, (match, _dot, offset, whole) =>
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
