/**
 * Git worktree helpers for isolated session workspaces (use-worktree).
 *
 * Each claude-code session created with "Use worktree" gets its own git
 * worktree at `<project>/.atelier/worktrees/<sessionId>` on a fresh branch
 * `atelier-<sessionId-prefix>`. Claude Code runs inside that path instead of
 * the main project root, so its file edits never touch the original working
 * tree. The worktree and its branch are cleaned up when the session is
 * deleted.
 *
 * For remote (devpod) sessions, git commands are prefixed with
 * `ssh <hostname>` so they run on the remote host.
 */

import { execFile as _execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '../logger'
import { SSH_REMOTE_OPTS } from '../ssh-exec'

const execFile = promisify(_execFile)

/** Thrown by `createWorktree` when the git command fails. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeError'
  }
}

const SSH_GIT_OPTS = SSH_REMOTE_OPTS

/** 5 min timeout for all SSH git calls — worktree add on large repos can take several minutes. */
const SSH_EXEC_TIMEOUT_MS = 5 * 60_000

/** Parse an integer percentage from a `git worktree add` progress line (stderr). */
function parseGitProgress(text: string): number | null {
  const m = text.match(/(?:Updating|Checking out) files:\s+(\d+)%/)
  return m ? parseInt(m[1], 10) : null
}

/**
 * Run a command and call `onProgress(pct)` for each "Updating files: N%"
 * line on stderr. The command's combined stdout+stderr is collected and
 * included in the rejection reason on failure.
 */
function spawnWithProgress(
  cmd: string,
  args: string[],
  onProgress: ((pct: number) => void) | undefined,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let lastPct = -1

    const handleChunk = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8')
      output += text
      if (onProgress) {
        for (const part of text.split(/[\r\n]/)) {
          const pct = parseGitProgress(part)
          if (pct !== null && pct !== lastPct) {
            lastPct = pct
            onProgress(pct)
          }
        }
      }
    }

    child.stdout?.on('data', handleChunk)
    child.stderr?.on('data', handleChunk)

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`))
    }, timeoutMs)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Command failed (exit ${code}): ${cmd} ${args.slice(-6).join(' ')}\n${output.slice(-500)}`))
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
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
export async function createWorktree(
  projectPath: string,
  sessionId: string,
  hostname?: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  const worktreePath = join(projectPath, '.atelier', 'worktrees', sessionId)
  const branch = `atelier-${sessionId.slice(0, 8)}`

  logger.info('worktree: creating', { projectPath, worktreePath, branch, hostname })

  if (hostname) {
    await spawnWithProgress(
      'ssh',
      [...SSH_GIT_OPTS, hostname, 'git', '-C', projectPath, 'worktree', 'add', worktreePath, '-b', branch],
      onProgress,
      SSH_EXEC_TIMEOUT_MS
    )
    // Resolve the path to an absolute one — `worktreePath` may contain `~`
    // which git expands (through the SSH shell), but the harness cwd is used
    // as a raw path and may not expand `~` itself.
    const { stdout } = await execFile(
      'ssh', [...SSH_GIT_OPTS, hostname, 'realpath', worktreePath],
      { encoding: 'utf8', timeout: SSH_EXEC_TIMEOUT_MS }
    )
    const resolved = stdout.trim()
    logger.info('worktree: created', { worktreePath: resolved, branch })
    return resolved
  } else {
    await spawnWithProgress(
      'git',
      ['-C', projectPath, 'worktree', 'add', worktreePath, '-b', branch],
      onProgress,
      SSH_EXEC_TIMEOUT_MS
    )
    logger.info('worktree: created', { worktreePath, branch })
    return worktreePath
  }
}

/**
 * Removes a session's git worktree and its branch.
 *
 * Walks up from `worktreePath` to find the main repo root (skips the
 * `.atelier/worktrees/<id>` path segments). For remote sessions, git
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
  // `<project>/.atelier/worktrees/<sessionId>`.
  const projectPath = dirname(dirname(dirname(worktreePath)))
  const branch = `atelier-${sessionId.slice(0, 8)}`

  logger.info('worktree: removing', { worktreePath, projectPath, branch, hostname })

  if (hostname) {
    try {
      await execFile('ssh', [...SSH_GIT_OPTS, hostname, 'git', 'worktree', 'remove', worktreePath, '--force'], {
        encoding: 'utf8', timeout: SSH_EXEC_TIMEOUT_MS
      })
    } catch (err) {
      logger.warn('worktree: remote git worktree remove failed (ignored)', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    try {
      await execFile('ssh', [...SSH_GIT_OPTS, hostname, 'git', '-C', projectPath, 'branch', '-D', branch], {
        encoding: 'utf8', timeout: SSH_EXEC_TIMEOUT_MS
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
