/**
 * Session workspace preload + background git/cap refresh (Features/session-workspace-preload).
 * Essential preload (SSH, files, terminal, git probe) runs before session:openReady;
 * full git diff + changes cap load in the background so connect is not blocked on remote git.
 */
import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { SessionRecord } from '../../shared/session-types'
import type {
  SessionConnectProgressEvent,
  SessionConnectStep,
  SessionOpenTimingEvent,
  SessionWorkspacePayload
} from '../../shared/session-workspace-types'
import type { DiffSummary } from '../../shared/panel-types'
import type { SessionChangesCap } from '../../shared/session-changes-cap'
import { sessionChangesCapSignature } from '../../shared/session-changes-cap'
import { getDiffSummary, getDiffSummaryWithHunks, mergeHintPathsIntoDiffSummary, onWorkingTreeUpdated, probeGitRepo } from '../panels/git'
import { resolveGitRepoRoot } from '../panels/git-core'
import { walkFileTree, listWorkspaceFiles } from '../panels/files'
import type { PtyManager } from '../panels/pty'
import { logger } from '../logger'
import { warmSshMux } from '../ssh-exec'
import { ensureUssh } from '../uber-auth'
import { withRemotePreloadHostQueue, withRemoteBackgroundHostQueue, coalesceSessionCapRebuild, getHostBackgroundQueueDepth } from './remote-preload-gate'
import { mergeCapItemsFromDiffSummary } from './session-changes-cap'

export const DEVPOD_GIT_POLL_MS = 15_000
export const LOCAL_GIT_DEBOUNCE_MS = 400
const DEFAULT_PTY_COLS = 80
const DEFAULT_PTY_ROWS = 24

const CONNECT_STEP_LABELS: Record<SessionConnectStep, string> = {
  ssh: 'Warming SSH connection…',
  files: 'Loading file index…',
  terminal: 'Starting terminal…',
  'git-probe': 'Checking git repository…'
}

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

const PRELOAD_DIFF_HUNKS_TIMEOUT_MS = 60_000
/** Wall-clock cap for essential preload — clears connecting even if remote SSH/files hang. */
const PRELOAD_ESSENTIALS_TIMEOUT_MS = 45_000
/** Wall-clock cap for background workspace refresh — clears "Refreshing diff…" if remote git stalls. */
const REFRESH_WORKSPACE_TIMEOUT_MS = (() => {
  const raw = process.env.ATELIER_REFRESH_WORKSPACE_TIMEOUT_MS
  if (raw) {
    const parsed = Number(raw)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 120_000
})()
/** E2E/diagnostic only: reproduce installed-app poll stacking (no coalesce, full cap rebuild). */
const DIAGNOSTIC_LEGACY_POLL = process.env.ATELIER_DIAGNOSTIC_LEGACY_POLL === '1'

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

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = Date.now()
  const result = await fn()
  return { result, ms: Date.now() - start }
}

export class WorkspaceService {
  private readonly cache = new Map<string, SessionWorkspacePayload>()
  private readonly monitors = new Map<string, { stop: () => void }>()
  private readonly refreshInFlight = new Map<string, number>()
  private readonly sessionRefreshPromises = new Map<string, Promise<SessionWorkspacePayload>>()
  private readonly backgroundPreloadInFlight = new Set<string>()
  private ptyManager: PtyManager | null = null

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    private readonly buildSessionChangesCap: (sessionId: string) => Promise<SessionChangesCap>,
    private readonly listSessionTouchedPaths: (sessionId: string) => string[] = () => []
  ) {
    onWorkingTreeUpdated((workspacePath, hostname, diff) => {
      this.applyUntrackedDiffUpdate(workspacePath, hostname ?? null, diff)
    })
  }

  /** Merge deferred untracked paths from background ls-files into open session workspaces. */
  private applyUntrackedDiffUpdate(
    workspacePath: string,
    hostname: string | null,
    diff: DiffSummary
  ): void {
    for (const payload of this.cache.values()) {
      if (payload.workspacePath !== workspacePath || payload.hostname !== hostname) continue
      const merged = mergeDiffHunks(payload.diff, diff)
      if (diffListSignature(payload.diff) === diffListSignature(merged)) continue
      const hintPaths = this.listSessionTouchedPaths(payload.sessionId)
      const sessionChangesCap = mergeCapItemsFromDiffSummary(
        payload.sessionChangesCap,
        merged,
        hintPaths
      )
      this.sendUpdated({ ...payload, diff: merged, sessionChangesCap, loadedAt: Date.now() })
    }
  }

  setPtyManager(pty: PtyManager): void {
    this.ptyManager = pty
  }

  getCached(sessionId: string): SessionWorkspacePayload | null {
    return this.cache.get(sessionId) ?? null
  }

  private sendConnectProgress(sessionId: string, step: SessionConnectStep): void {
    const payload: SessionConnectProgressEvent = {
      sessionId,
      step,
      label: CONNECT_STEP_LABELS[step]
    }
    this.getWindow()?.webContents.send('session:connectProgress', payload)
  }

  private sendOpenTiming(payload: SessionOpenTimingEvent): void {
    this.getWindow()?.webContents.send('session:openTiming', payload)
    logger.info('session:openTiming', { ...payload })
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
      treeEntries: payload.filesTree.length,
      gitDeferred: true
    })
  }

  private sendUpdated(payload: SessionWorkspacePayload): void {
    this.cache.set(payload.sessionId, payload)
    this.getWindow()?.webContents.send('session:workspaceUpdated', {
      sessionId: payload.sessionId,
      workspace: payload
    })
  }

  private traceRefresh(
    event: string,
    sessionId: string,
    extra: Record<string, unknown> = {}
  ): void {
    const hostname = this.cache.get(sessionId)?.hostname ?? null
    logger.info('workspace:refresh:trace', {
      event,
      sessionId,
      refreshRefCount: this.refreshInFlight.get(sessionId) ?? 0,
      coalescedRefresh: this.sessionRefreshPromises.has(sessionId),
      hostQueueDepth: hostname ? getHostBackgroundQueueDepth(hostname) : 0,
      ...extra
    })
  }

  private sendRefreshing(sessionId: string, refreshing: boolean): void {
    this.traceRefresh(refreshing ? 'uiRefreshingOn' : 'uiRefreshingOff', sessionId)
    this.getWindow()?.webContents.send('session:workspaceRefreshing', { sessionId, refreshing })
  }

  private beginRefresh(sessionId: string, source: string, opts?: { silent?: boolean }): void {
    const next = (this.refreshInFlight.get(sessionId) ?? 0) + 1
    this.refreshInFlight.set(sessionId, next)
    this.traceRefresh('beginRefresh', sessionId, { source, refreshRefCount: next, silent: opts?.silent === true })
    if (next === 1 && opts?.silent !== true) this.sendRefreshing(sessionId, true)
  }

  private endRefresh(sessionId: string, source: string, opts?: { silent?: boolean }): void {
    const next = (this.refreshInFlight.get(sessionId) ?? 1) - 1
    if (next <= 0) {
      this.refreshInFlight.delete(sessionId)
      this.traceRefresh('endRefresh', sessionId, { source, refreshRefCount: 0, silent: opts?.silent === true })
      if (opts?.silent !== true) this.sendRefreshing(sessionId, false)
    } else {
      this.refreshInFlight.set(sessionId, next)
      this.traceRefresh('endRefresh', sessionId, { source, refreshRefCount: next, silent: opts?.silent === true })
    }
  }

  getRefreshDiagnostics(sessionId: string): {
    sessionId: string
    refreshRefCount: number
    coalescedRefresh: boolean
    hostQueueDepth: number
    cachedDiffFiles: number | null
    cacheLoadedAt: number | null
  } {
    const cached = this.cache.get(sessionId)
    const hostname = cached?.hostname ?? null
    return {
      sessionId,
      refreshRefCount: this.refreshInFlight.get(sessionId) ?? 0,
      coalescedRefresh: this.sessionRefreshPromises.has(sessionId),
      hostQueueDepth: hostname ? getHostBackgroundQueueDepth(hostname) : 0,
      cachedDiffFiles: cached?.diff.files.length ?? null,
      cacheLoadedAt: cached?.loadedAt ?? null
    }
  }

  private emptyPreloadPayload(session: SessionRecord, tabTerminalPtyId: string): SessionWorkspacePayload {
    const workspacePath = workspacePathFor(session)
    return {
      sessionId: session.id,
      workspacePath,
      hostname: session.hostname,
      diff: { isRepo: false, branch: null, files: [] },
      sessionChangesCap: { items: [] },
      filesTree: [],
      filesList: [],
      tabTerminalPtyId,
      loadedAt: Date.now()
    }
  }

  private spawnTabTerminal(
    sessionId: string,
    tabTerminalPtyId: string,
    workspacePath: string,
    hostname: string | null
  ): Promise<void> {
    const pty = this.ptyManager
    if (!pty) return Promise.resolve()
    return pty
      .spawn(tabTerminalPtyId, {
        cwd: workspacePath,
        hostname,
        cols: DEFAULT_PTY_COLS,
        rows: DEFAULT_PTY_ROWS
      })
      .catch((err) => {
        logger.warn('workspace preload: tab terminal spawn failed', {
          sessionId,
          error: err instanceof Error ? err.message : String(err)
        })
      })
  }

  private async loadSessionChangesCapSafe(
    sessionId: string,
    fallback: SessionChangesCap = { items: [] },
    hostname?: string | null
  ): Promise<SessionChangesCap> {
    const host = hostname ?? this.cache.get(sessionId)?.hostname ?? null
    try {
      return await coalesceSessionCapRebuild(sessionId, () =>
        withRemoteBackgroundHostQueue(host, () => this.buildSessionChangesCap(sessionId))
      )
    } catch (err) {
      logger.warn('session changes cap build failed; continuing without cap update', {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
      return fallback
    }
  }

  /** Fast path: SSH warm, files, terminal, git repo probe — no full diff scan. */
  async preloadSessionEssentials(session: SessionRecord): Promise<{
    payload: SessionWorkspacePayload
    timings: Pick<
      SessionOpenTimingEvent,
      'essentialMs' | 'sshWarmMs' | 'filesTreeMs' | 'filesListMs' | 'ptyMs' | 'gitProbeMs'
    >
  }> {
    const workspacePath = workspacePathFor(session)
    const hostname = session.hostname
    const tabTerminalPtyId = `${session.id}:tab-terminal`
    const essentialStart = Date.now()

    return withRemotePreloadHostQueue(hostname, async () => {
      let sshWarmMs = 0
      if (hostname) {
        this.sendConnectProgress(session.id, 'ssh')
        const sshTimed = await timed(async () => {
          await ensureUssh()
          await warmSshMux(hostname)
        })
        sshWarmMs = sshTimed.ms
      }

      this.sendConnectProgress(session.id, 'files')
      const filesTreeTimed = timed(() =>
        Promise.resolve(walkFileTree(workspacePath, hostname)).then((r) => (Array.isArray(r) ? r : []))
      )
      const filesListTimed = timed(() =>
        Promise.resolve(listWorkspaceFiles(workspacePath, hostname)).then((r) => (Array.isArray(r) ? r : []))
      )

      this.sendConnectProgress(session.id, 'terminal')
      const ptyTimed = timed(() =>
        this.spawnTabTerminal(session.id, tabTerminalPtyId, workspacePath, hostname)
      )

      const [filesTreeResult, filesListResult, ptyResult] = await Promise.all([
        filesTreeTimed,
        filesListTimed,
        ptyTimed
      ])

      this.sendConnectProgress(session.id, 'git-probe')
      const gitProbeTimed = await timed(() => probeGitRepo(workspacePath, hostname))

      const essentialMs = Date.now() - essentialStart
      const payload: SessionWorkspacePayload = {
        sessionId: session.id,
        workspacePath,
        hostname,
        diff: gitProbeTimed.result,
        sessionChangesCap: { items: [] },
        filesTree: filesTreeResult.result,
        filesList: filesListResult.result,
        tabTerminalPtyId,
        loadedAt: Date.now()
      }

      return {
        payload,
        timings: {
          essentialMs,
          sshWarmMs: hostname ? sshWarmMs : undefined,
          filesTreeMs: filesTreeResult.ms,
          filesListMs: filesListResult.ms,
          ptyMs: ptyResult.ms,
          gitProbeMs: gitProbeTimed.ms
        }
      }
    })
  }

  /** Full git diff + cap — runs after openReady; must not block connect. */
  private preloadSessionBackground(session: SessionRecord, base: SessionWorkspacePayload): void {
    if (this.backgroundPreloadInFlight.has(session.id)) return
    this.backgroundPreloadInFlight.add(session.id)
    const backgroundStart = Date.now()
    const workspacePath = base.workspacePath
    const hostname = base.hostname

    void (async () => {
      let backgroundGitMs = 0
      let backgroundCapMs = 0
      try {
        const gitTimed = await timed(() => loadPreloadDiff(workspacePath, hostname, session.id))
        backgroundGitMs = gitTimed.ms
        const capTimed = await timed(() => this.loadSessionChangesCapSafe(session.id, { items: [] }, hostname))
        backgroundCapMs = capTimed.ms

        const diffWithHints = await mergeHintPathsIntoDiffSummary(
          gitTimed.result,
          workspacePath,
          hostname,
          this.listSessionTouchedPaths(session.id)
        )
        const diff = mergeDiffHunks(base.diff, diffWithHints)
        const hintPaths = this.listSessionTouchedPaths(session.id)
        const sessionChangesCap = mergeCapItemsFromDiffSummary(capTimed.result, diff, hintPaths)
        const payload: SessionWorkspacePayload = {
          ...base,
          diff,
          sessionChangesCap,
          loadedAt: Date.now()
        }
        this.sendUpdated(payload)
        this.sendOpenTiming({
          sessionId: session.id,
          phase: 'background',
          essentialMs: 0,
          backgroundGitMs,
          backgroundCapMs,
          backgroundTotalMs: Date.now() - backgroundStart,
          gitDeferred: true
        })
      } catch (err) {
        logger.warn('workspace background preload failed', {
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err)
        })
      } finally {
        this.backgroundPreloadInFlight.delete(session.id)
      }
    })()
  }

  /** After harness is live: essential preload, notify renderer, background git/cap, start monitor. */
  async completeSessionOpen(session: SessionRecord): Promise<void> {
    const tabTerminalPtyId = `${session.id}:tab-terminal`
    let payload: SessionWorkspacePayload
    let essentialTimings: {
      essentialMs: number
      sshWarmMs?: number
      filesTreeMs?: number
      filesListMs?: number
      ptyMs?: number
      gitProbeMs?: number
    } = { essentialMs: PRELOAD_ESSENTIALS_TIMEOUT_MS }
    try {
      const essentials = await Promise.race([
        this.preloadSessionEssentials(session),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('preload essentials timed out')), PRELOAD_ESSENTIALS_TIMEOUT_MS)
        )
      ])
      payload = essentials.payload
      essentialTimings = essentials.timings
    } catch (err) {
      logger.warn('workspace essential preload failed or timed out; opening with empty workspace', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err)
      })
      payload = this.emptyPreloadPayload(session, tabTerminalPtyId)
      essentialTimings = { essentialMs: PRELOAD_ESSENTIALS_TIMEOUT_MS }
    }

    this.sendOpenReady(payload)
    this.sendOpenTiming({
      sessionId: session.id,
      phase: 'essential',
      gitDeferred: true,
      ...essentialTimings
    })
    this.startMonitor(session)
    this.preloadSessionBackground(session, payload)
  }

  async refreshWorkspace(
    session: SessionRecord,
    force: boolean,
    opts?: { includeFiles?: boolean; skipCapRebuild?: boolean; source?: string }
  ): Promise<SessionWorkspacePayload> {
    const source = opts?.source ?? (force ? 'manual' : 'poll')
    const existing = this.sessionRefreshPromises.get(session.id)
    if (!DIAGNOSTIC_LEGACY_POLL && existing) {
      this.traceRefresh('refreshCoalesced', session.id, { source, force, skipCapRebuild: opts?.skipCapRebuild === true })
      return existing
    }

    this.traceRefresh('refreshScheduled', session.id, { source, force, skipCapRebuild: opts?.skipCapRebuild === true })
    const work = this.runRefreshWorkspace(session, force, opts, source)
    this.sessionRefreshPromises.set(session.id, work)
    return work.finally(() => {
      if (this.sessionRefreshPromises.get(session.id) === work) {
        this.sessionRefreshPromises.delete(session.id)
      }
    })
  }

  private async runRefreshWorkspace(
    session: SessionRecord,
    force: boolean,
    opts: { includeFiles?: boolean; skipCapRebuild?: boolean; source?: string } | undefined,
    source: string
  ): Promise<SessionWorkspacePayload> {
    const refreshStartedAt = Date.now()
    const queueEnteredAt = Date.now()
    const silentRefresh = opts?.skipCapRebuild === true && source === 'poll'
    let refreshEnded = false
    const endRefreshOnce = (): void => {
      if (refreshEnded) return
      refreshEnded = true
      this.endRefresh(session.id, source, { silent: silentRefresh })
    }

    const run = async (): Promise<SessionWorkspacePayload> => {
      const queueWaitMs = Date.now() - queueEnteredAt
      this.traceRefresh('refreshDequeued', session.id, { source, queueWaitMs, hintPathCount: this.listSessionTouchedPaths(session.id).length })
      this.beginRefresh(session.id, source, { silent: silentRefresh })
      try {
        const workspacePath = workspacePathFor(session)
        const prev = this.cache.get(session.id)
        const includeFiles = opts?.includeFiles === true
        const skipCapRebuild = opts?.skipCapRebuild === true
        const hintPaths = this.listSessionTouchedPaths(session.id)

        const gitTimed = await timed(() =>
          force
            ? getDiffSummaryWithHunks(workspacePath, session.hostname, true)
            : getDiffSummary(workspacePath, session.hostname, force)
        )
        const hintsTimed = await timed(() =>
          mergeHintPathsIntoDiffSummary(gitTimed.result, workspacePath, session.hostname, hintPaths)
        )
        const diff = mergeDiffHunks(prev?.diff, hintsTimed.result)
        const [filesTree, filesList] = await Promise.all([
          includeFiles
            ? Promise.resolve(walkFileTree(workspacePath, session.hostname)).then((r) =>
                Array.isArray(r) ? r : []
              )
            : Promise.resolve(prev?.filesTree ?? []),
          includeFiles
            ? Promise.resolve(listWorkspaceFiles(workspacePath, session.hostname)).then((r) =>
                Array.isArray(r) ? r : []
              )
            : Promise.resolve(prev?.filesList ?? [])
        ])
        const capTimed = skipCapRebuild
          ? { result: prev?.sessionChangesCap ?? { items: [] }, ms: 0 }
          : await timed(() =>
              this.loadSessionChangesCapSafe(
                session.id,
                prev?.sessionChangesCap ?? { items: [] },
                session.hostname
              )
            )
        const sessionChangesCap = mergeCapItemsFromDiffSummary(capTimed.result, diff, hintPaths)
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
        const sentUpdate = prevDiffSig !== nextDiffSig || capChanged || force
        if (sentUpdate) {
          this.sendUpdated(payload)
        } else {
          this.cache.set(session.id, payload)
        }
        this.traceRefresh('refreshCompleted', session.id, {
          source,
          queueWaitMs,
          gitMs: gitTimed.ms,
          hintsMs: hintsTimed.ms,
          capMs: capTimed.ms,
          skipCapRebuild,
          diffFiles: diff.files.length,
          sentUpdate,
          totalMs: Date.now() - refreshStartedAt
        })
        return payload
      } finally {
        endRefreshOnce()
      }
    }

    const runWithTimeout = (): Promise<SessionWorkspacePayload> =>
      Promise.race([
        run(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('workspace refresh timed out')), REFRESH_WORKSPACE_TIMEOUT_MS)
        )
      ])

    try {
      const queued = session.hostname
        ? withRemoteBackgroundHostQueue(session.hostname, runWithTimeout)
        : runWithTimeout()
      return await queued
    } catch (err) {
      // Promise.race rejects on timeout while run() may still be in flight — clear the
      // banner here so a stalled remote git call cannot leave uiRefreshingOn forever.
      endRefreshOnce()
      this.traceRefresh('refreshFailed', session.id, {
        source,
        error: err instanceof Error ? err.message : String(err),
        totalMs: Date.now() - refreshStartedAt
      })
      logger.warn('workspace refresh failed or timed out', {
        sessionId: session.id,
        error: err instanceof Error ? err.message : String(err)
      })
      const cached = this.cache.get(session.id)
      if (cached) return cached
      return this.emptyPreloadPayload(session, `${session.id}:tab-terminal`)
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
    this.backgroundPreloadInFlight.delete(sessionId)
    this.sessionRefreshPromises.delete(sessionId)
  }

  private startMonitor(session: SessionRecord): void {
    this.monitors.get(session.id)?.stop()
    this.monitors.delete(session.id)

    const workspacePath = workspacePathFor(session)
    if (session.hostname) {
      const timer = setInterval(() => {
        if (!DIAGNOSTIC_LEGACY_POLL && this.sessionRefreshPromises.has(session.id)) {
          this.traceRefresh('pollSkipped', session.id, { reason: 'refreshInFlight' })
          return
        }
        this.traceRefresh('pollFired', session.id, { legacyPoll: DIAGNOSTIC_LEGACY_POLL })
        void this.refreshWorkspace(session, false, {
          skipCapRebuild: !DIAGNOSTIC_LEGACY_POLL,
          source: 'poll'
        }).catch((err) =>
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
          if (this.sessionRefreshPromises.has(session.id)) {
            this.traceRefresh('pollSkipped', session.id, { reason: 'refreshInFlight' })
            return
          }
          this.traceRefresh('pollFired', session.id, { local: true })
          void this.refreshWorkspace(session, false, { skipCapRebuild: true, source: 'poll' }).catch(() => undefined)
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
