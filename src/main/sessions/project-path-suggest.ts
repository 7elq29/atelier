import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { walkDirChildren } from '../panels/files'
import type { RemoteHostResolver } from './manager'
import type { SessionStore } from './store'
import {
  REMOTE_SESSION_HOME,
  buildDirectorySuggestionValue,
  historyMatchesQuery,
  resolveProjectPathListContext,
  type ProjectPathSuggestion
} from '../../shared/project-path-autocomplete'

export function sessionHomeDir(hostId: string): string {
  return hostId === 'local' ? homedir() : REMOTE_SESSION_HOME
}

export async function suggestProjectPaths(
  hostId: string,
  query: string,
  store: SessionStore,
  hosts: RemoteHostResolver
): Promise<ProjectPathSuggestion[]> {
  const homeDir = sessionHomeDir(hostId)
  const history = store.listRecentProjectPaths(hostId)
  const out: ProjectPathSuggestion[] = []
  const seen = new Set<string>()

  for (const path of history) {
    if (!historyMatchesQuery(path, query)) continue
    if (seen.has(path)) continue
    seen.add(path)
    out.push({ kind: 'history', value: path, label: path })
  }

  const { listDir, segmentFilter, pathPrefix } = resolveProjectPathListContext(query, homeDir)
  if (hostId === 'local' && !existsSync(listDir)) {
    return out.slice(0, 15)
  }

  const sshHost = hostId === 'local' ? null : hosts.resolve(hostId)?.sshHost ?? null
  try {
    const children = await walkDirChildren(listDir, listDir, sshHost)
    const lower = segmentFilter.toLowerCase()
    const dirs = children
      .filter((n) => n.type === 'dir' && n.name.toLowerCase().startsWith(lower))
      .slice(0, 12)

    for (const node of dirs) {
      const value = buildDirectorySuggestionValue(node.name, pathPrefix, node.path, homeDir)
      if (seen.has(value)) continue
      seen.add(value)
      out.push({ kind: 'directory', value, label: `${node.name}/` })
    }
  } catch {
    // Remote host down or path missing — history-only is still useful.
  }

  return out.slice(0, 15)
}
