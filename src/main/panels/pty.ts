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
 * backed by a named tmux session (`atelier-<sanitized-id>`). The pty spawns
 * `tmux new-session -A -s <name>` which *attaches* if the session already
 * exists and *creates* it otherwise. This means closing Atelier (which kills
 * the pty client) leaves the tmux session alive on the tmux server, and
 * reopening Atelier reattaches to the same session — running processes,
 * shell history and working directory are all preserved. If tmux is not
 * installed the code falls back transparently to the original plain shell.
 *
 * For remote/devpod sessions the pty spawns `ssh <host>` as a real
 * interactive login shell on the remote box instead of a local shell.
 */
import * as pty from 'node-pty'
import { execFileSync, execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import { logger } from '../logger'
import { SSH_MUX_OPTS } from '../ssh-exec'
import { ensureUssh } from '../uber-auth'
import { ShellPoolManager } from './shell-pool'
import { hostname as osHostname } from 'node:os'
import { parseSshConnectionClosed, parseSshHostFromShellLine, inferShellHostFromPtyTail, localMachineHostLabels } from '../../shared/terminal-shell-context'

const execFileAsync = promisify(execFile)

// Detect tmux once at startup — avoids per-spawn overhead and lets us log a
// single clear warning when it's missing rather than one per spawn.
let tmuxBin: string | null = null
let shellPool: ShellPoolManager | null = null
try {
  tmuxBin = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  shellPool = new ShellPoolManager(tmuxBin)
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
  return `atelier-${sanitized}`.slice(0, 50)
}

/** posix_spawn requires an existing directory for the spawn-helper cwd argument. */
function resolveLocalPtyCwd(cwd: string): string {
  const expanded = cwd.trim().replace(/^~(?=\/|$)/, homedir())
  const abs = resolve(expanded || homedir())
  if (existsSync(abs)) return abs
  const fallback = resolve(process.cwd())
  if (existsSync(fallback)) {
    logger.warn('pty cwd missing, using fallback', { requested: cwd, abs, fallback })
    return fallback
  }
  return homedir()
}

/**
 * Turn on tmux's mouse reporting for one session.
 *
 * A tmux client owns xterm's alternate buffer, which has no scrollback of its
 * own, so xterm falls back to translating every wheel notch into ESC[A/ESC[B —
 * and zsh reads those as "walk the command history". With mouse reporting on,
 * tmux advertises mouse tracking, xterm forwards the wheel as mouse buttons
 * instead, and tmux's default WheelUpPane binding scrolls its own history via
 * `copy-mode -e` (which exits again when you scroll back to the bottom).
 *
 * Scoped to our own session (`-t`), never `-g`, so the user's other tmux
 * sessions and ~/.tmux.conf keep whatever they had.
 */
async function tmuxEnableMouse(runner: (args: string[]) => Promise<unknown>, sessionName: string): Promise<void> {
  try {
    await runner(['set-option', '-t', sessionName, 'mouse', 'on'])
    logger.info('pty spawn: tmux mouse reporting enabled', { name: sessionName })
  } catch (err) {
    logger.warn('pty spawn: could not enable tmux mouse reporting', { name: sessionName, error: String(err) })
  }
  try {
    await runner(['set-option', '-t', sessionName, 'status', 'off'])
  } catch {
    // Non-fatal — status bar will still show but doesn't break anything.
  }
}

/** Run a one-line shell script in a detached tmux pane before the user attaches. */
async function tmuxSendSilentCommand(tmuxBin: string, sessionName: string, script: string): Promise<void> {
  const line = `stty -echo 2>/dev/null; ${script}; stty echo 2>/dev/null`
  await execFileAsync(tmuxBin, ['send-keys', '-t', sessionName, line, 'Enter'])
  // Let cd/clear finish before attach paints the pane.
  await new Promise((resolve) => setTimeout(resolve, 120))
}

interface PtyEntry {
  proc: pty.IPty
  gen: number
  tmuxName?: string
  /** SSH hostname for remote/devpod sessions that use tmux — needed by kill() to SSH in and detach. */
  hostname?: string
  /** Local shells: tracks nested `ssh` from the user's shell (sidebar "Local" vs host label). */
  shellRemoteHost: string | null
  inputLineBuffer: string
  /** Rolling PTY output for prompt-based host detection (local shells only). */
  outputTail: string
  localHostLabels: string[]
}

export class PtyManager {
  private readonly ptys = new Map<string, PtyEntry>()
  private genCounter = 0
  /** Tracks in-flight spawn promises so concurrent calls for the same id are deduplicated. */
  private readonly spawnInFlight = new Map<string, Promise<void>>()

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private emitShellContext(id: string, remoteHost: string | null): void {
    this.getWindow()?.webContents.send('pty:shellContext', { id, remoteHost })
  }

  private setShellContext(entry: PtyEntry, id: string, remoteHost: string | null): void {
    if (entry.shellRemoteHost === remoteHost) return
    entry.shellRemoteHost = remoteHost
    this.emitShellContext(id, remoteHost)
  }

  private applyInferredShellHost(entry: PtyEntry, id: string): void {
    const inferred = inferShellHostFromPtyTail(entry.outputTail, entry.localHostLabels)
    if (inferred === undefined) return
    if (inferred !== entry.shellRemoteHost) {
      this.setShellContext(entry, id, inferred)
    }
  }

  private appendInputChars(entry: PtyEntry, id: string, data: string): void {
    let i = 0
    while (i < data.length) {
      const ch = data[i]
      if (ch === '\x1b' && i + 1 < data.length && data[i + 1] === '[') {
        i += 2
        while (i < data.length && !/[A-Za-z~]/.test(data[i])) i++
        if (i < data.length) i++
        continue
      }
      if (ch === '\r' || ch === '\n') {
        const host = parseSshHostFromShellLine(entry.inputLineBuffer)
        entry.inputLineBuffer = ''
        if (host) this.setShellContext(entry, id, host)
      } else if (ch === '\u007f' || ch === '\b') {
        entry.inputLineBuffer = entry.inputLineBuffer.slice(0, -1)
      } else if (ch >= ' ' || ch === '\t') {
        entry.inputLineBuffer += ch
        if (entry.inputLineBuffer.length > 512) {
          entry.inputLineBuffer = entry.inputLineBuffer.slice(-512)
        }
      }
      i++
    }
  }

  async spawn(id: string, opts: { cwd: string; hostname?: string | null; cols: number; rows: number }): Promise<void> {
    // Deduplicate concurrent spawn calls for the same id. Without this guard
    // two near-simultaneous IPC messages (e.g. from React StrictMode double-mount
    // or a session open that triggers multiple renderer effects) both complete the
    // full async SSH/tmux handshake independently, leaving two SSH connections
    // attached to the same remote tmux pane and one immediately orphaned.
    const existing = this.spawnInFlight.get(id)
    if (existing) return existing

    const promise = this._doSpawn(id, opts)
    this.spawnInFlight.set(id, promise)
    void promise.finally(() => {
      if (this.spawnInFlight.get(id) === promise) this.spawnInFlight.delete(id)
    })
    return promise
  }

  private async _doSpawn(id: string, opts: { cwd: string; hostname?: string | null; cols: number; rows: number }): Promise<void> {
    this.kill(id)
    const t0 = Date.now()
    const elapsed = (): number => Date.now() - t0

    const isRemote = Boolean(opts.hostname)
    // Sub-pane ptys (id contains ':sp-') are ephemeral splits — they don't need
    // tmux persistence and MUST NOT share a session name with the base terminal
    // (tmuxSessionName truncates to 50 chars, so ':tab-terminal' and
    // ':tab-terminal:sp-xxx' would collide → same content, original detaches).
    const isSubPane = id.includes(':sp-')
    const useTmux = !isRemote && !isSubPane && tmuxBin !== null
    const localCwd = isRemote ? opts.cwd : resolveLocalPtyCwd(opts.cwd)

    let shell: string
    let args: string[]
    // Accumulated for the PtyEntry written after spawn — set in each branch below.
    let entryTmuxName: string | undefined
    let entryHostname: string | undefined

    logger.info('pty spawn: start', { id, isRemote, useTmux, cwd: opts.cwd })

    if (isRemote) {
      await ensureUssh()
    }

    if (useTmux) {
      const name = tmuxSessionName(id)
      logger.info('pty spawn: tmux has-session check', { id, name, elapsedMs: elapsed() })
      // Ensure the session exists as a detached session first. Using
      // `new-session -d` (not `new-session -A`) separates creation from
      // attachment: the session is created once, with the correct cwd, and
      // thereafter survives client disconnects without restarting the shell.
      // The `has-session` guard prevents resetting the cwd on reattach.
      try {
        await execFileAsync(tmuxBin!, ['has-session', '-t', name])
        logger.info('pty spawn: tmux session exists, attaching', { id, name, elapsedMs: elapsed() })
      } catch {
        // Session doesn't exist — try pool first, fall back to fresh new-session.
        const poolName = shellPool?.claim() ?? null
        if (poolName !== null) {
          logger.info('pty spawn: claiming from pool', { id, name, poolName, elapsedMs: elapsed() })
          await execFileAsync(tmuxBin!, ['rename-session', '-t', poolName, name])
          await tmuxSendSilentCommand(
            tmuxBin!,
            name,
            `cd ${JSON.stringify(localCwd)} && clear`
          )
          shellPool!.replenish()
          logger.info('pty spawn: pool claim complete', { id, name, elapsedMs: elapsed() })
        } else {
          // Pool empty — create fresh session.
          logger.info('pty spawn: tmux session not found, creating', { id, name, elapsedMs: elapsed() })
          await execFileAsync(tmuxBin!, [
            'new-session', '-d', '-s', name,
            '-x', String(Math.max(opts.cols || 80, 2)),
            '-y', String(Math.max(opts.rows || 24, 2)),
            '-c', localCwd
          ])
          logger.info('pty spawn: tmux session created', { id, name, elapsedMs: elapsed() })
        }
      }
      await tmuxEnableMouse((tmuxArgs) => execFileAsync(tmuxBin!, tmuxArgs), name)
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
      // 10 s timeout per SSH command prevents an unreachable host from blocking
      // the IPC handler — the renderer awaits this promise before proceeding.
      const SSH_TIMEOUT = 10_000
      try {
        try {
          await execFileAsync('ssh', [...SSH_MUX_OPTS, hostname, 'tmux', 'has-session', '-t', name], { timeout: SSH_TIMEOUT })
          logger.info('pty spawn: remote tmux session exists, attaching', { id, hostname, name, elapsedMs: elapsed() })
        } catch {
          // Session doesn't exist (or tmux unavailable) — try to create it.
          // If tmux is not installed this also throws, caught by the outer catch.
          logger.info('pty spawn: remote tmux session not found, creating', { id, hostname, name, elapsedMs: elapsed() })
          await execFileAsync('ssh', [...SSH_MUX_OPTS, hostname, 'tmux', 'new-session', '-d', '-s', name,
            '-x', String(Math.max(opts.cols || 80, 2)),
            '-y', String(Math.max(opts.rows || 24, 2)),
            '-c', opts.cwd ?? '$HOME'
          ], { timeout: SSH_TIMEOUT })
          logger.info('pty spawn: remote tmux session created', { id, hostname, name, elapsedMs: elapsed() })
        }
        await tmuxEnableMouse(
          (tmuxArgs) => execFileAsync('ssh', [...SSH_MUX_OPTS, hostname, 'tmux', ...tmuxArgs], { timeout: SSH_TIMEOUT }),
          name
        )
        // `-t` allocates a PTY for the SSH connection so tmux attach gets a
        // real terminal; without it the attach output is garbled.
        shell = 'ssh'
        args = [...SSH_MUX_OPTS, hostname, '-t', 'tmux', 'attach-session', '-t', name]
        entryTmuxName = name
        entryHostname = hostname
        logger.info('pty spawn: remote tmux ready', { hostname, name, elapsedMs: elapsed() })
      } catch (err) {
        // tmux not installed on the devpod — fall back to a plain interactive
        // SSH session (no persistence across disconnects).
        logger.warn('remote tmux not available — falling back to plain ssh', { hostname, error: String(err) })
        shell = 'ssh'
        args = [...SSH_MUX_OPTS, hostname]
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
      cwd: isRemote ? undefined : localCwd,
      env: process.env as Record<string, string>
    })

    const initialShellHost = isRemote ? (opts.hostname as string) : null
    const entry: PtyEntry = {
      proc,
      gen,
      tmuxName: entryTmuxName,
      hostname: entryHostname,
      shellRemoteHost: initialShellHost,
      inputLineBuffer: '',
      outputTail: '',
      localHostLabels: isRemote ? [] : localMachineHostLabels(osHostname())
    }
    this.ptys.set(id, entry)
    this.emitShellContext(id, initialShellHost)

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
      if (current.hostname) return
      current.outputTail = (current.outputTail + data).slice(-8192)
      if (parseSshConnectionClosed(data)) {
        this.setShellContext(current, id, null)
      } else {
        this.applyInferredShellHost(current, id)
      }
    })
    proc.onExit(({ exitCode }) => {
      if (this.ptys.get(id)?.proc !== proc) return
      logger.info('pty exited', { id, exitCode, gen })
      this.getWindow()?.webContents.send('pty:exit', { id, exitCode })
      this.ptys.delete(id)
    })

    // No post-spawn startup commands. Plain local shells already spawn in
    // localCwd; fresh tmux sessions use `new-session -c`; pool claims cd/clear
    // in the detached pane via tmux send-keys before attach; reattach preserves
    // the user's existing shell state intentionally.

    logger.info('pty spawned', { id, shell, remote: isRemote, tmux: Boolean(entryTmuxName), cwd: opts.cwd, gen, totalElapsedMs: elapsed() })

    if (!isRemote) {
      setTimeout(() => {
        const live = this.ptys.get(id)
        if (live?.proc !== proc) return
        this.applyInferredShellHost(live, id)
      }, 400)
    }
  }

  write(id: string, data: string): void {
    const entry = this.ptys.get(id)
    if (!entry) return
    entry.proc.write(data)
    if (entry.hostname) return
    this.appendInputChars(entry, id, data)
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
          execFileSync('ssh', [...SSH_MUX_OPTS, entry.hostname, 'tmux', 'detach-client', '-s', entry.tmuxName], { stdio: 'ignore' })
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
    // so Atelier can reattach next time it opens. Use killTmuxSession() when
    // the Atelier session is permanently deleted by the user.
  }

  /**
   * Kill the backing tmux server session for this pty id.
   * Call this when the Atelier session is permanently deleted — not merely
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
    shellPool?.cleanup()
  }

  /**
   * Kill every local `atelier-*` tmux session whose name does NOT start with
   * any of the given live session-id prefixes. Call once at startup after the
   * session list is loaded to evict sessions left over from previous runs or
   * app crashes. No-op if tmux is not installed.
   */
  pruneOrphanedTmuxSessions(liveSessionIds: string[]): void {
    if (!tmuxBin) return
    let allSessions: string
    try {
      allSessions = execFileSync(tmuxBin, ['list-sessions', '-F', '#{session_name}'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return // tmux server not running — nothing to prune
    }
    const prefixes = liveSessionIds.map((id) => `atelier-${id.slice(0, 8)}`)
    for (const name of allSessions.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (!name.startsWith('atelier-')) continue
      if (name.startsWith('atelier-pool-') || name.startsWith('atelier-e2e-')) continue
      const isLive = prefixes.some((p) => name.startsWith(p))
      if (!isLive) {
        try {
          execFileSync(tmuxBin, ['kill-session', '-t', name], { stdio: 'ignore' })
          logger.info('tmux orphaned session pruned', { name })
        } catch { /* already gone */ }
      }
    }
  }
}
