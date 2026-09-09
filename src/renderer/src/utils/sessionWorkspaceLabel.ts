import type { SessionRecord } from '../../../shared/session-types'

/**
 * Short human label for what a session is attached to — the remote host when
 * there is one, otherwise the project directory's own name. Used where a full
 * path would bury the point (e.g. the ready-to-chat hint).
 */
export function sessionWorkspaceLabel(session: SessionRecord): string {
  if (session.hostname) return session.hostname
  const path = session.worktreePath ?? session.projectPath
  return path.split('/').filter(Boolean).pop() ?? path
}
