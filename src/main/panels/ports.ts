/**
 * Real SSH local port forwards for the Ports panel (07-secondary-panels
 * §6, remote sessions only). Spawns an actual `ssh -N -L <local>:<remoteHost>:<remotePort> <sshHost>`
 * child process per forward (independent of the session's own remote
 * connection) and confirms it's genuinely listening by attempting a real
 * TCP connect to the local port before reporting `active`.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { connect } from 'node:net'
import type { BrowserWindow } from 'electron'
import { logger } from '../logger'
import type { PortForward } from '../../shared/panel-types'

interface ForwardEntry {
  config: PortForward
  proc: ChildProcess
}

function probeLocalPortOnce(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

/**
 * Retries a real TCP connect against the forwarded local port until it
 * succeeds or `overallTimeoutMs` elapses. A single connect attempt isn't
 * enough here: before `ssh` has finished binding the local listener, a
 * connect on loopback fails immediately with ECONNREFUSED (no waiting), so
 * without retrying we'd give up within milliseconds of spawning the process
 * — long before ssh has actually established the tunnel.
 */
async function waitForLocalPort(port: number, overallTimeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + overallTimeoutMs
  while (Date.now() < deadline) {
    if (await probeLocalPortOnce(port, 500)) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
}

export class PortForwardManager {
  private readonly forwards = new Map<string, ForwardEntry>()

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private notify(): void {
    this.getWindow()?.webContents.send('ports:updated', this.list())
  }

  list(sessionId?: string): PortForward[] {
    const all = [...this.forwards.values()].map((e) => e.config)
    return sessionId ? all.filter((f) => f.sessionId === sessionId) : all
  }

  async add(sessionId: string, sshHost: string, localPort: number, remoteHost: string, remotePort: number): Promise<PortForward> {
    const id = `${sessionId}:${localPort}:${remoteHost}:${remotePort}:${Date.now()}`
    const config: PortForward = { id, sessionId, localPort, remoteHost, remotePort, status: 'connecting' }

    const proc = spawn(
      'ssh',
      ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-L', `${localPort}:${remoteHost}:${remotePort}`, sshHost],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )

    this.forwards.set(id, { config, proc })
    logger.info('port forward starting', { id, sshHost, localPort, remoteHost, remotePort })

    proc.stdout?.on('data', (chunk: Buffer) => {
      logger.info('ssh port-forward stdout', { id, line: chunk.toString().trim() })
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      logger.warn('ssh port-forward stderr', { id, line: chunk.toString().trim() })
    })
    proc.on('exit', (code) => {
      const entry = this.forwards.get(id)
      if (entry) {
        entry.config.status = 'error'
        entry.config.error = `ssh exited (code ${code})`
        this.notify()
      }
      logger.info('port forward process exited', { id, code })
    })

    // Give ssh time to authenticate and establish the tunnel, then verify
    // with a real (retried) local TCP connect rather than just trusting the
    // process didn't crash.
    const confirmed = await waitForLocalPort(localPort, 12_000)
    const entry = this.forwards.get(id)
    if (entry && entry.proc.exitCode === null) {
      entry.config.status = confirmed ? 'active' : 'error'
      if (!confirmed) entry.config.error = 'forward did not become reachable within timeout'
      this.notify()
    }
    return this.forwards.get(id)?.config ?? config
  }

  remove(id: string): void {
    const entry = this.forwards.get(id)
    if (!entry) return
    entry.proc.kill()
    this.forwards.delete(id)
    this.notify()
  }

  removeAllForSession(sessionId: string): void {
    for (const [id, entry] of this.forwards) {
      if (entry.config.sessionId === sessionId) {
        entry.proc.kill()
        this.forwards.delete(id)
      }
    }
  }

  /** Kills every real ssh forward process — called on app shutdown for the same reason as PtyManager.killAll. */
  killAll(): void {
    for (const [id, entry] of this.forwards) {
      entry.proc.kill()
      this.forwards.delete(id)
    }
  }
}
