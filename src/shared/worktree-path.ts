import type { AtelierConfig } from './config'
import { expandTildePath } from './project-path-autocomplete'

export const DEFAULT_WORKTREE_ROOT = '~/.atelier/worktrees'

export function worktreeRootFromConfig(config: Pick<AtelierConfig, 'worktreeRoot'>): string {
  const trimmed = config.worktreeRoot?.trim()
  return trimmed || DEFAULT_WORKTREE_ROOT
}

/** Absolute path where a session's isolated worktree checkout should live. */
export function sessionWorktreePath(worktreeRoot: string, sessionId: string, homeDir: string): string {
  const root = expandTildePath(worktreeRoot, homeDir).replace(/\/$/, '')
  return `${root}/${sessionId}`
}

/** Display string for UI hints (keeps `~` when under user home). */
export function formatWorktreeRootForDisplay(worktreeRoot: string, homeDir: string): string {
  const root = expandTildePath(worktreeRoot, homeDir)
  if (root === homeDir) return '~'
  if (root.startsWith(`${homeDir}/`)) return `~${root.slice(homeDir.length)}`
  return worktreeRoot.trim() || DEFAULT_WORKTREE_ROOT
}
