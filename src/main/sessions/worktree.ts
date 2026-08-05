/**
 * Git worktree helpers for isolated session workspaces (use-worktree).
 *
 * Each local claude-code session created with "Use worktree" gets its own
 * git worktree at `<project>/.gardenia/worktrees/<sessionId>` on a fresh
 * branch `gardenia-<sessionId-prefix>`. Claude Code runs inside that path
 * instead of the main project root, so its file edits never touch the
 * original working tree. The worktree and its branch are cleaned up when
 * the session is deleted.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '../logger'

/**
 * Creates a git worktree for a session.
 *
 * Runs `git -C <projectPath> worktree add <worktreePath> -b <branch>`.
 * Returns the absolute worktree path on success.
 * Throws if the directory is not a git repo or `git worktree add` fails —
 * callers should catch this and fall back to creating the session without a
 * worktree.
 */
export function createWorktree(projectPath: string, sessionId: string): string {
  const worktreePath = join(projectPath, '.gardenia', 'worktrees', sessionId)
  const branch = `gardenia-${sessionId.slice(0, 8)}`

  logger.info('worktree: creating', { projectPath, worktreePath, branch })

  execFileSync('git', ['-C', projectPath, 'worktree', 'add', worktreePath, '-b', branch], {
    encoding: 'utf8'
  })

  logger.info('worktree: created', { worktreePath, branch })
  return worktreePath
}

/**
 * Removes a session's git worktree and its branch.
 *
 * Walks up from `worktreePath` to find the main repo root (skips the
 * `.gardenia/worktrees/<id>` path segments). Errors from either git call
 * are swallowed and logged — a failed cleanup must never block session
 * deletion.
 */
export function removeWorktree(worktreePath: string, sessionId: string): void {
  if (!existsSync(worktreePath)) {
    logger.info('worktree: path does not exist, skipping removal', { worktreePath })
    return
  }

  // Derive the main repo root: go up 3 levels from
  // `<project>/.gardenia/worktrees/<sessionId>`.
  const projectPath = dirname(dirname(dirname(worktreePath)))
  const branch = `gardenia-${sessionId.slice(0, 8)}`

  logger.info('worktree: removing', { worktreePath, projectPath, branch })

  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], { encoding: 'utf8' })
  } catch (err) {
    logger.warn('worktree: git worktree remove failed (ignored)', {
      worktreePath,
      error: err instanceof Error ? err.message : String(err)
    })
  }

  try {
    execFileSync('git', ['-C', projectPath, 'branch', '-D', branch], { encoding: 'utf8' })
  } catch (err) {
    logger.warn('worktree: git branch -D failed (ignored)', {
      branch,
      projectPath,
      error: err instanceof Error ? err.message : String(err)
    })
  }

  logger.info('worktree: removal complete', { worktreePath, branch })
}
