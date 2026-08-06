/**
 * Git worktree helpers for isolated session workspaces (use-worktree).
 *
 * Each claude-code session created with "Use worktree" gets its own git
 * worktree at `<project>/.gardenia/worktrees/<sessionId>` on a fresh branch
 * `gardenia-<sessionId-prefix>`. Claude Code runs inside that path instead of
 * the main project root, so its file edits never touch the original working
 * tree. The worktree and its branch are cleaned up when the session is
 * deleted.
 *
 * For remote (devpod) sessions, git commands are prefixed with
 * `ssh <hostname>` so they run on the remote host.
 */

import { execFile as _execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '../logger'

const execFile = promisify(_execFile)

/** Thrown by `createWorktree` when the git command fails. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeError'
  }
}

/**
 * Creates a git worktree for a session.
 *
 * For local sessions: runs `git -C <projectPath> worktree add <worktreePath> -b <branch>`.
 * For remote sessions: runs `ssh <hostname> git -C <projectPath> worktree add <worktreePath> -b <branch>`.
 * Returns the absolute worktree path on success.
 * Throws `WorktreeError` if `git worktree add` fails — callers should surface
 * this as a user-visible error.
 */
export async function createWorktree(projectPath: string, sessionId: string, hostname?: string): Promise<string> {
  const worktreePath = join(projectPath, '.gardenia', 'worktrees', sessionId)
  const branch = `gardenia-${sessionId.slice(0, 8)}`

  logger.info('worktree: creating', { projectPath, worktreePath, branch, hostname })

  if (hostname) {
    await execFile(
      'ssh',
      [hostname, 'git', '-C', projectPath, 'worktree', 'add', worktreePath, '-b', branch],
      { encoding: 'utf8' }
    )
  } else {
    await execFile('git', ['-C', projectPath, 'worktree', 'add', worktreePath, '-b', branch], {
      encoding: 'utf8'
    })
  }

  logger.info('worktree: created', { worktreePath, branch })
  return worktreePath
}

/**
 * Removes a session's git worktree and its branch.
 *
 * Walks up from `worktreePath` to find the main repo root (skips the
 * `.gardenia/worktrees/<id>` path segments). For remote sessions, git
 * commands are run via `ssh <hostname>` — the local `existsSync` check is
 * skipped since the path lives on the remote host. Errors from either git
 * call are swallowed and logged — a failed cleanup must never block session
 * deletion.
 */
export async function removeWorktree(worktreePath: string, sessionId: string, hostname?: string): Promise<void> {
  if (!hostname && !existsSync(worktreePath)) {
    logger.info('worktree: path does not exist, skipping removal', { worktreePath })
    return
  }

  // Derive the main repo root: go up 3 levels from
  // `<project>/.gardenia/worktrees/<sessionId>`.
  const projectPath = dirname(dirname(dirname(worktreePath)))
  const branch = `gardenia-${sessionId.slice(0, 8)}`

  logger.info('worktree: removing', { worktreePath, projectPath, branch, hostname })

  if (hostname) {
    try {
      await execFile('ssh', [hostname, 'git', 'worktree', 'remove', worktreePath, '--force'], {
        encoding: 'utf8'
      })
    } catch (err) {
      logger.warn('worktree: remote git worktree remove failed (ignored)', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    try {
      await execFile('ssh', [hostname, 'git', '-C', projectPath, 'branch', '-D', branch], {
        encoding: 'utf8'
      })
    } catch (err) {
      logger.warn('worktree: remote git branch -D failed (ignored)', {
        branch,
        projectPath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  } else {
    try {
      await execFile('git', ['worktree', 'remove', worktreePath, '--force'], { encoding: 'utf8' })
    } catch (err) {
      logger.warn('worktree: git worktree remove failed (ignored)', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    try {
      await execFile('git', ['-C', projectPath, 'branch', '-D', branch], { encoding: 'utf8' })
    } catch (err) {
      logger.warn('worktree: git branch -D failed (ignored)', {
        branch,
        projectPath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  logger.info('worktree: removal complete', { worktreePath, branch })
}
