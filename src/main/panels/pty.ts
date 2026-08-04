/**
 * Real pty-backed terminals (07-secondary-panels §5): both the
 * creation-time "Terminal-only" session mode (a plain login shell, no agent)
 * and the in-session companion terminal drawer are backed by this same
 * manager — each gets its own real `node-pty` process keyed by an opaque id
 * chosen by the caller (e.g. the session id for terminal-only mode, or
 * `${sessionId}:companion` for the drawer), so they're genuinely independent
 * shells that never share state.
 *
 * For remote/devpod sessions the pty spawns `ssh <host>` as a real
 * interactive login shell on the remote box instead of a local shell.
 */
import * as pty from 'node-pty'
import type { BrowserWindow } from 'electron'
import { logger } from '../logger'

interface PtyEntry {
  proc: pty.IPty
  gen: number
}

export class PtyManager {
  private readonly ptys = new Map<string, PtyEntry>()
  private genCounter = 0

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  spawn(id: string, opts: { cwd: string; hostname?: string | null; cols: number; rows: number }): void {
    this.kill(id)

    const isRemote = Boolean(opts.hostname)
    const shell = isRemote ? 'ssh' : process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')
    const args = isRemote ? [opts.hostname as string] : []
    const gen = ++this.genCounter

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

    // Local (non-remote) shells: cd into the project directory explicitly in
    // case the pty's own `cwd` option didn't take (e.g. remote shells have
    // no local cwd concept at all), then clear the screen so the terminal
    // starts on a clean prompt.
    if (!isRemote) {
      proc.write(`cd ${JSON.stringify(opts.cwd)} && clear\r`)
    }

    this.ptys.set(id, { proc, gen })
    logger.info('pty spawned', { id, shell, remote: isRemote, cwd: opts.cwd, gen })
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
    try {
      entry.proc.kill()
    } catch {
      // already dead
    }
    this.ptys.delete(id)
  }

  isAlive(id: string): boolean {
    return this.ptys.has(id)
  }

  /** Kills every live pty — called on app shutdown so real shell child processes never keep the app process alive (they hold ref'd libuv handles otherwise). */
  killAll(): void {
    for (const id of [...this.ptys.keys()]) this.kill(id)
  }
}
