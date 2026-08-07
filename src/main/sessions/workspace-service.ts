/**
 * Session workspace preload + background git refresh (Features/session-workspace-preload).
 * Runs in main: initial load before session:openReady; monitor while session is live.
 */
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { SessionRecord } from '../../shared/session-types'
import type { SessionWorkspacePayload } from '../../shared/session-workspace-types'
import type { DiffSummary } from '../../shared/panel-types'
import type { SessionChangesCap } from '../../shared/session-changes-cap'
import { sessionChangesCapSignature } from '../../shared/session-changes-cap'
import { getDiffSummary } from '../panels/git'
import { resolveGitRepoRoot } from '../panels/git-core'
import { walkFileTree, listWorkspaceFiles } from '../panels/files'
import type { PtyManager } from '../panels/pty'
import { logger } from '../logger'

export const DEVPOD_GIT_POLL_MS = 15_000
const LOCAL_GIT_DEBOUNCE_MS = 400
const DEFAULT_PTY_COLS = 80
const DEFAULT_PTY_ROWS = 24

function workspacePathFor(session: SessionRecord): string {
  return session.worktreePath ?? session.projectPath
}

function diffListSignature(diff: DiffSummary): string {
  if (!diff.isRepo) return 'not-repo'
  const branch = diff.branch ?? ''
  const files = diff.files.map((f) => `${f.path}:${f.additions}:${f.deletions}:${f.status}`).join('|')
  return `${branch}|${files}`
}

export class WorkspaceService {
  private readonly cache = new Map<string, SessionWorkspacePayload>()
  private readonly monitors = new Map<string, { stop: () => void }>()
  private ptyManager: PtyManager | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly buildSessionChangesCap: (
      sessionId: string,
      opts?: { processHead?: boolean }
    ) => Promise<SessionChangesCap>
  ) {}

  setPtyManager(pty: PtyManager): void {
    this.ptyManager = pty
  }

  getCached(sessionId: string): SessionWorkspacePayload | null {
    return this.cache.get(sessionId) ?? null
  }

  private sendOpenReady(payload: SessionWorkspacePayload): void {
    this.cache.set(payload.sessionId, payload)
    this.getWindow()?.webContents.send('session:openReady', {
      sessionId: payload.sessionId,
      workspace: payload
    })
    logger.info('session:openReady', {
      sessionId: payload.sessionId,
      diffFiles: payload.diff.files?.length ?? 0,
      capItems: payload.sessionChangesCap.items.length,
      treeEntries: payload.filesTree.length
    })
  }

  private sendUpdated(payload: SessionWorkspacePayload): void {
    this.cache.set(payload.sessionId, payload)
    this.getWindow()?.webContents.send('session:workspaceUpdated', {
      sessionId: payload.sessionId,
      workspace: payload
    })
  }

  async preloadSession(session: SessionRecord): Promise<SessionWorkspacePayload> {
    const workspacePath = workspacePathFor(session)
    const hostname = session.hostname
    const tabTerminalPtyId = `${session.id}:tab-terminal`

    const pty = this.ptyManager
    if (pty) {
      try {
        await pty.spawn(tabTerminalPtyId, {
          cwd: workspacePath,
          hostname,
          cols: DEFAULT_PTY_COLS,
          rows: DEFAULT_PTY_ROWS
        })
      } catch (err) {
        logger.warn('workspace preload: tab terminal spawn failed', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    const [diff, filesTree, filesList, sessionChangesCap] = await Promise.all([
      getDiffSummary(workspacePath, hostname, false),
      Promise.resolve(walkFileTree(workspacePath, hostname)).then((r) => (Array.isArray(r) ? r : [])),
      Promise.resolve(listWorkspaceFiles(workspacePath, hostname)).then((r) => (Array.isArray(r) ? r : [])),
      this.buildSessionChangesCap(session.id, { processHead: true })
    ])

    const payload: SessionWorkspacePayload = {
      sessionId: session.id,
      workspacePath,
      hostname,
      diff,
      sessionChangesCap,
      filesTree,
      filesList,
      tabTerminalPtyId,
      loadedAt: Date.now()
    }
    return payload
  }

  /** After harness is live: preload, notify renderer, start background monitor. */
  async completeSessionOpen(session: SessionRecord): Promise<void> {
    const payload = await this.preloadSession(session)
    this.sendOpenReady(payload)
    this.startMonitor(session)
  }

  async refreshWorkspace(session: SessionRecord, force: boolean): Promise<SessionWorkspacePayload> {
    const workspacePath = workspacePathFor(session)
    const prev = this.cache.get(session.id)
    const [diff, filesTree, filesList, sessionChangesCap] = await Promise.all([
      getDiffSummary(workspacePath, session.hostname, force),
      Promise.resolve(walkFileTree(workspacePath, session.hostname)).then((r) =>
        Array.isArray(r) ? r : []
      ),
      Promise.resolve(listWorkspaceFiles(workspacePath, session.hostname)).then((r) =>
        Array.isArray(r) ? r : []
      ),
      this.buildSessionChangesCap(session.id, { processHead: true })
    ])
    const payload: SessionWorkspacePayload = {
      sessionId: session.id,
      workspacePath,
      hostname: session.hostname,
      diff,
      sessionChangesCap,
      filesTree,
      filesList,
      tabTerminalPtyId: prev?.tabTerminalPtyId ?? `${session.id}:tab-terminal`,
      loadedAt: Date.now()
    }
    const prevDiffSig = prev ? diffListSignature(prev.diff) : ''
    const nextDiffSig = diffListSignature(diff)
    const treeChanged = JSON.stringify(prev?.filesTree) !== JSON.stringify(filesTree)
    const capChanged =
      sessionChangesCapSignature(prev?.sessionChangesCap ?? { items: [] }) !==
      sessionChangesCapSignature(sessionChangesCap)
    if (prevDiffSig !== nextDiffSig || treeChanged || capChanged || force) {
      this.sendUpdated(payload)
    } else {
      this.cache.set(session.id, payload)
    }
    return payload
  }

  patchSessionChangesCap(sessionId: string, cap: SessionChangesCap): void {
    const prev = this.cache.get(sessionId)
    if (!prev) return
    const nextSig = sessionChangesCapSignature(cap)
    const prevSig = sessionChangesCapSignature(prev.sessionChangesCap)
    if (nextSig === prevSig) {
      this.cache.set(sessionId, { ...prev, sessionChangesCap: cap })
      return
    }
    const payload: SessionWorkspacePayload = {
      ...prev,
      sessionChangesCap: cap,
      loadedAt: Date.now()
    }
    this.sendUpdated(payload)
  }

  stopMonitor(sessionId: string): void {
    this.monitors.get(sessionId)?.stop()
    this.monitors.delete(sessionId)
  }

  evictSession(sessionId: string): void {
    this.stopMonitor(sessionId)
    this.cache.delete(sessionId)
  }

  private startMonitor(session: SessionRecord): void {
    this.monitors.get(session.id)?.stop()
    this.monitors.delete(session.id)

    const workspacePath = workspacePathFor(session)
    if (session.hostname) {
      const timer = setInterval(() => {
        void this.refreshWorkspace(session, false).catch((err) =>
          logger.warn('devpod workspace poll failed', {
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err)
          })
        )
      }, DEVPOD_GIT_POLL_MS)
      this.monitors.set(session.id, {
        stop: () => clearInterval(timer)
      })
      return
    }

    void (async () => {
      const gitDir = join(await resolveGitRepoRoot(workspacePath, null), '.git')
      let debounce: ReturnType<typeof setTimeout> | undefined
      const watchers: FSWatcher[] = []
      const schedule = (): void => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => {
          void this.refreshWorkspace(session, false).catch(() => undefined)
        }, LOCAL_GIT_DEBOUNCE_MS)
      }
      for (const rel of ['index', 'HEAD']) {
        try {
          watchers.push(watch(join(gitDir, rel), schedule))
        } catch {
          // not a git repo or path missing
        }
      }
      this.monitors.set(session.id, {
        stop: () => {
          if (debounce) clearTimeout(debounce)
          for (const w of watchers) w.close()
        }
      })
    })()
  }
}
