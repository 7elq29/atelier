/**
 * shell-pool.ts — Pre-warmed tmux sessions for instant local terminal creation.
 *
 * Maintains a pool of 2 ready-to-use tmux sessions. When a new terminal session
 * is created and no existing tmux session is found, spawn() claims one from the
 * pool (tmux rename-session, ~0ms) instead of running tmux new-session + waiting
 * for the shell to boot (~1s). replenish() refills the pool in the background.
 *
 * Pool sessions are named `gardenia-pool-<hex>` and start in the user's home
 * directory. After claiming, the caller writes `cd <cwd> && clear` to the pty
 * to navigate to the real project directory.
 */

import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { logger } from '../logger'

const execFileAsync = promisify(execFile)
const POOL_SIZE = 2
export const POOL_PREFIX = 'gardenia-pool-'

interface PoolShell {
  name: string
  status: 'warming' | 'ready'
}

export class ShellPoolManager {
  private shells: PoolShell[] = []
  private replenishing = false

  constructor(private readonly tmuxBin: string) {
    this.replenish()
  }

  /**
   * Claim a pre-warmed session. Returns the tmux session name, or null if the
   * pool is empty (caller must fall back to tmux new-session).
   */
  claim(): string | null {
    const idx = this.shells.findIndex((s) => s.status === 'ready')
    if (idx === -1) return null
    const shell = this.shells[idx]!
    this.shells.splice(idx, 1)
    logger.info('shell-pool: claimed', { name: shell.name, remaining: this.shells.filter((s) => s.status === 'ready').length })
    return shell.name
  }

  /**
   * Rename a claimed pool session to the real session name.
   * Call this immediately after claim() before attaching the pty.
   */
  async rename(poolName: string, realName: string): Promise<void> {
    await execFileAsync(this.tmuxBin, ['rename-session', '-t', poolName, realName])
  }

  /**
   * Refill the pool up to POOL_SIZE. Fire-and-forget — never blocks the caller.
   * Deduplicates: only one replenish runs at a time.
   */
  replenish(): void {
    if (this.replenishing) return
    const readyCount = this.shells.filter((s) => s.status === 'ready').length
    const warmingCount = this.shells.filter((s) => s.status === 'warming').length
    if (readyCount + warmingCount >= POOL_SIZE) return

    this.replenishing = true
    const deficit = POOL_SIZE - readyCount - warmingCount
    Promise.all(Array.from({ length: deficit }, () => this.warmOne()))
      .catch((err) => logger.warn('shell-pool: replenish failed', { error: String(err) }))
      .finally(() => { this.replenishing = false })
  }

  private async warmOne(): Promise<void> {
    const id = randomBytes(4).toString('hex')
    const name = `${POOL_PREFIX}${id}`
    const shell: PoolShell = { name, status: 'warming' }
    this.shells.push(shell)
    try {
      await execFileAsync(this.tmuxBin, ['new-session', '-d', '-s', name, '-c', homedir()])
      shell.status = 'ready'
      logger.info('shell-pool: warm shell ready', { name })
    } catch (err) {
      this.shells = this.shells.filter((s) => s !== shell)
      execFileAsync(this.tmuxBin, ['kill-session', '-t', name]).catch(() => {})
      logger.warn('shell-pool: warm-up failed', { name, error: String(err) })
    }
  }

  /** Kill all pool sessions. Called on app shutdown. */
  cleanup(): void {
    for (const shell of this.shells) {
      try {
        execFileSync(this.tmuxBin, ['kill-session', '-t', shell.name], { stdio: 'ignore' })
      } catch { /* already gone */ }
    }
    this.shells = []
  }
}
