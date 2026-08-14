/**
 * Shared SSH invocation for every main-process path that talks to devpod hosts
 * (terminal mux, files panel, git panel, worktree setup). ControlMaster reuse
 * matches pty.ts: first connect pays full handshake; later calls on the same
 * host reuse /tmp/atelier-ssh-%C (~5ms). ControlPersist=yes keeps the master
 * open for background files/diff/git refresh for the app lifetime.
 */
import { execFile } from 'node:child_process'
import { logger } from './logger'

/** OpenSSH multiplexing — keep in sync with pty.ts (interactive SSH must not set BatchMode). */
export const SSH_MUX_OPTS = [
  '-o',
  'ControlMaster=auto',
  '-o',
  'ControlPath=/tmp/atelier-ssh-%C',
  '-o',
  'ControlPersist=yes'
]

/** Non-interactive remote exec (git, files, worktree): fail fast, accept-new host keys. */
export const SSH_REMOTE_OPTS = [
  ...SSH_MUX_OPTS,
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new'
]

export type ExecResult = { stdout: string; stderr: string; code: number }

/** Hosts with an established ControlMaster socket — skip redundant warm probes. */
const muxReadyHosts = new Set<string>()
/** Dedupes concurrent warm attempts so a burst of parallel ssh calls shares one handshake. */
const muxWarmInFlight = new Map<string, Promise<void>>()

/** Kill hung remote git/file ops instead of leaving the Diff panel on "Loading diff…" forever. */
const SSH_EXEC_TIMEOUT_MS = 90_000

function sshExecRaw(sshHost: string, remoteCmd: string, maxBuffer = 1024 * 1024 * 32): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      'ssh',
      [...SSH_REMOTE_OPTS, sshHost, '--', remoteCmd],
      { maxBuffer, timeout: SSH_EXEC_TIMEOUT_MS, killSignal: 'SIGTERM' },
      (err, stdout, stderr) => {
        const errno = err as NodeJS.ErrnoException & { code?: number | string }
        if (errno?.code === 'ETIMEDOUT') {
          logger.warn('ssh exec timed out', { sshHost, remoteCmd: remoteCmd.slice(0, 120) })
          resolve({ stdout: '', stderr: stderr || 'ssh timed out', code: 124 })
          return
        }
        const code = typeof errno?.code === 'number' ? errno.code : err ? 1 : 0
        resolve({ stdout, stderr, code })
      }
    )
  })
}

export async function sshExec(sshHost: string, remoteCmd: string, maxBuffer = 1024 * 1024 * 32): Promise<ExecResult> {
  await warmSshMux(sshHost)
  return sshExecRaw(sshHost, remoteCmd, maxBuffer)
}

/**
 * Establishes (or reuses) the ControlMaster socket for a host without running user commands.
 * Concurrent callers for the same host share one in-flight warm — without this, opening a
 * remote session fans out dozens of parallel ssh connections, each spawning a ussh proxy.
 */
export async function warmSshMux(sshHost: string): Promise<void> {
  if (muxReadyHosts.has(sshHost)) return

  let inflight = muxWarmInFlight.get(sshHost)
  if (!inflight) {
    inflight = (async () => {
      const res = await sshExecRaw(sshHost, 'true')
      if (res.code === 0) {
        muxReadyHosts.add(sshHost)
      } else {
        logger.warn('ssh mux warm failed', { sshHost, stderr: res.stderr.trim().slice(0, 200) })
      }
    })().finally(() => {
      muxWarmInFlight.delete(sshHost)
    })
    muxWarmInFlight.set(sshHost, inflight)
  }

  return inflight
}
