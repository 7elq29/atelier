/**
 * Real pty-backed terminals (07-secondary-panels §5): both the
 * creation-time "Terminal-only" session mode (a plain login shell, no agent)
 * and the in-session companion terminal drawer are backed by this same
 * manager — each gets its own real `node-pty` process keyed by an opaque id
 * chosen by the caller (e.g. the session id for terminal-only mode, or
 * `${sessionId}:companion` for the drawer), so they're genuinely independent
 * shells that never share state.
 *
 * tmux session backing: when tmux is installed locally each terminal is
 * backed by a named tmux session (`gardenia-<sanitized-id>`). The pty spawns
 * `tmux new-session -A -s <name>` which *attaches* if the session already
 * exists and *creates* it otherwise. This means closing Gardenia (which kills
 * the pty client) leaves the tmux session alive on the tmux server, and
 * reopening Gardenia reattaches to the same session — running processes,
 * shell history and working directory are all preserved. If tmux is not
 * installed the code falls back transparently to the original plain shell.
 *
 * For remote/devpod sessions the pty spawns `ssh <host>` as a real
 * interactive login shell on the remote box instead of a local shell.
 */
import * as pty from 'node-pty'
import { execFileSync } from 'child_process'
import type { BrowserWindow } from 'electron'
import { logger } from '../logger'

// Detect tmux once at startup — avoids per-spawn overhead and lets us log a
// single clear warning when it's missing rather than one per spawn.
let tmuxBin: string | null = null
try {
  tmuxBin = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  logger.info('tmux available', { path: tmuxBin })
} catch {
  logger.warn('tmux not found — terminals will use a plain shell (no session persistence across restarts)')
}

/**
 * Derive a tmux-safe session name from a pty id.
 * tmux session names must not contain periods or colons; we restrict to
 * alphanumeric + dash and cap at 50 chars to stay well within any limit.
 */
function tmuxSessionName(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9-]/g, '-')
  return `gardenia-${sanitized}`.slice(0, 50)
}

interface PtyEntry {
  proc: pty.IPty
  gen: number
  tmuxName?: string
  /** SSH hostname for remote/devpod sessions that use tmux — needed by kill() to SSH in and detach. */
  hostname?: string
}

export class PtyManager {
  private readonly ptys = new Map<string, PtyEntry>()
  private genCounter = 0

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  spawn(id: string, opts: { cwd: string; hostname?: string | null; cols: number; rows: number }): void {
    this.kill(id)
    const t0 = Date.now()
    const elapsed = (): number => Date.now() - t0

    const isRemote = Boolean(opts.hostname)
    const useTmux = !isRemote && tmuxBin !== null

    let shell: string
    let args: string[]
    // Accumulated for the PtyEntry written after spawn — set in each branch below.
    let entryTmuxName: string | undefined
    let entryHostname: string | undefined

    logger.info('pty spawn: start', { id, isRemote, useTmux, cwd: opts.cwd })

    if (useTmux) {
      const name = tmuxSessionName(id)
      logger.info('pty spawn: tmux has-session check', { id, name, elapsedMs: elapsed() })
      // Ensure the session exists as a detached session first. Using
      // `new-session -d` (not `new-session -A`) separates creation from
      // attachment: the session is created once, with the correct cwd, and
      // thereafter survives client disconnects without restarting the shell.
      // The `has-session` guard prevents resetting the cwd on reattach.
      try {
        execFileSync(tmuxBin!, ['has-session', '-t', name], { stdio: 'ignore' })
        logger.info('pty spawn: tmux session exists, attaching', { id, name, elapsedMs: elapsed() })
      } catch {
        // Session doesn't exist — create it detached with the initial cwd.
        logger.info('pty spawn: tmux session not found, creating', { id, name, elapsedMs: elapsed() })
        execFileSync(tmuxBin!, [
          'new-session', '-d', '-s', name,
          '-x', String(Math.max(opts.cols || 80, 2)),
          '-y', String(Math.max(opts.rows || 24, 2)),
          '-c', opts.cwd
        ], { stdio: 'ignore' })
        logger.info('pty spawn: tmux session created', { id, name, elapsedMs: elapsed() })
      }
      // Attach to the (now-guaranteed) existing session. When this client
      // exits (node-pty closes), tmux simply detaches — no SIGHUP to the
      // shell, so the session and its processes survive.
      shell = tmuxBin!
      args = ['attach-session', '-t', name]
      entryTmuxName = name
    } else if (isRemote) {
      const hostname = opts.hostname as string
      const name = tmuxSessionName(id)
      logger.info('pty spawn: remote tmux has-session check', { id, hostname, name, elapsedMs: elapsed() })
      // Attempt to run tmux on the devpod via SSH so the remote shell session
      // survives SSH disconnection (app close/restart). Two-step identical to
      // the local tmux path: has-session? → if not, new-session -d → attach.
      // The outer try falls back to plain `ssh <host>` if tmux is not installed.
      try {
        try {
          execFileSync('ssh', [hostname, 'tmux', 'has-session', '-t', name], { stdio: 'ignore' })
          logger.info('pty spawn: remote tmux session exists, attaching', { id, hostname, name, elapsedMs: elapsed() })
        } catch {
          // Session doesn't exist (or tmux unavailable) — try to create it.
          // If tmux is not installed this also throws, caught by the outer catch.
          logger.info('pty spawn: remote tmux session not found, creating', { id, hostname, name, elapsedMs: elapsed() })
          execFileSync('ssh', [hostname, 'tmux', 'new-session', '-d', '-s', name,
            '-x', String(Math.max(opts.cols || 80, 2)),
            '-y', String(Math.max(opts.rows || 24, 2))
          ], { stdio: 'ignore' })
          logger.info('pty spawn: remote tmux session created', { id, hostname, name, elapsedMs: elapsed() })
        }
        // `-t` allocates a PTY for the SSH connection so tmux attach gets a
        // real terminal; without it the attach output is garbled.
        shell = 'ssh'
        args = [hostname, '-t', 'tmux', 'attach-session', '-t', name]
        entryTmuxName = name
        entryHostname = hostname
        logger.info('pty spawn: remote tmux ready', { hostname, name, elapsedMs: elapsed() })
      } catch (err) {
        // tmux not installed on the devpod — fall back to a plain interactive
        // SSH session (no persistence across disconnects).
        logger.warn('remote tmux not available — falling back to plain ssh', { hostname, error: String(err) })
        shell = 'ssh'
        args = [hostname]
      }
    } else {
      shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
      args = []
    }

    const gen = ++this.genCounter
    logger.info('pty spawn: node-pty.spawn starting', { id, shell, elapsedMs: elapsed() })

    const proc = pty.spawn(shell, args, {
      name: 'xterm-color',
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      cwd: isRemote ? undefined : opts.cwd,
      env: process.env as Record<string, string>
    })

    proc.onData((data) => {
      // A rapid kill+respawn under the same id (e.g. React StrictMode's
      // dev-only mount->cleanup->mount, which fires this exact sequence with
      // no await in between) can leave this `proc` still flushing buffered
      // output after it's been replaced in `this.ptys`. Without this check
      // that stale output keeps arriving tagged with `id`, corrupting
      // whatever the *new* process for that id is showing.
      const current = this.ptys.get(id)
      if (current?.proc !== proc) {
        logger.info('pty stale-data dropped', { id, gen, currentGen: current?.gen ?? null, bytes: data.length })
        return
      }
      this.getWindow()?.webContents.send('pty:data', { id, data })
    })
    proc.onExit(({ exitCode }) => {
      if (this.ptys.get(id)?.proc !== proc) return
      logger.info('pty exited', { id, exitCode, gen })
      this.getWindow()?.webContents.send('pty:exit', { id, exitCode })
      this.ptys.delete(id)
    })

    // Plain local shell (no tmux, no remote): navigate to cwd and clear so
    // the terminal starts on a clean prompt in the right directory.
    // With tmux, cwd is set via the -c flag above; we intentionally do NOT
    // cd+clear on reattach so the user's shell state is preserved.
    if (!isRemote && !useTmux) {
      proc.write(`cd ${JSON.stringify(opts.cwd)} && clear\r`)
    }

    this.ptys.set(id, { proc, gen, tmuxName: entryTmuxName, hostname: entryHostname })
    logger.info('pty spawned', { id, shell, remote: isRemote, tmux: Boolean(entryTmuxName), cwd: opts.cwd, gen, totalElapsedMs: elapsed() })
  }

  write(id: string, data: string): void {
    this.ptys.get(id)?.proc.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.ptys.get(id)?.proc.resize(Math.max(cols, 2), Math.max(rows, 2))
    } catch {
      // resize can race with process exit; harmless to ignore.
    }
  }

  kill(id: string): void {
    const entry = this.ptys.get(id)
    if (!entry) return
    this.ptys.delete(id)
    if (entry.tmuxName) {
      if (entry.hostname) {
        // Remote tmux: SSH in to detach the client from the remote tmux session.
        // This leaves the session alive on the devpod so the next spawn reattaches.
        try {
          execFileSync('ssh', [entry.hostname, 'tmux', 'detach-client', '-s', entry.tmuxName], { stdio: 'ignore' })
        } catch { /* session may already be detached or gone */ }
      } else if (tmuxBin) {
        // Local tmux: detach all clients from the session before closing the pty —
        // `proc.kill()` sends SIGTERM which can drag the session down. A proper
        // detach leaves the tmux server session alive so the next spawn reattaches.
        try {
          execFileSync(tmuxBin, ['detach-client', '-s', entry.tmuxName], { stdio: 'ignore' })
        } catch { /* session may already be detached or gone */ }
      }
    }
    try {
      entry.proc.kill()
    } catch {
      // already dead
    }
    // Intentionally does NOT kill the tmux server session — it must persist
    // so Gardenia can reattach next time it opens. Use killTmuxSession() when
    // the Gardenia session is permanently deleted by the user.
  }

  /**
   * Kill the backing tmux server session for this pty id.
   * Call this when the Gardenia session is permanently deleted — not merely
   * when the app closes. No-op if tmux is not installed or if the session
   * never existed (tmux exit code is ignored).
   */
  killTmuxSession(id: string): void {
    if (!tmuxBin) return
    const name = tmuxSessionName(id)
    try {
      execFileSync(tmuxBin, ['kill-session', '-t', name], { stdio: 'ignore' })
      logger.info('tmux session killed', { id, name })
    } catch {
      // Session may not exist — fine to ignore
    }
  }

  isAlive(id: string): boolean {
    return this.ptys.has(id)
  }

  /** Kills every live pty — called on app shutdown so real shell child processes never keep the app process alive (they hold ref'd libuv handles otherwise). */
  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
