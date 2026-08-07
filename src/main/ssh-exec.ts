/**
 * Shared SSH invocation for every main-process path that talks to devpod hosts
 * (terminal mux, files panel, git panel, worktree setup). ControlMaster reuse
 * matches pty.ts: first connect pays full handshake; later calls on the same
 * host reuse /tmp/atelier-ssh-%C (~5ms).
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
  'ControlPersist=300'
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

export function sshExec(sshHost: string, remoteCmd: string, maxBuffer = 1024 * 1024 * 32): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('ssh', [...SSH_REMOTE_OPTS, sshHost, '--', remoteCmd], { maxBuffer }, (err, stdout, stderr) => {
      const code = (err as NodeJS.ErrnoException & { code?: number })?.code
      resolve({ stdout, stderr, code: typeof code === 'number' ? code : err ? 1 : 0 })
    })
  })
}

/** Establishes (or reuses) the ControlMaster socket for a host without running user commands. */
export async function warmSshMux(sshHost: string): Promise<void> {
  const res = await sshExec(sshHost, 'true')
  if (res.code !== 0) {
    logger.warn('ssh mux warm failed', { sshHost, stderr: res.stderr.trim().slice(0, 200) })
  }
}
