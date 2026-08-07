import { normalizePath } from './file-quick-open-path'

export type ProjectPathSuggestionKind = 'history' | 'directory'

export interface ProjectPathSuggestion {
  kind: ProjectPathSuggestionKind
  value: string
  label: string
}

/** Remote devpod home (matches `RemoteHostOption` / e2e fixtures). */
export const REMOTE_SESSION_HOME = '/home/user'

export function expandTildePath(input: string, homeDir: string): string {
  const trimmed = input.trim()
  if (!trimmed || trimmed === '~') return homeDir
  if (trimmed.startsWith('~/')) {
    const rest = trimmed.slice(2).replace(/\/+$/, '')
    return rest ? normalizePath(`${homeDir}/${rest}`) : homeDir
  }
  if (trimmed.startsWith('/')) {
    const n = normalizePath(trimmed)
    return n || '/'
  }
  return normalizePath(`${homeDir}/${trimmed.replace(/\/+$/, '')}`)
}

export function formatPathForDisplay(absPath: string, homeDir: string): string {
  const n = normalizePath(absPath)
  if (n === homeDir) return '~'
  if (n.startsWith(`${homeDir}/`)) return `~${n.slice(homeDir.length)}`
  return n
}

/**
 * Which directory to list (one level) and which name prefix to match among its
 * children, for the New Session project-path field.
 */
export function resolveProjectPathListContext(
  query: string,
  homeDir: string
): { listDir: string; segmentFilter: string; pathPrefix: string } {
  const trimmed = query
  if (!trimmed) {
    return { listDir: homeDir, segmentFilter: '', pathPrefix: '' }
  }
  if (trimmed.endsWith('/')) {
    const without = trimmed.replace(/\/+$/, '')
    const listDir = without ? expandTildePath(without, homeDir) : homeDir
    const pathPrefix = trimmed
    return { listDir, segmentFilter: '', pathPrefix }
  }

  const lastSlash = trimmed.lastIndexOf('/')
  if (lastSlash === -1) {
    if (trimmed.startsWith('~')) {
      const expanded = expandTildePath(trimmed, homeDir)
      const innerSlash = expanded.lastIndexOf('/')
      if (innerSlash <= 0) {
        return { listDir: homeDir, segmentFilter: trimmed.slice(1), pathPrefix: '~/' }
      }
      const listDir = expanded.slice(0, innerSlash) || homeDir
      const segmentFilter = expanded.slice(innerSlash + 1)
      const pathPrefix = trimmed.slice(0, trimmed.length - segmentFilter.length)
      return { listDir: expandTildePath(listDir, homeDir), segmentFilter, pathPrefix }
    }
    return { listDir: homeDir, segmentFilter: trimmed, pathPrefix: '' }
  }

  const parentPart = trimmed.slice(0, lastSlash)
  const segmentFilter = trimmed.slice(lastSlash + 1)
  const listDir = parentPart ? expandTildePath(parentPart, homeDir) : homeDir
  const pathPrefix = `${parentPart}/`
  return { listDir, segmentFilter, pathPrefix }
}

export function historyMatchesQuery(path: string, query: string): boolean {
  if (!query.trim()) return true
  return path.toLowerCase().includes(query.trim().toLowerCase())
}

export function buildDirectorySuggestionValue(
  dirName: string,
  pathPrefix: string,
  absDirPath: string,
  homeDir: string
): string {
  if (pathPrefix) return `${pathPrefix}${dirName}/`
  return `${formatPathForDisplay(absDirPath, homeDir)}/`
}
