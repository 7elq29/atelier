/**
 * Session changes cap paths — repo-relative inside the workspace, absolute outside.
 */
import { isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'
import { expandTildePath } from './project-path-autocomplete'
import { resolveSessionWorkspaceRoot } from './plan-mirror-path'

function capPathToAbsolute(capPath: string, workspaceRoot: string, homeDir = homedir()): string {
  const trimmed = capPath.trim().replace(/\\/g, '/')
  if (isAbsolute(trimmed)) return resolve(trimmed)
  if (trimmed.startsWith('~')) return resolve(expandTildePath(trimmed, homeDir))
  return resolve(resolveSessionWorkspaceRoot(workspaceRoot), trimmed.replace(/^\.\//, ''))
}

/** Cap rows stored outside the session workspace (e.g. `~/.mcp/json`). Absolute paths under the workspace are not outside. */
export function isCapPathOutsideWorkspace(
  capPath: string,
  workspaceRoot?: string | null,
  homeDir: string = homedir()
): boolean {
  const trimmed = capPath.trim().replace(/\\/g, '/')
  if (!trimmed.startsWith('/') && !trimmed.startsWith('~')) {
    return false
  }
  if (!workspaceRoot?.trim()) {
    return true
  }
  const ws = resolveSessionWorkspaceRoot(workspaceRoot)
  const abs = capPathToAbsolute(trimmed, workspaceRoot, homeDir)
  return abs !== ws && !abs.startsWith(`${ws}/`)
}
