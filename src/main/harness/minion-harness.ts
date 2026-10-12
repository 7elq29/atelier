/**
 * MinionHarness — HarnessDriver backed by the Uber Minion orchestrator.
 *
 * Transport: Minion SPA HTTP (`POST /api/getTask`, `createInteraction`,
 * `listInteractions`, `getDevpods`, `createTask`, `cancelTask`, scratch).
 * Polling replaces streaming until the tip is idle again.
 *
 * Steer/resume: createInteraction → track PENDING → RESPONDED on that user
 * row → agent answer in AGENT `message`; do not soft-stop on tip CANCELLED /
 * COMPLETED while the steer interaction is still PENDING.
 *
 * Session-id contract: the Minion task UUID is used directly as the Atelier
 * session id (same convention as CortanaHarness).
 *
 * Every assistant row is pushed as text_delta + result so SessionManager
 * flushes each one as a distinct transcript message. Completion uses subtype
 * `end_turn`; live agent updates use `minion_progress`. Both trigger desktop /
 * in-app notifications (create/cancel subtypes do not).
 */

import { logger } from '../logger'
import type { MinionRepo } from '../../shared/session-types'
import type { HarnessDriver, HarnessEvent, HarnessFileInput, HarnessSession, HarnessStartOptions, PromptResponse } from './types'
import {
  extractDevpodTarget,
  getFileContents,
  listScratchFiles,
  SCRATCH_FETCH_TIMEOUT_MS,
  type DevpodScratchTarget
} from './minion-scratch-client'
import {
  findDevpodForTask,
  httpCancelTask,
  httpCreateInteraction,
  httpCreateTask,
  httpGetDevpods,
  httpGetTask,
  httpListInteractions,
  isDevpodRunningState
} from './minion-http-client'
import {
  consumeScratchAppend,
  emptyScratchWatermark,
  type ScratchProgressChrome,
  type ScratchTailWatermark
} from './minion-scratch-tail'

export const POLL_INTERVAL_MS = 5000
/** Faster polls while DevPod is still coming up so the transcript isn't silent. */
const EARLY_POLL_INTERVAL_MS = 2000
const EARLY_POLL_WINDOW_MS = 90_000
const POLL_TIMEOUT_MS = 6 * 60 * 60 * 1000
const MAX_CONSECUTIVE_POLL_ERRORS = 3

const INTERACTION_PENDING = 'INTERACTION_STATUS_PENDING'
const INTERACTION_RESPONDED = 'INTERACTION_STATUS_RESPONDED'
const INTERACTION_EXPIRED = 'INTERACTION_STATUS_EXPIRED'
const INTERACTION_CANCELLED = 'INTERACTION_STATUS_CANCELLED'

const REPO_ENUM: Record<MinionRepo, { enum: string; name: string }> = {
  'go-code': { enum: 'REPO_GO_CODE', name: 'go-code' },
  'java-code': { enum: 'REPO_JAVA_CODE', name: 'java-code' },
  'android-code': { enum: 'REPO_ANDROID_CODE', name: 'android-code' },
  'web-code': { enum: 'REPO_WEB_CODE', name: 'web-code' },
  'uber-one': { enum: 'REPO_UBER_ONE', name: 'uber-one' },
  'ios-code': { enum: 'REPO_IOS_CODE', name: 'ios-code' },
  'ml-code': { enum: 'REPO_ML_CODE', name: 'ml-code' }
}

// ── EventChannel ────────────────────────────────────────────────────────────

class EventChannel {
  private readonly queue: HarnessEvent[] = []
  private waiter: (() => void) | null = null
  private done = false

  get closed(): boolean {
    return this.done
  }

  push(event: HarnessEvent): void {
    if (this.done) return
    this.queue.push(event)
    this.waiter?.()
    this.waiter = null
  }

  close(): void {
    this.done = true
    this.waiter?.()
    this.waiter = null
  }

  async * [Symbol.asyncIterator](): AsyncGenerator<HarnessEvent, void, void> {
    while (true) {
      while (this.queue.length > 0) yield this.queue.shift()!
      if (this.done) return
      await new Promise<void>(r => { this.waiter = r })
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pushAssistantMessage(channel: EventChannel, sessionId: string, text: string, subtype: string, totalCostUsd = 0): void {
  const ts = new Date().toISOString()
  channel.push({ type: 'text_delta', sessionId, timestamp: ts, text })
  channel.push({
    type: 'result',
    sessionId,
    timestamp: ts,
    isError: false,
    subtype,
    numTurns: 1,
    durationMs: 0,
    totalCostUsd,
    usage: null
  })
}

function isTerminalStatus(status: string): boolean {
  return /(COMPLETED|SUCCEEDED|SUCCESS|FAILED|CANCELLED|CANCELED|STALE|ERROR|TIMED_OUT|EXPIRED)/.test(status)
}

/**
 * Minion often leaves `task.status` as RUNNING while `latest_update.display_status`
 * is already COMPLETED (worker finished; orchestrator status lags). Treat that as done
 * so we flush scratch + post Done instead of sitting on Working forever.
 */
function isTaskFinished(task: Record<string, any>): boolean {
  if (isTerminalStatus(String(task.status ?? ''))) return true
  const display = extractDisplayStatus(task)
  return /^(COMPLETED|SUCCEEDED|SUCCESS)$/i.test(display)
}

function statusLabel(status: string): string {
  return status.replace(/^TASK_STATUS_/, '').replace(/_/g, ' ')
}

function extractLatestUpdate(task: Record<string, any>): string {
  const candidates = [task.latest_update, task.output?.latest_update]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
    if (c && typeof c === 'object') {
      const m = c.message ?? c.text ?? c.summary
      if (typeof m === 'string' && m.trim()) return m.trim()
    }
  }
  return ''
}

function findPrUrl(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null
  if (typeof value === 'string') {
    return /^https?:\/\/\S*(pull|\/pr\/|\/diff\/|pulls)\S*$/i.test(value) ? value : null
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const f = findPrUrl(v, depth + 1)
      if (f) return f
    }
    return null
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const f = findPrUrl(v, depth + 1)
      if (f) return f
    }
  }
  return null
}

function taskCost(task: Record<string, any>): number {
  const c = task.output?.task_metrics?.total_cost_usd
  return typeof c === 'number' ? c : 0
}

function formatTaskSummary(task: Record<string, any>, opts?: { stopped?: boolean }): string {
  const status = String(task.status ?? 'UNKNOWN')
  const label = statusLabel(status)
  const lines = [
    opts?.stopped
      ? 'Stopped.'
      : /CANCEL|FAIL|ERROR|TIMED|EXPIRED|STALE/i.test(label)
        ? `I finished with status **${label}**.`
        : 'Done.'
  ]
  let message = task.output?.message ?? task.output?.summary ?? task.status_message
  if (typeof message !== 'string' || !message.trim()) {
    // Many Minion completions put the real answer only in latest_update
    // (output.message stays empty) — without this, Atelier shows bare "Done."
    message = extractLatestUpdate(task)
  }
  if (typeof message === 'string' && message.trim()) lines.push('', message.trim())
  const pr = findPrUrl(task.output)
  if (pr) lines.push('', `PR: ${pr}`)
  if (task.runner_url) lines.push(`DevPod: ${task.runner_url}`)
  const cost = taskCost(task)
  if (cost > 0) lines.push(`Cost: $${cost.toFixed(2)}`)
  return lines.join('\n')
}

function extractDisplayStatus(task: Record<string, any>): string {
  const lu = task.latest_update
  if (lu && typeof lu === 'object' && typeof lu.display_status === 'string') {
    return lu.display_status.trim()
  }
  return ''
}

type SetupStepId = 'provision' | 'boot' | 'connect'
type SetupStepState = 'done' | 'active' | 'pending'

/**
 * Map getTask + getDevpods → Provision / Boot / Connect (Minion web UI).
 *
 * Live API notes (do not regress):
 * - `runner_url` is often present from the first createTask response.
 * - `latest_update.display_status` stays empty until COMPLETED on many jobs.
 * - Matching `CREAT` against `TASK_STATUS_CREATED` + treating any `runner_url`
 *   as Connect made the SETUP card stuck on "Connecting…" and never Boot.
 */
function deriveMinionSetup(
  task: Record<string, any>,
  opts?: { devpodState?: string }
): {
  active: SetupStepId
  title: string
  detail: string
  steps: Array<{ id: SetupStepId; label: string; state: SetupStepState }>
} | null {
  if (isTaskFinished(task)) return null

  const status = String(task.status ?? '').toUpperCase()
  const display = extractDisplayStatus(task).toUpperCase()
  const runnerUrl = typeof task.runner_url === 'string' ? task.runner_url.trim() : ''
  const podState = String(opts?.devpodState ?? '').toUpperCase()
  const podRunning = podState === 'STATE_RUNNING'
  const meta = task.metadata && typeof task.metadata === 'object' ? task.metadata : {}
  const hasDevpodHint = Boolean(
    runnerUrl ||
      meta.devpod_name ||
      meta.devpodName ||
      meta.devpod_region ||
      meta.devpodRegion
  )
  const preAgent =
    /TASK_STATUS_CREATED|TASK_STATUS_PENDING|TASK_STATUS_QUEUED|TASK_STATUS_UNKNOWN/.test(status) ||
    !status

  // Agent already running — no setup card (unless display_status still says setup).
  if (
    /TASK_STATUS_RUNNING|TASK_STATUS_IN_PROGRESS|TASK_STATUS_ACTIVE/.test(status) &&
    !/PROVISION|BOOT|PEND|QUEU|START|INIT|CONNECT|ALLOC|PENDING/.test(display)
  ) {
    return null
  }
  if (
    /TASK_STATUS_RUNNING|IN_PROGRESS|ACTIVE|WORKING/.test(status) &&
    hasDevpodHint &&
    !/PROVISION|BOOT|PEND|QUEU|START|INIT|CONNECT|ALLOC/.test(display)
  ) {
    return null
  }

  // Prefer explicit display_status keywords when Minion sets them.
  let active: SetupStepId
  if (/CONNECT/.test(display)) {
    active = 'connect'
  } else if (/BOOT|START|INIT|ALLOC/.test(display)) {
    active = 'boot'
  } else if (/PROVISION|PEND|QUEU|PENDING/.test(display)) {
    active = 'provision'
  } else if (!hasDevpodHint) {
    active = 'provision'
  } else if (!podRunning) {
    // Unknown '' or SNAPSHOTTED/STARTING/etc. — Boot, not Connect.
    // First paint after createTask usually has no getDevpods yet → Boot.
    active = 'boot'
  } else if (preAgent) {
    // Pod is STATE_RUNNING but task still CREATED — linking the agent.
    active = 'connect'
  } else {
    active = 'connect'
  }

  const order: SetupStepId[] = ['provision', 'boot', 'connect']
  const idx = order.indexOf(active)
  const steps = order.map((id, i) => ({
    id,
    label: id === 'provision' ? 'Provision' : id === 'boot' ? 'Boot' : 'Connect',
    state: (i < idx ? 'done' : i === idx ? 'active' : 'pending') as SetupStepState
  }))

  const titles: Record<SetupStepId, string> = {
    provision: 'Provisioning DevPod…',
    boot: 'Booting environment…',
    connect: 'Connecting to DevPod…'
  }
  const details: Record<SetupStepId, string> = {
    provision: 'Allocating a DevPod for this task — this can take a minute.',
    boot: podState
      ? `DevPod state ${podState.replace(/^STATE_/, '')}. Waiting until it is running.`
      : 'DevPod is starting up. I will keep this card updated.',
    connect: runnerUrl
      ? `Almost ready — linking to the runner.\n${runnerUrl}`
      : 'Finishing the connection to the DevPod.'
  }

  return { active, title: titles[active], detail: details[active], steps }
}

function interactionText(i: Record<string, any>): string {
  const t = i.content?.text ?? i.message
  return typeof t === 'string' ? t.trim() : ''
}

function isUserInitiator(v: unknown): boolean {
  return v === 'INTERACTION_INITIATOR_USER' || v === 2
}

function isAgentInitiator(v: unknown): boolean {
  return v === 'INTERACTION_INITIATOR_AGENT' || v === 1
}

// ── MinionHarness ───────────────────────────────────────────────────────────

/**
 * How long to keep polling after createInteraction while the user row is
 * still PENDING or we are waiting for the agent message.
 */
const POST_STEER_POLL_MS = 3 * 60 * 1000
/** Scratch chat.jsonl poll cadence — independent of slow getTask/listInteractions. */
const SCRATCH_POLL_INTERVAL_MS = 2_000

interface MinionSessionState {
  channel: EventChannel
  /** Minion task id we poll / steer / cancel (tip or live descendant). */
  remoteTaskId: string
  lastLatestUpdate: string
  /** Last first-person provisioning/status line we already posted (dedupe). */
  lastStatusLine: string
  /** Fingerprint of the last SETUP sdk_status we pushed (avoid spam). */
  lastSetupKey: string
  seenInteractionIds: Set<string>
  /** Normalized progress texts already shown — blocks latest_update ↔ interaction doubles. */
  postedTexts: Set<string>
  /** Texts we sent via streamInput — skipped when they echo back from listinteractions. */
  steeredTexts: Set<string>
  /** Set synchronously at interrupt so in-flight createinteraction cannot ack afterward. */
  closing: boolean
  startedAt: number
  /** Completion summary already posted — never re-announce COMPLETED on resume/re-poll. */
  completionPosted: boolean
  /** Last time the user steered; keeps polling alive after terminal to catch the reply. */
  lastSteeredAt: number
  /** createInteraction response id — wait until this row leaves PENDING. */
  pendingSteerInteractionId: string
  /** User steer row became RESPONDED; still waiting for AGENT message. */
  awaitingAgentAfterSteer: boolean
  /** True from Send until createInteraction returns (success or fail). */
  steerCreateInFlight: boolean
  /** Last observed getDevpods state for this tip (empty if unknown). */
  lastDevpodState: string
  /**
   * False on cold resume (empty memory): first poll absorbs existing
   * latest_update/interactions as already-seen without reprinting them.
   */
  historySeeded: boolean
  /** Append watermark for DevPod scratch chat.jsonl. */
  scratch: ScratchTailWatermark
  /** Fingerprint of last minion_working sdk_status (avoid spam). */
  lastWorkingKey: string
  /** Last scratch API error logged (dedupe warn spam). */
  lastScratchError: string
  /** Last successful getTask payload — scratch loop uses this without a second fetch. */
  lastTask: Record<string, any> | null
  /** Prevent overlapping scratch ticks. */
  scratchTickBusy: boolean
}

/** Durable memory across soft-stop / resume so we don't re-echo old interactions. */
interface MinionMemory {
  remoteTaskId: string
  lastLatestUpdate: string
  lastStatusLine: string
  seenInteractionIds: Set<string>
  postedTexts: Set<string>
  steeredTexts: Set<string>
  completionPosted: boolean
  scratch: ScratchTailWatermark
}

function normalizeProgressText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Short orchestrator status lines (e.g. "Processing message…") — keep these out
 * of the transcript; the working/Stop chrome already covers in-flight state.
 * Real answers are longer and become permanent assistant rows.
 */
function isEphemeralStatusText(text: string): boolean {
  const t = normalizeProgressText(text)
  if (!t) return true
  if (t.length > 80) return false
  return /^(processing|working|thinking|loading|pending|waiting|running|on it)\b/i.test(t) ||
    (/…|\.\.\.$/.test(t) && t.length <= 40)
}

export class MinionHarness implements HarnessDriver {
  private readonly sessions = new Map<string, MinionSessionState>()
  private readonly polls = new Map<string, AbortController>()
  /** Fast scratch-only loop so tool cards are not starved by slow gettask. */
  private readonly scratchLoops = new Map<string, ReturnType<typeof setInterval>>()
  /** Survives soft-stop so resume/follow-ups don't re-dump the whole transcript. */
  private readonly memory = new Map<string, MinionMemory>()
  /** Fired when remote-active (pre-complete poll) starts or stops — sidebar status. */
  private activityListener: ((sessionId: string) => void) | null = null
  /** Fired when a finished-task follow-up CreateTask returns a new child task id. */
  private remoteTaskListener: ((sessionId: string, remoteTaskId: string) => void) | null = null

  /** SessionManager wires this to `sendStatus` so poll start/stop refresh the sidebar. */
  setActivityListener(listener: ((sessionId: string) => void) | null): void {
    this.activityListener = listener
  }

  /** Persist active Minion task id (sdk_session_id) across app relaunch. */
  setRemoteTaskListener(listener: ((sessionId: string, remoteTaskId: string) => void) | null): void {
    this.remoteTaskListener = listener
  }

  private notifyActivity(sessionId: string): void {
    try {
      this.activityListener?.(sessionId)
    } catch (err) {
      logger.warn('minionHarness: activity listener failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private notifyRemoteTask(sessionId: string, remoteTaskId: string): void {
    try {
      this.remoteTaskListener?.(sessionId, remoteTaskId)
    } catch (err) {
      logger.warn('minionHarness: remote task listener failed', {
        sessionId,
        remoteTaskId,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(prompt: string, opts: HarnessStartOptions): Promise<HarnessSession> {
    const minion = opts.minion ?? { repo: 'go-code' as MinionRepo }
    const repo = REPO_ENUM[minion.repo] ?? REPO_ENUM['go-code']
    const created = await httpCreateTask({
      name: prompt.trim().split('\n')[0].slice(0, 80) || 'Atelier Minion task',
      prompt,
      runner: 'RUNNER_DEVPOD',
      agent: 'claude-code',
      parentTaskId: '',
      path: '.',
      input: {
        type: 'ARTIFACT_TYPE_BRANCH',
        code: { repo: repo.enum, branch: 'main', repoName: repo.name, orgName: 'uber-code' }
      },
      expectedArtifactType: 'ARTIFACT_TYPE_PR',
      storagePath: '',
      userId: '',
      jiraIds: [],
      mcpServers: [],
      model: '',
      metadata: { source: 'atelier' },
      aifxConfig: {},
      executionMode: 'EXECUTION_MODE_INTERACTIVE',
      planningMode: 'PLANNING_MODE_DIRECT',
      devpodOverrides: {}
    })
    const taskId: string | undefined = created.task?.id ?? created.id
    if (!taskId) throw new Error('Minion createTask returned no task id')

    const state = this.newState(taskId, { liveFromStart: true, remoteTaskId: taskId })
    const createdTask = (created.task as Record<string, any>) ?? { id: taskId, status: 'TASK_STATUS_PENDING' }
    state.lastTask = createdTask
    this.sessions.set(taskId, state)
    state.channel.push({
      type: 'session_started',
      sessionId: taskId,
      timestamp: new Date().toISOString(),
      model: 'minion',
      cwd: ''
    })
    pushAssistantMessage(
      state.channel,
      taskId,
      `On it — spinning up a DevPod on \`${repo.name}\` for this. Message me anytime while I work, or hit Stop to cancel.`,
      'minion_task_created'
    )
    this.pushSetupChrome(state, taskId, createdTask)
    this.ensurePolling(taskId)
    return { sessionId: taskId, events: state.channel[Symbol.asyncIterator]() }
  }

  async startWithId(_sessionId: string, prompt: string, opts: HarnessStartOptions): Promise<HarnessSession> {
    return this.start(prompt, opts)
  }

  /**
   * Attach to an existing Minion task (session id = task UUID). Verifies the
   * task via gettask, then polls without createtask.
   */
  async attach(taskId: string): Promise<HarnessSession> {
    const id = taskId.trim()
    if (!id) throw new Error('Minion attach requires a task id')
    let task: Record<string, any> | undefined
    try {
      const res = await httpGetTask(id)
      task = res.task
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Could not load Minion task ${id}: ${msg}`)
    }
    if (!task) throw new Error(`Minion task not found: ${id}`)

    const existing = this.sessions.get(id)
    if (existing && !existing.closing && !existing.channel.closed) {
      this.ensurePolling(id)
      return { sessionId: id, events: existing.channel[Symbol.asyncIterator]() }
    }
    if (existing) existing.channel.close()

    const state = this.newState(id, { remoteTaskId: id })
    state.lastTask = task
    this.sessions.set(id, state)
    state.channel.push({
      type: 'session_started',
      sessionId: id,
      timestamp: new Date().toISOString(),
      model: 'minion',
      cwd: ''
    })
    const label = typeof task.name === 'string' && task.name.trim() ? task.name.trim() : id
    pushAssistantMessage(
      state.channel,
      id,
      `Attached to existing Minion task **${label}**. Follow-ups steer the same job; Stop cancels it.`,
      'minion_attached'
    )
    this.pushSetupChrome(state, id, task)
    this.ensurePolling(id)
    return { sessionId: id, events: state.channel[Symbol.asyncIterator]() }
  }

  async resume(sessionId: string, opts?: Partial<HarnessStartOptions>): Promise<HarnessSession> {
    const activeFromOpts = opts?.minion?.activeTaskId?.trim()
    const existing = this.sessions.get(sessionId)
    if (existing && !existing.closing && !existing.channel.closed) {
      // Re-resolve: drop finished follow-up children; keep only a live target.
      const targetId = await this.resolveSteerTaskId(sessionId, existing)
      if (targetId !== existing.remoteTaskId) {
        existing.remoteTaskId = targetId
        this.notifyRemoteTask(sessionId, targetId)
        this.remember(sessionId, existing)
      } else if (activeFromOpts && activeFromOpts !== existing.remoteTaskId) {
        // Only adopt persisted sdk id when it is still the live target.
        const live = await this.findLiveTaskInTree(activeFromOpts, sessionId)
        if (live && String(live.id) === activeFromOpts) {
          existing.remoteTaskId = activeFromOpts
          this.remember(sessionId, existing)
        }
      }
      this.ensurePolling(sessionId)
      return { sessionId, events: existing.channel[Symbol.asyncIterator]() }
    }
    if (existing) existing.channel.close()

    const state = this.newState(sessionId, {
      remoteTaskId: activeFromOpts || this.memory.get(sessionId)?.remoteTaskId || sessionId
    })
    this.sessions.set(sessionId, state)
    const targetId = await this.resolveSteerTaskId(sessionId, state)
    if (targetId !== state.remoteTaskId) {
      state.remoteTaskId = targetId
      this.notifyRemoteTask(sessionId, targetId)
      this.remember(sessionId, state)
    }
    state.channel.push({
      type: 'session_started',
      sessionId,
      timestamp: new Date().toISOString(),
      model: 'minion',
      cwd: ''
    })
    // Always resume polling — follow-ups CreateInteraction on tip/live child.
    this.ensurePolling(sessionId)
    return { sessionId, events: state.channel[Symbol.asyncIterator]() }
  }

  /**
   * Drop local harness state without canceltask — Atelier session close that
   * should leave the Minion DevPod/tip alive for later attach.
   */
  async detach(sessionId: string): Promise<void> {
    const wasPolling = this.polls.has(sessionId)
    this.polls.get(sessionId)?.abort()
    this.polls.delete(sessionId)
    this.stopScratchLoop(sessionId)
    if (wasPolling) this.notifyActivity(sessionId)
    const state = this.sessions.get(sessionId)
    if (!state) return
    this.clearSetupChrome(state, sessionId)
    this.remember(sessionId, state)
    state.channel.close()
    this.sessions.delete(sessionId)
    logger.info('minionHarness: detached (remote tip kept)', {
      sessionId,
      remoteTaskId: state.remoteTaskId
    })
  }

  async interrupt(sessionId: string): Promise<void> {
    const wasPolling = this.polls.has(sessionId)
    this.polls.get(sessionId)?.abort()
    this.polls.delete(sessionId)
    this.stopScratchLoop(sessionId)
    if (wasPolling) this.notifyActivity(sessionId)
    const state = this.sessions.get(sessionId)
    // Mark closed before any await so a concurrent streamInput cannot push a
    // steer ack after cancel once createinteraction returns.
    if (state) {
      if (state.closing) return
      state.closing = true
      this.clearSetupChrome(state, sessionId)
    }
    const cancelId = state?.remoteTaskId ?? sessionId
    let summary = 'Stopped.'
    try {
      await httpCancelTask(cancelId)
      try {
        const { task } = await httpGetTask(cancelId)
        if (task) {
          summary = formatTaskSummary(
            { ...task, status: task.status ?? 'TASK_STATUS_CANCELLED' },
            { stopped: true }
          )
        }
      } catch {
        /* keep default */
      }
    } catch (err) {
      logger.warn('minionHarness: cancelTask failed', { sessionId, cancelId, error: String(err) })
      summary = `I tried to stop, but cancel failed: ${err instanceof Error ? err.message : String(err)}`
    }
    if (state && this.sessions.get(sessionId) === state) {
      pushAssistantMessage(state.channel, sessionId, summary, 'minion_cancelled')
      state.channel.push({ type: 'interrupted', sessionId, timestamp: new Date().toISOString() })
      this.remember(sessionId, state)
      state.channel.close()
      this.sessions.delete(sessionId)
    }
  }

  // ── messaging ────────────────────────────────────────────────────────────

  /** Serialize steers per session so a double-send cannot mint two DevPods. */
  private readonly steerChain = new Map<string, Promise<void>>()

  async streamInput(sessionId: string, message: string, _attachments?: HarnessFileInput[]): Promise<void> {
    const prev = this.steerChain.get(sessionId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    this.steerChain.set(
      sessionId,
      prev.then(() => gate).catch(() => gate)
    )
    await prev.catch(() => undefined)
    try {
      await this.streamInputLocked(sessionId, message)
    } finally {
      release()
    }
  }

  private async streamInputLocked(sessionId: string, message: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing || state.channel.closed) {
      logger.warn('minionHarness: streamInput for unknown/closing session', { sessionId })
      return
    }
    const text = message.trim()
    if (!text) return
    state.steeredTexts.add(text)
    state.lastSteeredAt = Date.now()
    state.steerCreateInFlight = true
    state.completionPosted = false
    state.awaitingAgentAfterSteer = false

    // Prefer a not-yet-ready descendant; otherwise tip (= session id).
    const targetId = await this.resolveSteerTaskId(sessionId, state)
    if (targetId !== state.remoteTaskId) {
      state.remoteTaskId = targetId
      this.notifyRemoteTask(sessionId, targetId)
    }
    this.remember(sessionId, state)
    this.ensurePolling(sessionId)
    this.notifyActivity(sessionId)
    await this.createInteractionOnRemote(sessionId, state, text)
  }

  /** Live (not ready) child if any; else the tip (= Atelier session id). */
  private async resolveSteerTaskId(
    sessionId: string,
    state: MinionSessionState
  ): Promise<string> {
    const live = await this.findLiveTaskInTree(state.remoteTaskId || sessionId, sessionId)
    const liveId = live ? String(live.id ?? '').trim() : ''
    if (liveId) return liveId
    return sessionId
  }

  private async createInteractionOnRemote(
    sessionId: string,
    state: MinionSessionState,
    text: string
  ): Promise<void> {
    try {
      const { interaction } = await httpCreateInteraction(state.remoteTaskId || sessionId, text)
      const id = String(interaction.id ?? '').trim()
      const status = String(interaction.status ?? '')
      state.pendingSteerInteractionId = id
      state.awaitingAgentAfterSteer = false
      state.steerCreateInFlight = false
      state.completionPosted = false
      state.lastSteeredAt = Date.now()
      this.remember(sessionId, state)
      logger.info('minionHarness: createInteraction ok', {
        sessionId,
        remoteTaskId: state.remoteTaskId,
        interactionId: id,
        status
      })
    } catch (err) {
      state.steeredTexts.delete(text)
      state.pendingSteerInteractionId = ''
      state.awaitingAgentAfterSteer = false
      state.steerCreateInFlight = false
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('minionHarness: createInteraction failed', { sessionId, error: msg })
      if (this.sessions.get(sessionId) === state && !state.closing && !state.channel.closed) {
        state.channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg })
      }
      return
    }
    if (this.sessions.get(sessionId) !== state || state.closing || state.channel.closed) return
    this.ensurePolling(sessionId)
  }

  /**
   * Walk preferred tip + Atelier session root for a task that is not ready yet
   * (`isTaskFinished` = terminal status or display_status COMPLETED). Newest
   * children first. Ready tasks are skipped so we do not treat display-COMPLETED
   * + status-RUNNING as "still working."
   */
  private async findLiveTaskInTree(
    preferredId: string,
    rootId: string
  ): Promise<Record<string, any> | null> {
    const seen = new Set<string>()
    const search = async (id: string, depth: number): Promise<Record<string, any> | null> => {
      const tid = id.trim()
      if (!tid || depth > 8 || seen.has(tid)) return null
      seen.add(tid)
      let task: Record<string, any> | undefined
      try {
        const res = await httpGetTask(tid)
        task = res.task
      } catch {
        return null
      }
      if (!task) return null
      if (!isTaskFinished(task)) return task
      const kids = Array.isArray(task.child_task_ids)
        ? (task.child_task_ids as unknown[]).map((k) => String(k)).filter(Boolean)
        : []
      for (const kid of [...kids].reverse()) {
        const found = await search(kid, depth + 1)
        if (found) return found
      }
      return null
    }
    return (await search(preferredId, 0)) ?? (preferredId === rootId ? null : search(rootId, 0))
  }

  isActive(sessionId: string): boolean {
    // True while we still own a live channel — including after soft-stop on a
    // completed task — so follow-ups take the streamInput fast path instead of
    // resume()-ing a second iterator on the same EventChannel.
    const state = this.sessions.get(sessionId)
    return !!state && !state.closing && !state.channel.closed
  }

  /** True while gettask/listinteractions polling is in flight. */
  isPolling(sessionId: string): boolean {
    return this.polls.has(sessionId)
  }

  /**
   * Sidebar/composer "working": polling a task that is not ready yet.
   * After CreateInteraction, stay working until a post-steer update arrives —
   * stale display COMPLETED from the prior turn must not clear Stop.
   */
  isRemoteActive(sessionId: string): boolean {
    if (!this.polls.has(sessionId)) return false
    const state = this.sessions.get(sessionId)
    if (!state || state.closing || state.completionPosted) return false
    if (this.awaitingSteerReply(state)) return true
    if (state.lastTask && isTaskFinished(state.lastTask)) return false
    return true
  }

  /**
   * True while createInteraction's user row is still PENDING, or RESPONDED but
   * we have not yet seen a new AGENT message. Tip CANCELLED/COMPLETED alone
   * must not clear this — stale latest_update is not the steer answer.
   */
  private awaitingSteerReply(state: MinionSessionState): boolean {
    if (state.lastSteeredAt <= 0) return false
    if (Date.now() - state.lastSteeredAt >= POST_STEER_POLL_MS) return false
    if (state.steerCreateInFlight) return true
    if (state.pendingSteerInteractionId) return true
    if (state.awaitingAgentAfterSteer) return true
    return false
  }

  // ── stubs ────────────────────────────────────────────────────────────────

  async validateModel(_sessionId: string, _model: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: false, error: 'Model selection is not supported for Minion sessions.' }
  }

  async validateClaudeModel(_model: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: false, error: 'Model selection is not supported for Minion sessions.' }
  }

  async getContextUsage(_sessionId: string): Promise<{ totalTokens: number; contextWindow: number } | null> {
    return null
  }

  async respondToPrompt(_sessionId: string, _requestId: string, _response: PromptResponse): Promise<void> {}

  async setPermissionMode(_sessionId: string, _mode: string): Promise<void> {}

  async listFiles(sessionId: string): Promise<Array<{ name: string; url: string }>> {
    try {
      const remoteId = this.sessions.get(sessionId)?.remoteTaskId ?? sessionId
      const { task } = await httpGetTask(remoteId)
      const pr = task ? findPrUrl(task.output) : null
      return pr ? [{ name: 'Pull request', url: pr }] : []
    } catch {
      return []
    }
  }

  // ── polling ──────────────────────────────────────────────────────────────

  private newState(
    sessionId?: string,
    opts?: { liveFromStart?: boolean; remoteTaskId?: string }
  ): MinionSessionState {
    const mem = sessionId ? this.memory.get(sessionId) : undefined
    return {
      channel: new EventChannel(),
      remoteTaskId: opts?.remoteTaskId ?? mem?.remoteTaskId ?? sessionId ?? '',
      lastLatestUpdate: mem?.lastLatestUpdate ?? '',
      lastStatusLine: mem?.lastStatusLine ?? '',
      lastSetupKey: '',
      seenInteractionIds: mem ? new Set(mem.seenInteractionIds) : new Set(),
      postedTexts: mem ? new Set(mem.postedTexts) : new Set(),
      steeredTexts: mem ? new Set(mem.steeredTexts) : new Set(),
      closing: false,
      startedAt: Date.now(),
      completionPosted: mem?.completionPosted ?? false,
      lastSteeredAt: 0,
      pendingSteerInteractionId: '',
      awaitingAgentAfterSteer: false,
      steerCreateInFlight: false,
      lastDevpodState: '',
      // Fresh createTask: show live updates. Cold resume with no memory: seed first.
      historySeeded: opts?.liveFromStart === true || mem != null,
      scratch: mem?.scratch ? { ...mem.scratch } : emptyScratchWatermark(),
      lastWorkingKey: '',
      lastScratchError: '',
      lastTask: null,
      scratchTickBusy: false
    }
  }

  private remember(sessionId: string, state: MinionSessionState): void {
    this.memory.set(sessionId, {
      remoteTaskId: state.remoteTaskId,
      lastLatestUpdate: state.lastLatestUpdate,
      lastStatusLine: state.lastStatusLine,
      seenInteractionIds: new Set(state.seenInteractionIds),
      postedTexts: new Set(state.postedTexts),
      steeredTexts: new Set(state.steeredTexts),
      completionPosted: state.completionPosted,
      scratch: { ...state.scratch }
    })
  }

  /** Push a progress row once — drops latest_update ↔ interaction doubles and ephemeral status. */
  private pushProgressOnce(state: MinionSessionState, sessionId: string, text: string): boolean {
    const key = normalizeProgressText(text)
    if (!key || state.postedTexts.has(key)) return false
    // Still remember ephemeral lines so a later identical latest_update doesn't slip through
    // after we skipped posting — but don't add a transcript row for them.
    if (isEphemeralStatusText(text)) {
      state.postedTexts.add(key)
      return false
    }
    state.postedTexts.add(key)
    pushAssistantMessage(state.channel, sessionId, text, 'minion_progress')
    return true
  }

  /** Soft-stop polling but keep memory so follow-ups don't re-echo history. */
  private softStop(sessionId: string, state: MinionSessionState): void {
    this.clearStatusChrome(state, sessionId)
    this.remember(sessionId, state)
    this.stopScratchLoop(sessionId)
    const wasPolling = this.polls.has(sessionId)
    this.polls.get(sessionId)?.abort()
    this.polls.delete(sessionId)
    if (wasPolling) this.notifyActivity(sessionId)
  }

  private ensureScratchLoop(sessionId: string): void {
    if (this.scratchLoops.has(sessionId)) return
    const handle = setInterval(() => {
      void this.tickScratch(sessionId)
    }, SCRATCH_POLL_INTERVAL_MS)
    this.scratchLoops.set(sessionId, handle)
    void this.tickScratch(sessionId)
  }

  private stopScratchLoop(sessionId: string): void {
    const handle = this.scratchLoops.get(sessionId)
    if (handle) clearInterval(handle)
    this.scratchLoops.delete(sessionId)
  }

  /** Scratch-only tick — must not wait on gettask (that path starves tool cards). */
  private async tickScratch(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing || state.channel.closed || state.completionPosted) {
      this.stopScratchLoop(sessionId)
      return
    }
    const task = state.lastTask
    if (!task) return
    await this.pollScratch(sessionId, state, task, new AbortController().signal)
    if (state.scratch.healthy && state.lastSetupKey !== '') {
      state.lastSetupKey = ''
    }
  }

  /**
   * Before announcing Done: keep trying scratch until chat.jsonl has been seeded
   * (or grace expires). DNS often lags name/URL/`RUNNING` by tens of seconds.
   */
  private async flushScratchForCompletion(
    sessionId: string,
    state: MinionSessionState,
    task: Record<string, any>,
    signal: AbortSignal
  ): Promise<void> {
    const deadline = Date.now() + 45_000
    while (!signal.aborted && Date.now() < deadline) {
      state.lastTask = task
      await this.pollScratch(sessionId, state, task, signal, {
        waitForBusyMs: SCRATCH_FETCH_TIMEOUT_MS
      })
      if (state.scratch.seeded) {
        await this.pollScratch(sessionId, state, task, signal, {
          waitForBusyMs: SCRATCH_FETCH_TIMEOUT_MS
        })
        return
      }
      await sleep(2_000, signal)
    }
    await this.pollScratch(sessionId, state, task, signal, {
      waitForBusyMs: SCRATCH_FETCH_TIMEOUT_MS
    })
  }

  private clearStatusChrome(state: MinionSessionState, sessionId: string): void {
    if (state.lastSetupKey === '' && state.lastWorkingKey === '') return
    state.lastSetupKey = ''
    state.lastWorkingKey = ''
    if (state.channel.closed) return
    state.channel.push({
      type: 'sdk_status',
      sessionId,
      timestamp: new Date().toISOString(),
      status: null
    })
  }

  private clearSetupChrome(state: MinionSessionState, sessionId: string): void {
    this.clearStatusChrome(state, sessionId)
  }

  private pushSetupChrome(state: MinionSessionState, sessionId: string, task: Record<string, any>): void {
    if (state.closing || state.channel.closed) return
    const setup = deriveMinionSetup(task, { devpodState: state.lastDevpodState })
    if (!setup) {
      // Setup done — free the slot for working chrome while remote is active.
      state.lastSetupKey = ''
      if (state.completionPosted) {
        this.clearStatusChrome(state, sessionId)
      } else if (state.lastWorkingKey === '') {
        // Only seed a generic Working card when scratch hasn't set one yet.
        this.pushWorkingChrome(state, sessionId, {
          title: 'Working…',
          detail: extractDisplayStatus(task) || 'Connected to DevPod — waiting for tools.'
        })
      }
      return
    }
    state.lastWorkingKey = ''
    const key = `${setup.active}|${setup.title}|${setup.detail}`
    if (key === state.lastSetupKey) return
    state.lastSetupKey = key
    state.channel.push({
      type: 'sdk_status',
      sessionId,
      timestamp: new Date().toISOString(),
      status: 'minion_setup',
      title: setup.title,
      detail: setup.detail,
      setupSteps: setup.steps
    })
  }

  private pushWorkingChrome(
    state: MinionSessionState,
    sessionId: string,
    chrome: ScratchProgressChrome
  ): void {
    if (state.closing || state.channel.closed || state.completionPosted) return
    // SETUP owns the slot until deriveMinionSetup clears.
    if (state.lastSetupKey !== '') return
    const key = `${chrome.title}|${chrome.detail}`
    if (key === state.lastWorkingKey) return
    state.lastWorkingKey = key
    state.channel.push({
      type: 'sdk_status',
      sessionId,
      timestamp: new Date().toISOString(),
      status: 'minion_working',
      title: chrome.title,
      detail: chrome.detail
    })
  }

  /** True when Working chrome is only a scratch-not-ready placeholder. */
  private isScratchWaitChrome(state: MinionSessionState): boolean {
    const key = state.lastWorkingKey
    return (
      key.startsWith('Connecting to session') ||
      key.includes('waiting for tools') ||
      key.includes('Waiting for scratch') ||
      key.includes('Streaming session progress')
    )
  }

  /**
   * Prefer live orchestrator status (latest_update / display_status) over the
   * "Waiting for scratch chat.jsonl" placeholder once the job is past SETUP.
   */
  private pushOrchestratorWorkingChrome(
    state: MinionSessionState,
    sessionId: string,
    task: Record<string, any>
  ): void {
    if (state.completionPosted || state.lastSetupKey !== '') return
    const display = extractDisplayStatus(task)
    const update = extractLatestUpdate(task)
    if (!display && !update) return
    // Don't clobber richer scratch-derived chrome (Running X / N× Executing…)
    // unless we only had the wait placeholder.
    if (
      state.lastWorkingKey !== '' &&
      !this.isScratchWaitChrome(state) &&
      state.scratch.seeded
    ) {
      return
    }
    this.pushWorkingChrome(state, sessionId, {
      title: display || 'Working…',
      detail: update ? update.replace(/\s+/g, ' ').trim().slice(0, 220) : 'Agent is running'
    })
  }

  /**
   * Tail DevPod scratch chat.jsonl when metadata has devpodName/region.
   * Soft-degrades on API errors — orchestrator polling continues.
   */
  private async pollScratch(
    sessionId: string,
    state: MinionSessionState,
    task: Record<string, any>,
    signal: AbortSignal,
    opts?: { waitForBusyMs?: number }
  ): Promise<void> {
    // Serialize gettask-path flushes with the dedicated scratch interval.
    // Terminal flushes must wait — skipping while busy posted Done with no tools.
    const waitMs = opts?.waitForBusyMs ?? 0
    const waitDeadline = Date.now() + waitMs
    while (state.scratchTickBusy) {
      if (waitMs <= 0 || Date.now() >= waitDeadline || signal.aborted) return
      await sleep(50, signal)
    }
    if (signal.aborted) return
    state.scratchTickBusy = true
    try {
      await this.pollScratchBody(sessionId, state, task, signal)
    } finally {
      state.scratchTickBusy = false
    }
  }

  private async pollScratchBody(
    sessionId: string,
    state: MinionSessionState,
    task: Record<string, any>,
    signal: AbortSignal
  ): Promise<void> {
    const target: DevpodScratchTarget | null = extractDevpodTarget(state.remoteTaskId || sessionId, task)
    if (!target) {
      state.scratch.healthy = false
      this.pushOrchestratorWorkingChrome(state, sessionId, task)
      return
    }
    try {
      const entries = await listScratchFiles(target)
      if (signal.aborted) return
      const chat = entries.find((e) => e.path === 'chat.jsonl' || e.path.endsWith('/chat.jsonl'))
      if (!chat) {
        state.scratch.healthy = false
        // Never re-show the wait placeholder after we've already streamed tools —
        // that stomps real "Running Bash / N× Executing" status (Minion Task Init).
        if (
          !state.completionPosted &&
          state.lastSetupKey === '' &&
          !state.scratch.seeded &&
          (state.lastWorkingKey === '' || this.isScratchWaitChrome(state))
        ) {
          this.pushOrchestratorWorkingChrome(state, sessionId, task)
          if (state.lastWorkingKey === '' || this.isScratchWaitChrome(state)) {
            this.pushWorkingChrome(state, sessionId, {
              title: 'Connecting to session…',
              detail: 'Waiting for scratch chat.jsonl on the DevPod.'
            })
          }
        } else {
          this.pushOrchestratorWorkingChrome(state, sessionId, task)
        }
        return
      }
      const sizeBytes = chat.sizeBytes ?? -1
      const mtime = chat.modifiedTimeUnix ?? 0
      // Only skip when Minion gave real size+mtime (API often sends strings —
      // parsed in listScratchFiles). Missing metadata used to be -1/0 forever,
      // so after the first seed we never re-fetched growing chat.jsonl.
      if (
        state.scratch.seeded &&
        sizeBytes >= 0 &&
        mtime > 0 &&
        sizeBytes === state.scratch.sizeBytes &&
        mtime === state.scratch.mtime
      ) {
        state.scratch.healthy = true
        return
      }
      const content = await getFileContents(target, 'chat.jsonl')
      if (signal.aborted) return
      const { events, chrome, texts, next } = consumeScratchAppend(sessionId, content, state.scratch)
      next.sizeBytes = sizeBytes
      next.mtime = mtime
      state.scratch = next
      state.lastScratchError = ''
      for (const t of texts) {
        state.postedTexts.add(normalizeProgressText(t))
      }
      for (const ev of events) {
        if (state.closing || state.channel.closed || signal.aborted) break
        state.channel.push(ev)
      }
      // Scratch stream means the runner is live enough to leave SETUP.
      if (state.lastSetupKey !== '') state.lastSetupKey = ''
      if (chrome) this.pushWorkingChrome(state, sessionId, chrome)
      else if (!state.completionPosted && (state.lastWorkingKey === '' || this.isScratchWaitChrome(state))) {
        this.pushOrchestratorWorkingChrome(state, sessionId, task)
        if (state.lastWorkingKey === '' || this.isScratchWaitChrome(state)) {
          this.pushWorkingChrome(state, sessionId, {
            title: 'Working…',
            detail: 'Streaming session progress from the DevPod.'
          })
        }
      }
      this.notifyActivity(sessionId)
    } catch (err) {
      state.scratch.healthy = false
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== state.lastScratchError) {
        state.lastScratchError = msg
        logger.warn('minionHarness: scratch poll failed (orchestrator continues)', {
          sessionId,
          error: msg.slice(0, 240)
        })
      }
      // Keep orchestrator progress; never fall back to the wait placeholder after
      // a transient scratch DNS/API blip mid-run.
      this.pushOrchestratorWorkingChrome(state, sessionId, task)
    }
  }

  private ensurePolling(sessionId: string): void {
    this.ensureScratchLoop(sessionId)
    if (this.polls.has(sessionId)) return
    void this.pollUntilDone(sessionId)
  }

  private async pollUntilDone(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    const abort = new AbortController()
    this.polls.set(sessionId, abort)
    this.ensureScratchLoop(sessionId)
    this.notifyActivity(sessionId)
    const { channel } = state
    const deadline = Date.now() + POLL_TIMEOUT_MS
    let errors = 0

    try {
      while (!abort.signal.aborted && Date.now() < deadline) {
        try {
          const taskId = state.remoteTaskId || sessionId
          const { task } = await httpGetTask(taskId)
          if (abort.signal.aborted) return
          errors = 0
          if (task) {
            state.lastTask = task
            const update = extractLatestUpdate(task)

            // Cold resume: mark everything currently visible as already-seen so we
            // don't reprint the whole transcript, then wait for genuinely new rows.
            if (!state.historySeeded) {
              if (update) {
                state.lastLatestUpdate = update
                state.postedTexts.add(normalizeProgressText(update))
              }
              const listed = await httpListInteractions(taskId)
              if (abort.signal.aborted) return
              for (const i of listed.interactions) {
                const id = String(i.id ?? '')
                if (id) state.seenInteractionIds.add(id)
                const text = interactionText(i)
                if (text) state.postedTexts.add(normalizeProgressText(text))
              }
              if (isTaskFinished(task) && !state.pendingSteerInteractionId) {
                state.completionPosted = true
              }
              state.historySeeded = true
              this.remember(sessionId, state)
              this.notifyActivity(sessionId)
              this.pushSetupChrome(state, sessionId, task)
              await this.pollScratch(sessionId, state, task, abort.signal)
              continue
            }

            // DevPod state for scratch gating after resume/steer.
            try {
              const pods = await httpGetDevpods()
              const target = extractDevpodTarget(taskId, task)
              const info = findDevpodForTask(pods, taskId, target?.devpodName)
              if (info) state.lastDevpodState = info.state
            } catch {
              /* getDevpods optional */
            }
            if (abort.signal.aborted) return

            if (update && update !== state.lastLatestUpdate) {
              state.lastLatestUpdate = update
              // While waiting on a steer, never promote stale latest_update into
              // the transcript — that was the CANCELLED + Torchlight false answer.
              if (!this.awaitingSteerReply(state)) {
                if (!state.scratch.healthy) {
                  this.pushProgressOnce(state, sessionId, update)
                } else {
                  state.postedTexts.add(normalizeProgressText(update))
                }
              }
            }

            const finished = isTaskFinished(task)
            let waitingOnSteer = this.awaitingSteerReply(state)

            if (!state.scratch.healthy && (!finished || waitingOnSteer)) {
              this.pushSetupChrome(state, sessionId, task)
              this.pushOrchestratorWorkingChrome(state, sessionId, task)
            }

            // Scratch tools once DevPod is running (or we are not mid-steer on a dead pod).
            const podUp =
              !state.lastDevpodState || isDevpodRunningState(state.lastDevpodState)
            if (podUp || state.scratch.healthy) {
              if (finished && !waitingOnSteer) {
                await this.flushScratchForCompletion(sessionId, state, task, abort.signal)
              } else {
                await this.pollScratch(sessionId, state, task, abort.signal)
              }
            }
            if (abort.signal.aborted) return

            let sawNewAgentInteraction = false
            const listed = await httpListInteractions(taskId)
            if (abort.signal.aborted) return
            const interactions = listed.interactions

            // Track createInteraction user row: PENDING → RESPONDED/EXPIRED/CANCELLED.
            if (state.pendingSteerInteractionId) {
              const steerRow = interactions.find(
                (i) => String(i.id ?? '') === state.pendingSteerInteractionId
              )
              if (steerRow) {
                const st = String(steerRow.status ?? '')
                if (st === INTERACTION_RESPONDED) {
                  state.pendingSteerInteractionId = ''
                  state.awaitingAgentAfterSteer = true
                  logger.info('minionHarness: steer interaction RESPONDED', {
                    sessionId,
                    response: String(steerRow.response ?? '').slice(0, 80)
                  })
                } else if (st === INTERACTION_EXPIRED || st === INTERACTION_CANCELLED) {
                  state.pendingSteerInteractionId = ''
                  state.awaitingAgentAfterSteer = false
                  logger.warn('minionHarness: steer interaction settled without respond', {
                    sessionId,
                    status: st
                  })
                } else if (st && st !== INTERACTION_PENDING) {
                  state.pendingSteerInteractionId = ''
                }
              }
            }

            for (const i of interactions) {
              const id = String(i.id ?? '')
              if (id && state.seenInteractionIds.has(id)) continue
              if (id) state.seenInteractionIds.add(id)

              // User rows: skip echo of our steer text; never treat ack as answer.
              if (isUserInitiator(i.initiator)) {
                const text = interactionText(i)
                if (text) state.postedTexts.add(normalizeProgressText(text))
                continue
              }

              if (!isAgentInitiator(i.initiator)) continue
              const text = interactionText(i)
              if (!text) continue
              if (!this.pushProgressOnce(state, sessionId, text)) continue
              sawNewAgentInteraction = true
              if (state.awaitingAgentAfterSteer) {
                state.awaitingAgentAfterSteer = false
              }
            }

            waitingOnSteer = this.awaitingSteerReply(state)

            // Still waiting on PENDING / agent answer — keep Working, no Done.
            if (waitingOnSteer) {
              this.pushOrchestratorWorkingChrome(state, sessionId, task)
              this.remember(sessionId, state)
            } else if (isTaskFinished(task)) {
              if (!state.completionPosted && !state.closing) {
                state.completionPosted = true
                this.clearStatusChrome(state, sessionId)
                if (!sawNewAgentInteraction && state.lastSteeredAt <= 0) {
                  // Idle completion only — never recycle latest_update after a steer.
                  pushAssistantMessage(
                    channel,
                    sessionId,
                    formatTaskSummary(task),
                    'end_turn',
                    taskCost(task)
                  )
                } else {
                  channel.push({
                    type: 'result',
                    sessionId,
                    timestamp: new Date().toISOString(),
                    subtype: 'end_turn',
                    isError: false,
                    numTurns: 1,
                    durationMs: 0,
                    totalCostUsd: taskCost(task),
                    usage: null
                  })
                }
                this.notifyActivity(sessionId)
              }
              this.softStop(sessionId, state)
              return
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          errors++
          if (errors >= MAX_CONSECUTIVE_POLL_ERRORS) {
            logger.error('minionHarness: poll error (giving up)', { sessionId, error: msg })
            if (!state.closing) {
              channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg, retryable: true })
              this.softStop(sessionId, state)
            }
            return
          }
          logger.warn('minionHarness: poll error (retrying)', { sessionId, error: msg })
        }
        const early = Date.now() - state.startedAt < EARLY_POLL_WINDOW_MS
        const postSteer = state.lastSteeredAt > 0 && Date.now() - state.lastSteeredAt < POST_STEER_POLL_MS
        await sleep(early || postSteer ? EARLY_POLL_INTERVAL_MS : POLL_INTERVAL_MS, abort.signal)
      }
    } finally {
      if (this.polls.get(sessionId) === abort) {
        this.polls.delete(sessionId)
        this.notifyActivity(sessionId)
      }
      const live = this.sessions.get(sessionId)
      if (live === state && !state.closing) this.remember(sessionId, state)
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}
