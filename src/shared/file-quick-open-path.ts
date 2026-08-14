export function normalizePath(p: string): string {
  return p.replace(/\/$/, '')
}

/** Parent of `currentDir`, never above `sessionRoot`. Returns null if already at session root. */
export function parentDirectory(sessionRoot: string, currentDir: string): string | null {
  const root = normalizePath(sessionRoot)
  const dir = normalizePath(currentDir)
  if (dir === root) return null
  const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : root
  if (parent.length < root.length) return root
  return parent
}

export function formatPathForDisplay(absPath: string, homeDir?: string): string {
  if (homeDir) {
    const normalized = homeDir.replace(/\/$/, '')
    if (absPath === normalized || absPath.startsWith(`${normalized}/`)) {
      return absPath.replace(normalized, '~')
    }
  }
  return absPath.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
}

function homeFromSessionRoot(sessionRoot: string, homeDir?: string): string {
  if (homeDir) return homeDir.replace(/\/$/, '')
  const mac = sessionRoot.match(/^(\/Users\/[^/]+)/)
  if (mac) return mac[1]!
  const linux = sessionRoot.match(/^(\/home\/[^/]+)/)
  if (linux) return linux[1]!
  return sessionRoot
}

/** Join a relative path segment onto a base directory (both normalized). */
export function joinPathUnderBase(base: string, relative: string): string {
  const b = normalizePath(base)
  const rel = relative.replace(/^\/+/, '').replace(/\/+$/, '')
  if (!rel) return b
  return normalizePath(`${b}/${rel}`)
}

/** Allowed list/browse target: workspace root, inside it, or an ancestor on the path to it. */
export function clampListDirectory(listDir: string, sessionRoot: string): string {
  const root = normalizePath(sessionRoot)
  const dir = normalizePath(listDir) || '/'
  if (dir === '/') return '/'
  if (dir === root || dir.startsWith(`${root}/`)) return dir
  if (root.startsWith(`${dir}/`)) return dir
  return root
}

/** Turn mock/display path (`~…`) back into an absolute path for browsing. */
export function expandDisplayPath(
  display: string,
  sessionRoot: string,
  relativeBase?: string
): string {
  const root = normalizePath(sessionRoot)
  const trimmed = display.trim()
  if (!trimmed) return clampListDirectory(normalizePath(relativeBase ?? root), root)
  let abs: string
  if (trimmed.startsWith('~')) {
    abs = normalizePath(trimmed.replace(/^~/, homeFromSessionRoot(sessionRoot)))
  } else if (trimmed.startsWith('/')) {
    abs = normalizePath(trimmed) || '/'
  } else {
    abs = joinPathUnderBase(relativeBase ?? root, trimmed)
  }
  return clampListDirectory(abs, root)
}

/**
 * While editing the dir field: which folder to list (one level) and which name
 * fragment to substring-match among its immediate children.
 */
export function resolveDirEditorQuery(
  dirQuery: string,
  sessionRoot: string,
  currentDir: string
): { listDir: string; segmentFilter: string } {
  const root = normalizePath(sessionRoot)
  const browseBase = normalizePath(currentDir)
  const trimmed = dirQuery.trim()
  if (!trimmed) return { listDir: browseBase, segmentFilter: '' }

  if (trimmed.endsWith('/')) {
    const withoutSlash = trimmed.replace(/\/$/, '')
    const listDir = withoutSlash
      ? expandDisplayPath(withoutSlash, sessionRoot, browseBase)
      : browseBase
    return { listDir: clampListDirectory(listDir, root), segmentFilter: '' }
  }

  let pathPart = trimmed
  if (pathPart.startsWith('~')) {
    pathPart = pathPart.replace(/^~/, homeFromSessionRoot(sessionRoot))
  } else if (!pathPart.startsWith('/')) {
    pathPart = joinPathUnderBase(browseBase, pathPart)
  }

  const lastSlash = pathPart.lastIndexOf('/')
  if (lastSlash === -1) {
    return { listDir: browseBase, segmentFilter: pathPart }
  }

  const parentRaw = lastSlash === 0 ? '/' : normalizePath(pathPart.slice(0, lastSlash))
  const segmentFilter = pathPart.slice(lastSlash + 1)
  const listDir = clampListDirectory(expandDisplayPath(parentRaw, sessionRoot, browseBase), root)
  return { listDir, segmentFilter }
}

/**
 * Search-mode scope: recurse from `currentDir`; `nameFilter` is applied client-side.
 */
export function resolveSearchListDir(
  currentDir: string,
  searchQuery: string,
  _sessionRoot: string
): { listDir: string; nameFilter: string } {
  const base = normalizePath(currentDir)
  return { listDir: base, nameFilter: searchQuery.trim() }
}

/** Tab-complete the active path segment in place (keeps the user's path text, not a full abs rewrite). */
export function completeDirQuerySegment(
  dirQuery: string,
  sessionRoot: string,
  currentDir: string,
  completedName: string
): { value: string; cursor: number } {
  const { segmentFilter } = resolveDirEditorQuery(dirQuery, sessionRoot, currentDir)
  if (!segmentFilter) {
    const trimmed = dirQuery.replace(/\s+$/, '')
    const value = trimmed.endsWith('/') ? `${trimmed}${completedName}` : `${trimmed}/${completedName}`
    return { value, cursor: value.length }
  }
  if (dirQuery.endsWith(segmentFilter)) {
    const value = dirQuery.slice(0, dirQuery.length - segmentFilter.length) + completedName
    return { value, cursor: value.length }
  }
  const value = dirQuery + completedName.slice(segmentFilter.length)
  return { value, cursor: value.length }
}
