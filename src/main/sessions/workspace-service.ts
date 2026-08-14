/**
 * Session workspace preload + background git/cap refresh (Features/session-workspace-preload).
 * Runs in main: initial load before session:openReady; monitor while session is live.
 * Background poll refreshes diff + changes cap only — not the file tree/list (those load
 * once at open, or on explicit force refresh).
 */
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { SessionRecord } from '../../shared/session-types'
import type { SessionWorkspacePayload } from '../../shared/session-workspace-types'
import type { DiffSummary } from '../../shared/panel-types'
import type { SessionChangesCap } from '../../shared/session-changes-cap'
import { sessionChangesCapSignature } from '../../shared/session-changes-cap'
import { getDiffSummary, getDiffSummaryWithHunks } from '../panels/git'
import { resolveGitRepoRoot } from '../panels/git-core'
import { walkFileTree, listWorkspaceFiles } from '../panels/files'
import type { PtyManager } from '../panels/pty'
import { logger } from '../logger'
import { warmSshMux } from '../ssh-exec'
import { ensureUssh } from '../uber-auth'

export const DEVPOD_GIT_POLL_MS = 15_000
export const LOCAL_GIT_DEBOUNCE_MS = 400
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

/** Keep hydrated hunks when a numstat-only refresh runs (background poll, hydrateSnapshot). */
function mergeDiffHunks(prev: DiffSummary | undefined, next: DiffSummary): DiffSummary {
  if (!prev?.isRepo || !next.isRepo) return next
  return {
    ...next,
    files: next.files.map((f) => {
      if (f.hunks.length > 0) return f
      const old = prev.files.find((o) => o.path === f.path)
      if (old?.hunks.length) return { ...f, hunks: old.hunks }
      return f
    })
  }
}

const PRELOAD_DIFF_HUNKS_TIMEOUT_MS = 120_000

async function loadPreloadDiff(
  workspacePath: string,
  hostname: string | null,
  sessionId: string
): Promise<DiffSummary> {
  try {
    return await Promise.race([
      getDiffSummaryWithHunks(workspacePath, hostname, false),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('preload diff hunks timed out')), PRELOAD_DIFF_HUNKS_TIMEOUT_MS)
      )
    ])
  } catch (err) {
    logger.warn('workspace preload: diff hunk hydration failed, using file list only', {
      sessionId,
      error: err instanceof Error ? err.message : String(err)
    })
    return getDiffSummary(workspacePath, hostname, true)
  }
}

export class WorkspaceService {
  private readonly cache = new Map<string, SessionWorkspacePayload>()
  private readonly monitors = new Map<string, { stop: () => void }>()
  private readonly refreshInFlight = new Map<string, number>()
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
      diffHunksLoaded: payload.diff.files?.filter((f) => f.hunks.length > 0).length ?? 0,
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

  private sendRefreshing(sessionId: string, refreshing: boolean): void {
    this.getWindow()?.webContents.send('session:workspaceRefreshing', { sessionId, refreshing })
  }

  private beginRefresh(sessionId: string): void {
    const next = (this.refreshInFlight.get(sessionId) ?? 0) + 1
    this.refreshInFlight.set(sessionId, next)
    if (next === 1) this.sendRefreshing(sessionId, true)
  }

  private endRefresh(sessionId: string): void {
    const next = (this.refreshInFlight.get(sessionId) ?? 1) - 1
    if (next <= 0) {
      this.refreshInFlight.delete(sessionId)
      this.sendRefreshing(sessionId, false)
    } else {
      this.refreshInFlight.set(sessionId, next)
    }
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

    if (hostname) {
      await ensureUssh()
      await warmSshMux(hostname)
    }

    const [diff, filesTree, filesList, sessionChangesCap] = await Promise.all([
      loadPreloadDiff(workspacePath, hostname, session.id),
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

  async refreshWorkspace(
    session: SessionRecord,
    force: boolean,
    opts?: { includeFiles?: boolean }
  ): Promise<SessionWorkspacePayload> {
    this.beginRefresh(session.id)
    try {
      const workspacePath = workspacePathFor(session)
      const prev = this.cache.get(session.id)
      // File tree/list load once at session open (preloadSession). Background refresh
      // never re-scans unless the caller explicitly opts in (e.g. worktree created).
      const includeFiles = opts?.includeFiles === true
      const diffRaw = force
        ? await getDiffSummaryWithHunks(workspacePath, session.hostname, true)
        : await getDiffSummary(workspacePath, session.hostname, force)
      const diff = mergeDiffHunks(prev?.diff, diffRaw)
      const [filesTree, filesList, sessionChangesCap] = await Promise.all([
        includeFiles
          ? Promise.resolve(walkFileTree(workspacePath, session.hostname)).then((r) =>
              Array.isArray(r) ? r : []
            )
          : Promise.resolve(prev?.filesTree ?? []),
        includeFiles
          ? Promise.resolve(listWorkspaceFiles(workspacePath, session.hostname)).then((r) =>
              Array.isArray(r) ? r : []
            )
          : Promise.resolve(prev?.filesList ?? []),
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
      const capChanged =
        sessionChangesCapSignature(prev?.sessionChangesCap ?? { items: [] }) !==
        sessionChangesCapSignature(sessionChangesCap)
      if (prevDiffSig !== nextDiffSig || capChanged || force) {
        this.sendUpdated(payload)
      } else {
        this.cache.set(session.id, payload)
      }
      return payload
    } finally {
      this.endRefresh(session.id)
    }
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
