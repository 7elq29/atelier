/**
 * Git worktree helpers for isolated session workspaces (use-worktree).
 *
 * Each claude-code session created with "Use worktree" gets its own git
 * worktree at `<worktreeRoot>/<sessionId>` (default `~/.atelier/worktrees/<id>`)
 * on a fresh branch `atelier-<sessionId-prefix>`. Claude Code runs inside
 * that path instead of the main project root. The worktree and its branch
 * are cleaned up when the session is deleted (Close keeps the worktree so
 * Resume/Reconnect can return to the same checkout).
 *
 * For remote (devpod) sessions, git commands run over SSH using the same
 * `cd $HOME/... && git …` shell pattern as git-core (tilde paths must not
 * be passed raw to `git -C`).
 */

import { execFile as _execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '../logger'
import { SSH_REMOTE_OPTS } from '../ssh-exec'
import { remoteCdTarget, shQuote } from '../shell-quote'
import { sessionWorktreePath } from '../../shared/worktree-path'
import { expandTildePath } from '../../shared/project-path-autocomplete'

const execFile = promisify(_execFile)

/** Thrown by `createWorktree` when the git command fails. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeError'
  }
}

const SSH_GIT_OPTS = SSH_REMOTE_OPTS

/** Short timeout for quick SSH git helpers (mkdir, remove, realpath). Worktree creation has no timeout. */
const SSH_QUICK_TIMEOUT_MS = 5 * 60_000

/** Parse an integer percentage from a `git worktree add` progress line (stderr). */
function parseGitProgress(text: string): number | null {
  const m = text.match(/(?:Updating|Checking out) files:\s+(\d+)%/)
  return m ? parseInt(m[1], 10) : null
}

function resolveRepoPath(projectPath: string, homeDir: string): string {
  return expandTildePath(projectPath, homeDir)
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
  timeoutMs?: number
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

    const timer =
      timeoutMs != null && timeoutMs > 0
        ? setTimeout(() => {
            child.kill()
            reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd} ${args.join(' ')}`))
          }, timeoutMs)
        : undefined

    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Command failed (exit ${code}): ${cmd} ${args.slice(-6).join(' ')}\n${output.slice(-500)}`))
    })

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      reject(err)
    })
  })
}

async function ensureWorktreeRootExists(worktreeRoot: string, homeDir: string, hostname?: string): Promise<void> {
  const absRoot = expandTildePath(worktreeRoot, homeDir)
  if (hostname) {
    const remoteCmd = `mkdir -p ${remoteCdTarget(absRoot)}`
    await execFile('ssh', [...SSH_GIT_OPTS, hostname, '--', remoteCmd], {
      encoding: 'utf8',
      timeout: SSH_QUICK_TIMEOUT_MS
    })
  } else {
    mkdirSync(absRoot, { recursive: true })
  }
}

/**
 * Creates a git worktree for a session.
 *
 * For local sessions: runs `git -C <projectPath> worktree add <worktreePath> -b <branch>`.
 * For remote sessions: runs `ssh <hostname> 'cd … && git worktree add …'`.
 * Returns the absolute worktree path on success.
 * Throws `WorktreeError` if `git worktree add` fails — callers should surface
 * this as a user-visible error.
 */
export async function createWorktree(
  projectPath: string,
  sessionId: string,
  worktreeRoot: string,
  homeDir: string,
  hostname?: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  await ensureWorktreeRootExists(worktreeRoot, homeDir, hostname)
  const worktreePath = sessionWorktreePath(worktreeRoot, sessionId, homeDir)
  const branch = `atelier-${sessionId.slice(0, 8)}`
  const repoPath = resolveRepoPath(projectPath, homeDir)

  logger.info('worktree: creating', { projectPath, repoPath, worktreePath, branch, worktreeRoot, hostname })

  if (hostname) {
    const remoteCmd = `cd ${remoteCdTarget(repoPath)} && git worktree add ${shQuote(worktreePath)} -b ${shQuote(branch)}`
    await spawnWithProgress('ssh', [...SSH_GIT_OPTS, hostname, '--', remoteCmd], onProgress)
    const { stdout } = await execFile(
      'ssh',
      [...SSH_GIT_OPTS, hostname, '--', `realpath ${shQuote(worktreePath)}`],
      { encoding: 'utf8', timeout: SSH_QUICK_TIMEOUT_MS }
    )
    const resolved = stdout.trim()
    logger.info('worktree: created', { worktreePath: resolved, branch })
    return resolved
  } else {
    mkdirSync(dirname(worktreePath), { recursive: true })
    await spawnWithProgress(
      'git',
      ['-C', repoPath, 'worktree', 'add', worktreePath, '-b', branch],
      onProgress
    )
    logger.info('worktree: created', { worktreePath, branch })
    return worktreePath
  }
}

/**
 * Removes a session's git worktree and its branch.
 *
 * `projectPath` is the main git repo the worktree was created from. Errors
 * from either git call are swallowed and logged — cleanup must never block
 * session deletion.
 */
export async function removeWorktree(
  worktreePath: string,
  sessionId: string,
  projectPath: string,
  homeDir: string,
  hostname?: string
): Promise<void> {
  if (!hostname && !existsSync(worktreePath)) {
    logger.info('worktree: path does not exist, skipping removal', { worktreePath })
    return
  }

  const branch = `atelier-${sessionId.slice(0, 8)}`
  const repoPath = resolveRepoPath(projectPath, homeDir)

  logger.info('worktree: removing', { worktreePath, projectPath, repoPath, branch, hostname })

  if (hostname) {
    try {
      const remoteCmd = `cd ${remoteCdTarget(repoPath)} && git worktree remove ${shQuote(worktreePath)} --force`
      await execFile('ssh', [...SSH_GIT_OPTS, hostname, '--', remoteCmd], {
        encoding: 'utf8',
        timeout: SSH_QUICK_TIMEOUT_MS
      })
    } catch (err) {
      logger.warn('worktree: remote git worktree remove failed (ignored)', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    try {
      const remoteCmd = `cd ${remoteCdTarget(repoPath)} && git branch -D ${shQuote(branch)}`
      await execFile('ssh', [...SSH_GIT_OPTS, hostname, '--', remoteCmd], {
        encoding: 'utf8',
        timeout: SSH_QUICK_TIMEOUT_MS
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
      await execFile('git', ['-C', repoPath, 'worktree', 'remove', worktreePath, '--force'], { encoding: 'utf8' })
    } catch (err) {
      logger.warn('worktree: git worktree remove failed (ignored)', {
        worktreePath,
        error: err instanceof Error ? err.message : String(err)
      })
    }
    try {
      await execFile('git', ['-C', repoPath, 'branch', '-D', branch], { encoding: 'utf8' })
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

/** Whether a session worktree checkout directory still exists (local or remote). */
export async function worktreePathExists(worktreePath: string, hostname?: string): Promise<boolean> {
  if (!hostname) return existsSync(worktreePath)
  try {
    await execFile(
      'ssh',
      [...SSH_GIT_OPTS, hostname, '--', `test -d ${shQuote(worktreePath)}`],
      { encoding: 'utf8', timeout: SSH_QUICK_TIMEOUT_MS }
    )
    return true
  } catch {
    return false
  }
}
