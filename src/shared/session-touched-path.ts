/**
 * Session changes cap paths — repo-relative inside the workspace, absolute outside.
 */

/** Cap rows stored outside the session workspace (e.g. `~/.mcp/json`). */
export function isCapPathOutsideWorkspace(capPath: string): boolean {
  const trimmed = capPath.trim()
  return trimmed.startsWith('/') || trimmed.startsWith('~')
}
