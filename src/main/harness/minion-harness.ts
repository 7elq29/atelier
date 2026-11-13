/**
 * MinionHarness — HarnessDriver backed by the Uber Minion orchestrator.
 *
 * Transport (match Minion Web / uTerm):
 * - Orchestrator HTTP: create/attach, getTask, getDevpods, SETUP; RPC send /
 *   answer only when the worker socket is not live (wake). Never cancelTask.
 * - DevPod worker WebSocket when pod is RUNNING: seq-keyed event fold owns the
 *   transcript; Working = worker_state === 2; USER_MESSAGE / elicitation /
 *   INTERRUPT when live.
 * - Sleeping tip on attach: `devpodStart` to restore the pod (Minion web RPC),
 *   SETUP Boot while waking, then WS replay. Scratch `getFileContents` needs a
 *   live DevPod DNS name — it is not TaskStorage and fails while SNAPSHOTTED.
 * - After wake / while RUNNING: worker socket fold owns the transcript
 *   (`resetOnConnect` replaces any prior storage attempt).
 *
 * Session-id contract: the Minion task UUID is used directly as the Atelier
 * session id (same convention as CortanaHarness).
 *
 * See Features/minion-websocket-session/spec.md.
 */

import { logger } from '../logger'
import { parseMinionElicitation } from '../../shared/minion-elicitation'
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
  elicitationResponseCommand,
  interruptCommand,
  isWorkerRunning,
  MinionWorkerSocket,
  userMessageCommand,
  type MinionConnectedParams,
  type MinionWorkerEvent
} from './minion-worker-socket'
import {
  classifyDevpodPhase,
  findDevpodForTask,
  httpCreateInteraction,
  httpCreateTask,
  httpDevpodStart,
  httpGetDevpods,
  httpGetTask,
  buildMinionSteerMessage,
  httpListInteractions,
  isDevpodRunningState,
  isDevpodSleepingState,
  isDevpodStartingState
} from './minion-http-client'
import {
  consumeScratchAppend,
  emptyScratchWatermark,
  type ScratchProgressChrome,
  type ScratchTailWatermark
} from './minion-scratch-tail'
import { MinionWorkerFold, parseChatJsonl } from './minion-worker-fold'
import {
  minionRpcAttachmentsFit,
  prepareAttachmentsForMinionRpc,
  prepareAttachmentsForMinionWs
} from './minion-attachments'

export const POLL_INTERVAL_MS = 5000
/** Slower orchestrator poll while the worker socket owns the transcript. */
const POLL_INTERVAL_LIVE_MS = 15_000
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

/** Agent is blocked on a structured question — not "working". */
function isAwaitingUserInput(task: Record<string, any>): boolean {
  return /USER_INPUT/i.test(String(task.status ?? ''))
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
 * Minion UI / uTerm SETUP stages:
 *   !devpodName || !devpodRegion → provision
 *   else if worker handshake (`onConnected` / moveStartup('connect')) → connect
 *   else → boot
 *
 * Connect is NOT merely getDevpods RUNNING — Minion stays on Boot while the
 * pod is assigned/running but the worker socket has not connected yet.
 *
 * Card dismissal is NOT decided here — harness `completeStartup()` mirrors
 * uTerm (first user turn on create, or replay on attach).
 */
function deriveMinionSetup(
  task: Record<string, any>,
  opts?: {
    devpodState?: string
    wakeIntent?: boolean
    setupComplete?: boolean
    /** uTerm onConnected → moveStartup('connect'). */
    workerLinked?: boolean
  }
): {
  active: SetupStepId
  title: string
  detail: string
  steps: Array<{ id: SetupStepId; label: string; state: SetupStepState }>
} | null {
  if (opts?.setupComplete) return null

  const podState = String(opts?.devpodState ?? '').toUpperCase()
  const phase = classifyDevpodPhase(podState)
  const podRunning = phase === 'running'
  const wakeIntent = opts?.wakeIntent === true
  const workerLinked = opts?.workerLinked === true
  const taskId = String(task.id ?? task.task_id ?? '').trim() || 'task'
  const target = extractDevpodTarget(taskId, task)
  const hasPod = Boolean(target)
  const finished = isTaskFinished(task)

  // Asleep tip: stay quiet until the user steers (wake).
  if (phase === 'sleeping' && !wakeIntent) return null
  if ((phase === 'failed' || phase === 'unknown') && hasPod && finished && !wakeIntent) {
    return null
  }

  // Provision → Boot until worker handshake → Connect (not RUNNING alone).
  const active: SetupStepId = !hasPod ? 'provision' : workerLinked ? 'connect' : 'boot'

  const order: SetupStepId[] = ['provision', 'boot', 'connect']
  const idx = order.indexOf(active)
  const steps = order.map((id, i) => ({
    id,
    label: id === 'provision' ? 'Provision' : id === 'boot' ? 'Boot' : 'Connect',
    state: (i < idx ? 'done' : i === idx ? 'active' : 'pending') as SetupStepState
  }))

  const waking = wakeIntent || phase === 'starting' || (finished && !podRunning)
  const titles: Record<SetupStepId, string> = {
    provision: 'Provisioning DevPod…',
    boot: waking || podRunning ? 'Starting DevPod…' : 'Booting environment…',
    connect: 'Connecting to DevPod…'
  }
  const details: Record<SetupStepId, string> = {
    provision: 'Allocating a DevPod for this task — this can take a minute.',
    boot: podRunning
      ? 'DevPod reports running. Waiting until the worker is reachable.'
      : podState
        ? `DevPod state ${podState.replace(/^STATE_/, '')}. Waiting until it is running.`
        : finished
          ? 'DevPod is not running. Waiting for it to start for this tip.'
          : 'DevPod is starting up. I will keep this card updated.',
    connect: 'Linking to the worker on the DevPod…'
  }

  return { active, title: titles[active], detail: details[active], steps }
}

function interactionText(i: Record<string, any>): string {
  const t = i.content?.text ?? i.message
  return typeof t === 'string' ? t.trim() : ''
}

function isElicitationInteraction(i: Record<string, any>): boolean {
  const ctype = String(i.content?.type ?? '')
  if (ctype.includes('ELICITATION')) return true
  return parseMinionElicitation(interactionText(i)) != null
}

function isUserInitiator(v: unknown): boolean {
  return v === 'INTERACTION_INITIATOR_USER' || v === 2
}

function isAgentInitiator(v: unknown): boolean {
  return v === 'INTERACTION_INITIATOR_AGENT' || v === 1
}

// ── MinionHarness ───────────────────────────────────────────────────────────

/**
 * Fast poll while a steer is in flight (PENDING user row or waiting on AGENT).
 * Success is event-driven — not a wall-clock timeout (see awaitingSteerReply).
 */
const STEER_FAST_POLL_MS = 3 * 60 * 1000
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
  /** Live DevPod worker socket (opened when pod is STATE_RUNNING). */
  workerSocket: MinionWorkerSocket | null
  /** Last worker_state from connected / status_change (undefined until handshake). */
  workerState: number | undefined
  /**
   * Worker JSON-RPC `connected` received (uTerm onConnected). Cleared on
   * disconnect so SETUP drops back to Boot while reconnecting.
   */
  workerLinked: boolean
  /** DevPod name|region the current socket was opened for. */
  workerSocketKey: string
  /** Seq-keyed fold of worker / storage events → transcript. */
  fold: MinionWorkerFold
  /** True once storage or WS fold has applied at least one event batch. */
  foldHealthy: boolean
  /** Storage chat.jsonl already folded (sleeping attach). */
  storageFoldDone: boolean
  /**
   * Next WS replay should wipe SessionManager messages and rebuild from a
   * full replay (wake after storage fold / RPC send while asleep).
   */
  resetOnConnect: boolean
  /**
   * Attach/resume asked Minion to restore a sleeping DevPod (`devpodStart`).
   * Counts as wakeIntent for SETUP Boot until WS fold is healthy.
   */
  attachWakeRequested: boolean
  /** uTerm justCreated — SETUP ends on first user turn, not on replay alone. */
  justCreated: boolean
  /** uTerm firstTurn latch — waiting for worker to take the create prompt. */
  firstTurnPending: boolean
  /** uTerm completeStartup — SETUP card dismissed. */
  setupComplete: boolean
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
  lastAppliedSeq?: number
  foldHealthy?: boolean
  storageFoldDone?: boolean
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
  /** Buffered assistant text from live WS text_delta (flushed on status leave running). */
  private readonly liveTextBySession = new Map<string, string>()

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
    // Seed the create prompt on the harness clock (same thread as later fold
    // events). SessionManager must not insert user rows on a parallel clock.
    // WS replay of the same user_message is deduped in the manager.
    if (prompt.trim()) {
      state.channel.push({
        type: 'transcript_user_message',
        sessionId: taskId,
        timestamp: new Date().toISOString(),
        text: prompt.trim()
      })
      state.steeredTexts.add(prompt.trim())
    }
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
    // Fresh EventChannel — prior memory must not suppress wake / full replay.
    state.foldHealthy = false
    state.storageFoldDone = false
    state.resetOnConnect = true
    state.completionPosted = false
    state.historySeeded = false
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
    // uTerm: leave SETUP open; first getDevpods + syncStartup pick Boot/Connect
    // (or quiet if sleeping). completeStartup dismisses on replay.
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
    const state = this.sessions.get(sessionId)
    if (!state) return
    // Tear down only this generation. If resume/attach already replaced the
    // map entry, leave the new polls/socket alone and just close our channel.
    const stillOurs = this.sessions.get(sessionId) === state
    if (stillOurs) {
      const wasPolling = this.polls.has(sessionId)
      this.polls.get(sessionId)?.abort()
      this.polls.delete(sessionId)
      this.stopScratchLoop(sessionId)
      if (wasPolling) this.notifyActivity(sessionId)
      this.sessions.delete(sessionId)
    }
    this.stopWorkerSocket(state)
    this.liveTextBySession.delete(sessionId)
    this.clearSetupChrome(state, sessionId)
    this.remember(sessionId, state)
    state.channel.close()
    logger.info('minionHarness: detached (remote tip kept)', {
      sessionId,
      remoteTaskId: state.remoteTaskId,
      stillOurs
    })
  }

  /**
   * Stop button = soft interrupt only (Minion Web): WS INTERRUPT when live.
   * There is no cancelTask path in Atelier Minion — close/delete only detaches.
   */
  async interrupt(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing) return

    // Clear local "waiting on steer" so Working can drop even before the next
    // status_change; the worker still owns the real idle bit.
    state.steerCreateInFlight = false
    state.pendingSteerInteractionId = ''
    state.awaitingAgentAfterSteer = false
    state.lastSteeredAt = 0
    this.liveTextBySession.delete(sessionId)

    if (state.workerSocket?.isLive) {
      const sent = state.workerSocket.sendCommand(interruptCommand())
      logger.info('minionHarness: INTERRUPT via worker socket', { sessionId, sent })
      // Optimistic idle until status_change confirms; socket stays open.
      if (sent && state.workerState !== undefined) {
        state.workerState = 1
        this.syncWorkingFromWorker(sessionId, state)
      }
    } else {
      // No live worker (starting / sleeping): cannot safely INTERRUPT over RPC
      // (PENDING INTERRUPT is later replayed as a user message). Just clear chrome.
      logger.info('minionHarness: interrupt with no live socket — clear chrome only', {
        sessionId,
        socketState: state.workerSocket?.state ?? 'none'
      })
      this.clearStatusChrome(state, sessionId)
    }

    this.remember(sessionId, state)
    this.notifyActivity(sessionId)
    // Tell SessionManager the turn is no longer busy (gateway path also
    // clears busy after this promise). Do not close the harness channel.
    if (!state.channel.closed) {
      state.channel.push({ type: 'interrupted', sessionId, timestamp: new Date().toISOString() })
    }
  }

  // ── messaging ────────────────────────────────────────────────────────────

  /** Serialize steers per session so a double-send cannot mint two DevPods. */
  private readonly steerChain = new Map<string, Promise<void>>()

  async streamInput(
    sessionId: string,
    message: string,
    attachments?: HarnessFileInput[]
  ): Promise<void> {
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
      await this.streamInputLocked(sessionId, message, attachments)
    } finally {
      release()
    }
  }

  private async streamInputLocked(
    sessionId: string,
    message: string,
    attachments?: HarnessFileInput[]
  ): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing || state.channel.closed) {
      logger.warn('minionHarness: streamInput for unknown/closing session', { sessionId })
      return
    }
    const text = message.trim()
    if (!text && !attachments?.length) return
    // Dedup key is the user-visible text only (attachments always re-send).
    if (text) state.steeredTexts.add(text)
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

    // Prefer live worker socket (Minion Web); RPC wakes a sleeping pod.
    //
    // Screenshots: NEVER put data URLs in USER_MESSAGE.attachments[] — the
    // worker treats each string as a path under attachments/ and mkdir's every
    // `/` in the base64 (empty dirs, agent says it cannot see the image).
    // Until a real upload RPC exists, inline data URLs in the message body
    // (same shape as offline createInteraction) so the agent can decode them.
    const hasAttachments = Boolean(attachments?.length)
    if (!state.workerSocket?.isLive && isDevpodRunningState(state.lastDevpodState)) {
      if (state.lastTask) this.syncWorkerSocket(sessionId, state, state.lastTask)
      await this.waitForLiveWorkerSocket(state, hasAttachments ? 10_000 : 3_000)
    }
    if (state.workerSocket?.isLive) {
      const wsAttachments = hasAttachments
        ? prepareAttachmentsForMinionWs(attachments)
        : undefined
      const wireText = hasAttachments
        ? buildMinionSteerMessage(text || '(attachment)', wsAttachments)
        : text || '(attachment)'
      // Empty attachments[] — filenames only after a real DevPod upload.
      const sent = state.workerSocket.sendCommand(userMessageCommand(wireText, []))
      if (sent) {
        state.steerCreateInFlight = false
        state.awaitingAgentAfterSteer = true
        state.pendingSteerInteractionId = ''
        state.lastSteeredAt = Date.now()
        this.remember(sessionId, state)
        logger.info('minionHarness: USER_MESSAGE via worker socket', {
          sessionId,
          remoteTaskId: state.remoteTaskId,
          attachmentCount: wsAttachments?.length ?? 0,
          messageChars: wireText.length,
          inlinedInMessage: hasAttachments
        })
        if (state.workerState !== undefined) {
          state.workerState = 2
          this.syncWorkingFromWorker(sessionId, state)
          this.notifyActivity(sessionId)
        }
        return
      }
    }
    const rpcAttachments = hasAttachments
      ? prepareAttachmentsForMinionRpc(attachments)
      : attachments
    if (hasAttachments && !minionRpcAttachmentsFit(text, rpcAttachments)) {
      const msg =
        'Screenshot is too large to send while the Minion worker is offline. Wait until the session is linked, then resend.'
      logger.error('minionHarness: attachment too large for offline RPC', {
        sessionId,
        attachmentCount: attachments?.length ?? 0
      })
      if (text) state.steeredTexts.delete(text)
      state.steerCreateInFlight = false
      state.channel.push({
        type: 'error',
        sessionId,
        timestamp: new Date().toISOString(),
        message: msg
      })
      return
    }
    if (hasAttachments) {
      logger.info('minionHarness: offline createInteraction with compressed attachments', {
        sessionId,
        attachmentCount: rpcAttachments?.length ?? 0
      })
    }
    await this.createInteractionOnRemote(sessionId, state, text, rpcAttachments)
  }

  /** Poll until the worker socket is live or `budgetMs` elapses. */
  private async waitForLiveWorkerSocket(
    state: MinionSessionState,
    budgetMs: number
  ): Promise<boolean> {
    if (state.workerSocket?.isLive) return true
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (state.closing || state.channel.closed) return false
      if (state.workerSocket?.isLive) return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return state.workerSocket?.isLive === true
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
    text: string,
    attachments?: HarnessFileInput[]
  ): Promise<void> {
    try {
      const requestedTaskId = state.remoteTaskId || sessionId
      const { interaction } = await httpCreateInteraction(requestedTaskId, text, attachments)
      const id = String(interaction.id ?? '').trim()
      const status = String(interaction.status ?? '')
      // Trust the response task id — Minion may bind the row to a different
      // (e.g. relaunched) task than the one we requested. Never ignore this.
      const responseTaskId = String(interaction.task_id ?? interaction.taskId ?? '').trim()
      if (responseTaskId && responseTaskId !== state.remoteTaskId) {
        logger.info('minionHarness: createInteraction rebound remoteTaskId from response', {
          sessionId,
          requestedTaskId,
          responseTaskId
        })
        state.remoteTaskId = responseTaskId
        this.notifyRemoteTask(sessionId, responseTaskId)
      }
      state.pendingSteerInteractionId = id
      state.awaitingAgentAfterSteer = false
      state.steerCreateInFlight = false
      state.completionPosted = false
      state.lastSteeredAt = Date.now()
      // RPC path (pod asleep / socket not live): next WS catch-up replaces
      // any storage-built transcript (Minion Web resetOnConnect).
      if (!state.workerSocket?.isLive) {
        state.resetOnConnect = true
        // Real wake (pod not RUNNING): show SETUP again. Socket blip while the
        // pod is already up must NOT reopen Connect over finished chat.
        if (!isDevpodRunningState(state.lastDevpodState)) {
          state.setupComplete = false
          state.justCreated = false
          state.firstTurnPending = false
        }
      }
      this.remember(sessionId, state)
      logger.info('minionHarness: createInteraction ok', {
        sessionId,
        remoteTaskId: state.remoteTaskId,
        requestedTaskId,
        responseTaskId: responseTaskId || null,
        interactionId: id,
        status,
        attachmentCount: attachments?.length ?? 0,
        resetOnConnect: state.resetOnConnect
      })
    } catch (err) {
      if (text) state.steeredTexts.delete(text)
      state.pendingSteerInteractionId = ''
      state.awaitingAgentAfterSteer = false
      state.steerCreateInFlight = false
      const raw = err instanceof Error ? err.message : String(err)
      const msg = /Data too long for column 'message'|too large for Minion offline/i.test(raw)
        ? 'Could not send: attachment is too large for Minion while the worker is offline. Wait until the session is linked, or send text only / a smaller image.'
        : raw
      logger.error('minionHarness: createInteraction failed', { sessionId, error: raw })
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
   * Sidebar/composer "working" — Minion Web rule: worker_state === 2 only.
   * SETUP (starting/wake) is a separate card; do not invent Working from poll.
   */
  isRemoteActive(sessionId: string): boolean {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing || state.completionPosted) return false
    if (state.workerState !== undefined) {
      return isWorkerRunning(state.workerState)
    }
    return false
  }

  /**
   * True while createInteraction's user row is still PENDING, or RESPONDED but
   * we have not yet seen a new AGENT message. Event-driven only — tip
   * CANCELLED/COMPLETED and wall-clock must not clear this (stale COMPLETED
   * after a 3‑minute timer soft-stopped Torchlight before the agent reply).
   */
  private awaitingSteerReply(state: MinionSessionState): boolean {
    if (state.lastSteeredAt <= 0) return false
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

  async respondToPrompt(
    sessionId: string,
    requestId: string,
    response: PromptResponse
  ): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing || state.channel.closed) return
    if (response.kind !== 'ask_user_question') return
    if ('cancelled' in response && response.cancelled) {
      await this.createInteractionOnRemote(
        sessionId,
        state,
        `Cancelled question ${requestId}`
      )
      return
    }
    if (!('answers' in response)) return
    const answers = response.answers ?? {}
    const picks = Object.values(answers)
      .map((v) => String(v).trim())
      .filter(Boolean)
    const free = response.freeText?.trim()
    const human = free || picks.join('; ') || 'OK'
    // Live socket: ELICITATION_RESPONSE (Minion Web). Else RPC with call_id payload.
    if (state.workerSocket?.isLive) {
      const wireAnswers: Record<string, string | readonly string[]> = { ...answers }
      if (free) wireAnswers.freeText = free
      const sent = state.workerSocket.sendCommand(elicitationResponseCommand(requestId, wireAnswers))
      if (sent) {
        state.lastSteeredAt = Date.now()
        state.awaitingAgentAfterSteer = true
        logger.info('minionHarness: ELICITATION_RESPONSE via worker socket', { sessionId, requestId })
        return
      }
    }
    const payload = JSON.stringify({
      version: 1,
      call_id: requestId,
      answers,
      ...(free ? { freeText: free } : {})
    })
    await this.createInteractionOnRemote(sessionId, state, `${human}\n\n${payload}`)
  }

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
    const fold = new MinionWorkerFold()
    if (mem?.lastAppliedSeq !== undefined) fold.restoreLastSeq(mem.lastAppliedSeq)
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
      scratchTickBusy: false,
      workerSocket: null,
      workerState: undefined,
      workerLinked: false,
      workerSocketKey: '',
      fold,
      foldHealthy: mem?.foldHealthy ?? false,
      storageFoldDone: mem?.storageFoldDone ?? false,
      resetOnConnect: false,
      attachWakeRequested: false,
      justCreated: opts?.liveFromStart === true,
      firstTurnPending: opts?.liveFromStart === true,
      // Never restore SETUP completion from memory — detach/resume must re-run
      // uTerm syncStartup (Boot/Connect) until completeStartup on replay/first turn.
      setupComplete: false
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
      scratch: { ...state.scratch },
      lastAppliedSeq: state.fold.lastSeq,
      foldHealthy: state.foldHealthy,
      storageFoldDone: state.storageFoldDone
    })
  }

  /**
   * uTerm completeStartup — leave Connect when the worker took the first
   * message (create) or finished replay (attach / reattach).
   */
  private completeStartup(sessionId: string, state: MinionSessionState): void {
    if (state.setupComplete) return
    state.setupComplete = true
    state.firstTurnPending = false
    state.justCreated = false
    logger.info('minionHarness: startup complete (Minion UI)', { sessionId })
    if (state.lastTask) this.pushSetupChrome(state, sessionId, state.lastTask)
    else {
      state.lastSetupKey = ''
      this.clearStatusChrome(state, sessionId)
    }
    this.remember(sessionId, state)
    this.notifyActivity(sessionId)
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
    // Keep Boot only while the pod is still coming up (starting/restoring) or
    // we are mid-wake. Sleeping SHUTDOWN/SNAPSHOTTED → clear (not stuck SETUP).
    const wakeIntent =
      this.awaitingSteerReply(state) ||
      (state.attachWakeRequested && !state.foldHealthy)
    const keepSetup =
      !!state.lastTask &&
      !state.setupComplete &&
      (isDevpodStartingState(state.lastDevpodState) ||
        wakeIntent ||
        (isDevpodRunningState(state.lastDevpodState) && !state.workerLinked)) &&
      !!deriveMinionSetup(state.lastTask, {
        devpodState: state.lastDevpodState,
        wakeIntent,
        setupComplete: false,
        workerLinked: state.workerLinked
      })
    if (keepSetup) {
      state.lastWorkingKey = ''
      state.lastSetupKey = ''
      this.pushSetupChrome(state, sessionId, state.lastTask!)
      this.remember(sessionId, state)
      // Mid-link / mid-wake: do not kill the worker socket. Caller exits this
      // poll generation — restart so Boot→Connect / wake can finish.
      // (Killing the socket here left reattach stuck with an empty transcript.)
      queueMicrotask(() => {
        if (this.sessions.get(sessionId) === state && !state.closing && !state.channel.closed) {
          this.ensurePolling(sessionId)
        }
      })
      return
    }
    this.clearStatusChrome(state, sessionId)
    this.remember(sessionId, state)
    this.stopWorkerSocket(state)
    this.stopScratchLoop(sessionId)
    this.liveTextBySession.delete(sessionId)
    const wasPolling = this.polls.has(sessionId)
    this.polls.get(sessionId)?.abort()
    this.polls.delete(sessionId)
    if (wasPolling) this.notifyActivity(sessionId)
  }

  private stopWorkerSocket(state: MinionSessionState): void {
    state.workerSocket?.stop()
    state.workerSocket = null
    state.workerSocketKey = ''
    state.workerState = undefined
    state.workerLinked = false
  }

  /**
   * Open (or keep) the worker WebSocket when the tip’s DevPod is RUNNING and
   * we know name+region. Closes it when the pod is no longer up.
   */
  private syncWorkerSocket(sessionId: string, state: MinionSessionState, task: Record<string, any>): void {
    if (state.closing || state.channel.closed) {
      this.stopWorkerSocket(state)
      return
    }
    const target = extractDevpodTarget(state.remoteTaskId || sessionId, task)
    if (!target || !isDevpodRunningState(state.lastDevpodState)) {
      if (state.workerSocket) {
        logger.info('minionHarness: closing worker socket (pod not running)', { sessionId })
        this.stopWorkerSocket(state)
        this.syncWorkingFromWorker(sessionId, state)
        this.notifyActivity(sessionId)
      }
      return
    }
    const key = `${target.devpodName}|${target.region}|${target.taskId}`
    if (state.workerSocket && state.workerSocketKey === key) return
    this.stopWorkerSocket(state)
    state.workerSocketKey = key
    const reset = state.resetOnConnect
    // Full replay after storage/wake; otherwise resume from fold cursor.
    const initialSince = reset ? undefined : state.fold.lastSeq
    logger.info('minionHarness: opening worker socket', {
      sessionId,
      taskId: target.taskId,
      devpodName: target.devpodName,
      region: target.region,
      resetOnConnect: reset,
      initialSince
    })
    const socket = new MinionWorkerSocket({
      taskId: target.taskId,
      devpodName: target.devpodName,
      region: target.region,
      ...(initialSince !== undefined ? { initialSince } : {}),
      onState: (sockState) => {
        const s = this.sessions.get(sessionId)
        if (!s || s.closing || !s.lastTask) return
        // Dialing/backoff: stay on Boot until onConnected. Live: dismiss attach.
        if (!s.setupComplete) this.pushSetupChrome(s, sessionId, s.lastTask)
        if (sockState === 'live') {
          // Worker socket live ⇒ past Connect. Do not leave SETUP on
          // “Connecting…” while the session is already linked (create or attach).
          this.completeStartup(sessionId, s)
          this.syncWorkingFromWorker(sessionId, s)
          this.notifyActivity(sessionId)
        }
      },
      onConnected: (params) => this.onWorkerConnected(sessionId, params),
      onWorkerState: (ws) => this.onWorkerState(sessionId, ws),
      onEvents: (events, phase) => this.onWorkerEvents(sessionId, events, phase),
      onReset: () => {
        const s = this.sessions.get(sessionId)
        if (!s) return
        this.liveTextBySession.delete(sessionId)
        s.workerState = undefined
        s.workerLinked = false
        s.fold.reset()
        s.resetOnConnect = true
      },
      onDisconnect: (reason, attempt) => {
        logger.warn('minionHarness: worker socket disconnect', { sessionId, reason, attempt })
        const s = this.sessions.get(sessionId)
        if (s) {
          // uTerm: lose handshake → Boot again while reconnecting (not stuck Connect).
          s.workerLinked = false
          if (!s.setupComplete && s.lastTask) this.pushSetupChrome(s, sessionId, s.lastTask)
        }
        // Keep reconnecting while the pod is still RUNNING; syncWorkerSocket
        // will tear the socket down on the next poll if the pod sleeps.
        return isDevpodRunningState(s?.lastDevpodState ?? '')
      }
    })
    state.workerSocket = socket
    socket.start()
  }

  private onWorkerConnected(sessionId: string, params: MinionConnectedParams): void {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing) return
    if (params.workerState !== undefined) state.workerState = params.workerState
    // uTerm onConnected → moveStartup('connect') — only now leave Boot.
    state.workerLinked = true
    logger.info('minionHarness: worker connected', {
      sessionId,
      workerState: params.workerState,
      lastSeq: params.lastSeq
    })
    if (!state.setupComplete && state.lastTask) {
      this.pushSetupChrome(state, sessionId, state.lastTask)
    }
    // Do not completeStartup here — uTerm dismisses on replay / first user turn
    // (onWorkerEvents / onState live). Paint Connect first.
    if (params.pendingElicitation?.callId && Array.isArray(params.pendingElicitation.questions)) {
      this.pushElicitationFromWorker(sessionId, state, params.pendingElicitation.callId, params.pendingElicitation.questions)
    }
    this.syncWorkingFromWorker(sessionId, state)
    this.notifyActivity(sessionId)
  }

  private onWorkerState(sessionId: string, workerState: number | undefined): void {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing) return
    const prev = state.workerState
    state.workerState = workerState
    if (prev !== workerState) {
      logger.info('minionHarness: worker_state', { sessionId, workerState })
    }
    // Leaving RUNNING: flush any buffered live text as a progress row.
    if (isWorkerRunning(prev) && !isWorkerRunning(workerState)) {
      this.flushLiveText(sessionId, state)
      if (state.awaitingAgentAfterSteer) state.awaitingAgentAfterSteer = false
      state.pendingSteerInteractionId = ''
      state.steerCreateInFlight = false
    }
    this.syncWorkingFromWorker(sessionId, state)
    this.notifyActivity(sessionId)
  }

  private onWorkerEvents(
    sessionId: string,
    events: MinionWorkerEvent[],
    phase: 'replay' | 'live'
  ): void {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing || state.channel.closed) return

    // Full replay must REPLACE the transcript. Appending onto existing rows is
    // what produced: req1…req4 then response1…response4 again.
    // - resetOnConnect + non-empty replay → replace (wake / storage → WS).
    // - No fold cursor + non-empty replay → replace (app restart / lost cursor).
    // Empty replay must NEVER wipe — that erased create seeds + SETUP chrome and
    // left "Ready to chat" while Minion UI was still Connecting.
    const fullReplayReplace =
      phase === 'replay' &&
      events.length > 0 &&
      (state.resetOnConnect || state.fold.lastSeq === undefined)
    if (fullReplayReplace) {
      state.fold.reset()
      state.channel.push({
        type: 'conversation_reset',
        sessionId,
        timestamp: new Date().toISOString(),
        newConversationId: state.remoteTaskId || sessionId
      })
      state.resetOnConnect = false
      state.postedTexts.clear()
      // wipeConversation clears sdk chrome; force SETUP to re-paint if still open.
      state.lastSetupKey = ''
      state.lastWorkingKey = ''
      logger.info('minionHarness: full replay — replacing transcript (not appending)', {
        sessionId,
        eventCount: events.length
      })
    }

    let sawUserTurn = false
    for (const ev of events) {
      if (ev.type === 'elicitation_request' && ev.call_id && ev.questions) {
        this.pushElicitationFromWorker(sessionId, state, ev.call_id, ev.questions)
      }
      if (ev.type === 'user_message' && ev.message) {
        sawUserTurn = true
        if (phase === 'live') {
          state.steerCreateInFlight = false
          state.pendingSteerInteractionId = ''
          state.awaitingAgentAfterSteer = false
        }
      }
    }

    // uTerm completeStartup: first user turn (create) OR replay on attach.
    if (sawUserTurn && state.firstTurnPending) {
      state.firstTurnPending = false
      logger.info('minionHarness: first turn delivered', { sessionId })
    }

    const folded = state.fold.apply(sessionId, events, phase)
    for (const harnessEv of folded.events) {
      if (state.closing || state.channel.closed) break
      if (harnessEv.type === 'text_delta') {
        state.postedTexts.add(normalizeProgressText(harnessEv.text))
      }
      state.channel.push(harnessEv)
    }
    if (folded.events.length > 0) {
      state.foldHealthy = true
      // Scratch is backup only when fold never connected.
      this.stopScratchLoop(sessionId)
    }
    // Dismiss SETUP as soon as the worker is past Connect. Live tool streams
    // must count too — otherwise SETUP stays on “Connecting…” while tools run.
    const liveWorkStarted =
      phase === 'live' &&
      state.workerLinked &&
      (folded.events.length > 0 || folded.chrome != null || folded.sawAssistantText)
    if (
      sawUserTurn ||
      (phase === 'replay' && !state.justCreated) ||
      folded.sawAssistantText ||
      (phase === 'replay' && folded.events.length > 0) ||
      liveWorkStarted
    ) {
      this.completeStartup(sessionId, state)
      // completeStartup clears SETUP; paint Working immediately so we don't
      // flash an empty chrome gap (tools can arrive before worker_state RUNNING).
      if (liveWorkStarted) {
        this.pushWorkingChrome(
          state,
          sessionId,
          folded.chrome ?? { title: 'Working…', detail: '' }
        )
      }
    } else if (!state.setupComplete && state.lastTask) {
      // Re-paint after conversation_reset wiped sdk chrome, or after empty
      // replay left Boot/Connect with no dismiss signal.
      this.pushSetupChrome(state, sessionId, state.lastTask)
    }
    if (folded.chrome && state.lastSetupKey === '' && isWorkerRunning(state.workerState)) {
      this.pushWorkingChrome(state, sessionId, folded.chrome)
    }
    if (folded.sawAssistantText) {
      state.awaitingAgentAfterSteer = false
      state.pendingSteerInteractionId = ''
      state.steerCreateInFlight = false
      if (phase === 'live') {
        this.liveTextBySession.set(sessionId, '1')
        // Text can arrive after status already left RUNNING — flush + clear now.
        if (!isWorkerRunning(state.workerState)) {
          this.flushLiveText(sessionId, state)
        }
      }
    }
    this.remember(sessionId, state)
    if (folded.events.length > 0) this.notifyActivity(sessionId)
  }

  private flushLiveText(sessionId: string, state: MinionSessionState): void {
    const had = this.liveTextBySession.get(sessionId)
    this.liveTextBySession.delete(sessionId)
    // Live fold streams text_delta into SessionManager's buffer — close the turn
    // only when we actually streamed assistant text this RUNNING interval.
    if (had !== '1') return
    state.channel.push({
      type: 'result',
      sessionId,
      timestamp: new Date().toISOString(),
      isError: false,
      subtype: 'minion_progress',
      numTurns: 1,
      durationMs: 0,
      totalCostUsd: 0,
      usage: null
    })
    state.awaitingAgentAfterSteer = false
    if (!isWorkerRunning(state.workerState)) {
      this.clearStatusChrome(state, sessionId)
    }
  }

  private pushElicitationFromWorker(
    sessionId: string,
    state: MinionSessionState,
    callId: string,
    questionsRaw: unknown
  ): void {
    const wire = JSON.stringify({
      version: 1,
      call_id: callId,
      questions: questionsRaw
    })
    const elicitation = parseMinionElicitation(wire)
    if (!elicitation) return
    if (state.seenInteractionIds.has(`elic:${callId}`)) return
    state.seenInteractionIds.add(`elic:${callId}`)
    state.channel.push({
      type: 'ask_user_question',
      sessionId,
      timestamp: new Date().toISOString(),
      requestId: elicitation.callId,
      toolUseId: elicitation.callId,
      questions: elicitation.questions
    })
    state.awaitingAgentAfterSteer = false
    this.clearStatusChrome(state, sessionId)
    this.notifyActivity(sessionId)
  }

  /** Drive composer Working chrome from worker_state (Minion Web). */
  private syncWorkingFromWorker(sessionId: string, state: MinionSessionState): void {
    if (state.closing || state.channel.closed || state.completionPosted) return
    if (state.lastSetupKey !== '') return
    if (state.workerState === undefined) return
    if (isWorkerRunning(state.workerState)) {
      // Never put latest_update / answer prose in the strip — short label only.
      this.pushWorkingChrome(state, sessionId, { title: 'Working…', detail: '' })
    } else {
      // Idle / waiting-for-input / error — clear Working immediately.
      if (state.lastWorkingKey !== '') this.clearStatusChrome(state, sessionId)
    }
  }

  /** Live transcript work only when pod is STATE_RUNNING (steer answer exempt). */
  private podAllowsLiveWork(state: MinionSessionState): boolean {
    return isDevpodRunningState(state.lastDevpodState)
  }

  /** Absorb text into dedupe sets without a transcript row. */
  private absorbProgressText(state: MinionSessionState, text: string): void {
    const key = normalizeProgressText(text)
    if (key) state.postedTexts.add(key)
  }

  /**
   * Soft-stop used to always push `Done.` + latest_update on first-turn idle
   * completion. When the worker fold already streamed the answer, that becomes
   * a duplicate blob (progress mashed onto the same reply). Skip the summary
   * whenever fold owns the transcript or we already absorbed the body.
   */
  private shouldPostIdleTaskSummary(
    state: MinionSessionState,
    task: Record<string, any>,
    sawNewAgentInteraction: boolean
  ): boolean {
    if (sawNewAgentInteraction || state.lastSteeredAt > 0) return false
    if (state.foldHealthy) return false
    let message = task.output?.message ?? task.output?.summary ?? task.status_message
    if (typeof message !== 'string' || !message.trim()) {
      message = extractLatestUpdate(task)
    }
    if (typeof message !== 'string' || !message.trim()) return true
    const body = normalizeProgressText(message)
    if (state.postedTexts.has(body)) return false
    for (const posted of state.postedTexts) {
      if (posted.length < 60) continue
      if (body.includes(posted) || posted.includes(body)) return false
    }
    return true
  }

  private pushIdleTurnComplete(
    sessionId: string,
    state: MinionSessionState,
    task: Record<string, any>,
    sawNewAgentInteraction: boolean
  ): void {
    if (state.completionPosted || state.closing) return
    state.completionPosted = true
    const cost = taskCost(task)
    if (this.shouldPostIdleTaskSummary(state, task, sawNewAgentInteraction)) {
      pushAssistantMessage(state.channel, sessionId, formatTaskSummary(task), 'end_turn', cost)
    } else {
      state.channel.push({
        type: 'result',
        sessionId,
        timestamp: new Date().toISOString(),
        subtype: 'end_turn',
        isError: false,
        numTurns: 1,
        durationMs: 0,
        totalCostUsd: cost,
        usage: null
      })
    }
    this.notifyActivity(sessionId)
  }

  /**
   * Attach/resume to a sleeping tip: ask Minion to restore the DevPod so SETUP
   * Boot paints and the worker socket can replay history. Scratch
   * `getFileContents` cannot reach SNAPSHOTTED pods (no cluster DNS).
   */
  private async maybeWakeSleepingAttach(
    sessionId: string,
    state: MinionSessionState,
    task: Record<string, any>
  ): Promise<void> {
    if (state.closing || state.channel.closed) return
    // Do not skip wake because a prior live session remembered foldHealthy —
    // after detach the channel is empty and the tip may be snapshotted.
    if (state.justCreated || state.attachWakeRequested) return
    if (!isDevpodSleepingState(state.lastDevpodState)) return
    const target = extractDevpodTarget(state.remoteTaskId || sessionId, task)
    if (!target) return
    state.attachWakeRequested = true
    state.setupComplete = false
    state.resetOnConnect = true
    state.foldHealthy = false
    this.remember(sessionId, state)
    logger.info('minionHarness: attach wake (devpodStart)', {
      sessionId,
      taskId: target.taskId,
      devpodName: target.devpodName,
      region: target.region,
      lastDevpodState: state.lastDevpodState
    })
    try {
      await httpDevpodStart(target.devpodName, target.region)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('minionHarness: attach wake failed', { sessionId, error: msg.slice(0, 240) })
      // Keep attachWakeRequested so SETUP Boot stays up while getDevpods catches up
      // (createInteraction / a concurrent start may still restore the pod).
    }
    this.pushSetupChrome(state, sessionId, task)
  }

  /**
   * When the pod is sleeping (or unknown with pod identity), try scratch
   * chat.jsonl once. This only works when the DevPod still has DNS — otherwise
   * attach wake + WS replay owns history.
   */
  private async maybeFoldStorage(
    sessionId: string,
    state: MinionSessionState,
    task: Record<string, any>,
    signal: AbortSignal
  ): Promise<void> {
    if (state.storageFoldDone || state.closing || state.channel.closed) return
    if (isDevpodRunningState(state.lastDevpodState)) return
    const phase = classifyDevpodPhase(state.lastDevpodState)
    if (phase === 'starting') return
    const target = extractDevpodTarget(state.remoteTaskId || sessionId, task)
    if (!target) return
    if (phase !== 'sleeping' && phase !== 'unknown' && phase !== 'failed') return
    try {
      const content = await getFileContents(target, 'chat.jsonl')
      if (signal.aborted || state.closing || state.channel.closed) return
      const events = parseChatJsonl(content)
      state.storageFoldDone = true
      if (events.length === 0) {
        logger.info('minionHarness: storage fold empty', { sessionId, taskId: target.taskId })
        this.remember(sessionId, state)
        return
      }
      const folded = state.fold.apply(sessionId, events, 'storage')
      for (const harnessEv of folded.events) {
        if (state.closing || state.channel.closed) break
        if (harnessEv.type === 'text_delta') {
          state.postedTexts.add(normalizeProgressText(harnessEv.text))
        }
        state.channel.push(harnessEv)
      }
      state.foldHealthy = folded.events.length > 0 || state.foldHealthy
      state.resetOnConnect = true
      this.stopScratchLoop(sessionId)
      logger.info('minionHarness: storage fold applied', {
        sessionId,
        taskId: target.taskId,
        eventCount: events.length,
        harnessEvents: folded.events.length,
        lastSeq: state.fold.lastSeq
      })
      this.remember(sessionId, state)
      this.notifyActivity(sessionId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Snapshotted pods have no DevPod DNS — stop retrying; attach wake + WS
      // will load history once the pod is RUNNING.
      const unreachable =
        /no such host|devpod not found|unable to get transport/i.test(msg)
      if (unreachable) {
        state.storageFoldDone = true
        logger.info('minionHarness: storage fold skipped (pod unreachable)', {
          sessionId,
          error: msg.slice(0, 240)
        })
        this.remember(sessionId, state)
        return
      }
      logger.warn('minionHarness: storage fold failed', { sessionId, error: msg.slice(0, 240) })
      // Retry next poll — leave storageFoldDone false.
    }
  }

  /**
   * True when soft-stopping would tear down an in-flight reconnect / wake
   * before history arrives (finished tip + dialing socket / attach wake).
   */
  private shouldDeferSoftStop(state: MinionSessionState): boolean {
    if (this.awaitingSteerReply(state) || state.steerCreateInFlight) return true
    // Socket open but SETUP/replay not done — softStop aborts polls + kills the
    // socket. After `connected`, workerState is set (often idle) while replay
    // is still in flight; defer until fold is healthy and SETUP dismissed.
    if (state.workerSocket && (!state.foldHealthy || !state.setupComplete)) return true
    if (state.attachWakeRequested && !state.foldHealthy) return true
    if (isDevpodStartingState(state.lastDevpodState)) return true
    // Pod is up but we still have no fold — keep polling so syncWorkerSocket can open.
    if (isDevpodRunningState(state.lastDevpodState) && !state.foldHealthy && !state.workerLinked) {
      return true
    }
    return false
  }

  /** Scratch is backup only when the seq fold has never been healthy. */
  private scratchAllowed(state: MinionSessionState): boolean {
    return !state.foldHealthy && !state.workerSocket?.isLive
  }

  private ensureScratchLoop(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state && !this.scratchAllowed(state)) {
      this.stopScratchLoop(sessionId)
      return
    }
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
    if (!this.scratchAllowed(state)) {
      this.stopScratchLoop(sessionId)
      return
    }
    const task = state.lastTask
    if (!task) return
    await this.pollScratch(sessionId, state, task, new AbortController().signal)
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
    // Do not dismiss SETUP because the fold already has history — uTerm keeps
    // Boot/Connect until completeStartup (replay / first user turn).
    const wakeIntent =
      this.awaitingSteerReply(state) ||
      state.steerCreateInFlight ||
      state.awaitingAgentAfterSteer ||
      state.firstTurnPending ||
      // Attach restored a sleeping pod — show Boot until WS fold is healthy.
      (state.attachWakeRequested && !state.foldHealthy)
    const target = extractDevpodTarget(state.remoteTaskId || sessionId, task)
    const phase = classifyDevpodPhase(state.lastDevpodState)
    const setup = deriveMinionSetup(task, {
      devpodState: state.lastDevpodState,
      wakeIntent,
      setupComplete: state.setupComplete,
      workerLinked: state.workerLinked
    })
    if (!setup) {
      logger.info('minionHarness: setup decide', {
        sessionId,
        action: 'null',
        setupComplete: state.setupComplete,
        foldHealthy: state.foldHealthy,
        hasPod: Boolean(target),
        devpodName: target?.devpodName ?? '',
        lastDevpodState: state.lastDevpodState || '',
        phase,
        wakeIntent,
        workerLinked: state.workerLinked,
        justCreated: state.justCreated,
        firstTurnPending: state.firstTurnPending
      })
      // Setup done — clear SETUP chrome. Working comes only from worker_state.
      if (state.lastSetupKey !== '') {
        state.lastSetupKey = ''
        this.clearStatusChrome(state, sessionId)
      } else if (state.completionPosted && state.lastWorkingKey !== '') {
        this.clearStatusChrome(state, sessionId)
      }
      return
    }
    state.lastWorkingKey = ''
    const key = `${setup.active}|${setup.title}|${setup.detail}`
    if (key === state.lastSetupKey) {
      logger.info('minionHarness: setup decide', {
        sessionId,
        action: 'dedupe',
        active: setup.active,
        hasPod: Boolean(target),
        lastDevpodState: state.lastDevpodState || '',
        phase,
        wakeIntent,
        workerLinked: state.workerLinked
      })
      return
    }
    state.lastSetupKey = key
    logger.info('minionHarness: setup paint', {
      sessionId,
      action: 'paint',
      active: setup.active,
      title: setup.title,
      hasPod: Boolean(target),
      devpodName: target?.devpodName ?? '',
      lastDevpodState: state.lastDevpodState || '',
      phase,
      wakeIntent,
      workerLinked: state.workerLinked,
      setupComplete: state.setupComplete,
      foldHealthy: state.foldHealthy,
      justCreated: state.justCreated,
      firstTurnPending: state.firstTurnPending,
      steps: setup.steps.map((s) => `${s.id}:${s.state}`).join(',')
    })
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
    if (state.lastTask && isAwaitingUserInput(state.lastTask)) return
    // SETUP owns the slot until the worker socket is live.
    if (state.lastSetupKey !== '') return
    const title = (chrome.title || 'Working…').trim() || 'Working…'
    // Reject answer-length prose (was latest_update) — keep tool/short labels only.
    let detail = (chrome.detail || '').replace(/\s+/g, ' ').trim()
    if (detail.length > 80 || /[.!?]\s/.test(detail) || detail.length > title.length + 40) {
      detail = ''
    }
    const key = `${title}|${detail}`
    if (key === state.lastWorkingKey) return
    state.lastWorkingKey = key
    state.channel.push({
      type: 'sdk_status',
      sessionId,
      timestamp: new Date().toISOString(),
      status: 'minion_working',
      title,
      detail
    })
  }

  /** True when Working chrome is only a scratch-not-ready placeholder. */
  private isScratchWaitChrome(state: MinionSessionState): boolean {
    const key = state.lastWorkingKey
    return (
      key.startsWith('Waiting for session') ||
      key.startsWith('Connecting to session') || // legacy fingerprint
      key.includes('waiting for tools') ||
      key.includes('Waiting for scratch') ||
      key.includes('Streaming session progress')
    )
  }

  /**
   * Scratch-backup Working label only — never latest_update / answer text.
   * Prefer worker_state chrome when the socket has handshaked.
   */
  private pushOrchestratorWorkingChrome(
    state: MinionSessionState,
    sessionId: string,
    _task: Record<string, any>
  ): void {
    if (state.completionPosted || state.lastSetupKey !== '') return
    if (state.workerState !== undefined) return
    if (state.foldHealthy) return
    if (
      state.lastWorkingKey !== '' &&
      !this.isScratchWaitChrome(state) &&
      state.scratch.seeded
    ) {
      return
    }
    this.pushWorkingChrome(state, sessionId, { title: 'Working…', detail: '' })
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
      if (this.podAllowsLiveWork(state) && state.lastSetupKey === '') {
        this.pushOrchestratorWorkingChrome(state, sessionId, task)
      }
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
        if (!this.podAllowsLiveWork(state) || state.lastSetupKey !== '') return
        if (
          !state.completionPosted &&
          !state.scratch.seeded &&
          (state.lastWorkingKey === '' || this.isScratchWaitChrome(state))
        ) {
          this.pushOrchestratorWorkingChrome(state, sessionId, task)
          if (state.lastWorkingKey === '' || this.isScratchWaitChrome(state)) {
            this.pushWorkingChrome(state, sessionId, {
              title: 'Waiting for session…',
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
      // Scratch can stream tools while SETUP is still on Connect — dismiss so we
      // don't leave “Connecting to DevPod…” over an already-running turn.
      const scratchLiveWork = events.some(
        (e) => e.type === 'tool_call_start' || e.type === 'text_delta' || e.type === 'tool_call_end'
      )
      if (!state.setupComplete && state.workerLinked && scratchLiveWork) {
        this.completeStartup(sessionId, state)
      }
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
      // Keep orchestrator progress only when pod is RUNNING; never invent Working
      // from a scratch DNS miss while Boot owns the stage.
      if (!isAwaitingUserInput(task) && this.podAllowsLiveWork(state) && state.lastSetupKey === '') {
        this.pushOrchestratorWorkingChrome(state, sessionId, task)
      }
    }
  }

  private ensurePolling(sessionId: string): void {
    const state = this.sessions.get(sessionId)
    if (state && this.scratchAllowed(state)) this.ensureScratchLoop(sessionId)
    if (this.polls.has(sessionId)) return
    void this.pollUntilDone(sessionId)
  }

  private async pollUntilDone(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    const abort = new AbortController()
    this.polls.set(sessionId, abort)
    if (this.scratchAllowed(state)) this.ensureScratchLoop(sessionId)
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

            // DevPod state before SETUP / work gating (cold seed needs it too).
            try {
              const pods = await httpGetDevpods()
              const target = extractDevpodTarget(taskId, task)
              const info = findDevpodForTask(pods, taskId, target?.devpodName)
              state.lastDevpodState = info ? info.state : ''
            } catch {
              /* getDevpods optional — leave lastDevpodState unchanged */
            }
            if (abort.signal.aborted) return
            const podUp = this.podAllowsLiveWork(state)
            // Sleeping attach: restore DevPod so SETUP + WS replay can run.
            if (!podUp) {
              await this.maybeWakeSleepingAttach(sessionId, state, task)
              await this.maybeFoldStorage(sessionId, state, task, abort.signal)
            } else if (state.attachWakeRequested && state.foldHealthy) {
              state.attachWakeRequested = false
            }
            // Open / refresh worker WebSocket once the pod is RUNNING.
            this.syncWorkerSocket(sessionId, state, task)

            // Cold resume: absorb orchestrator rows into dedupe only — transcript
            // comes from storage fold or WS replay, never listInteractions.
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
              continue
            }

            // latest_update is never a transcript owner once fold/WS is active.
            if (update && update !== state.lastLatestUpdate) {
              state.lastLatestUpdate = update
              this.absorbProgressText(state, update)
            }

            const finished = isTaskFinished(task)
            let waitingOnSteer = this.awaitingSteerReply(state)

            // SETUP/Boot whenever pod is not RUNNING (including finished wake).
            this.pushSetupChrome(state, sessionId, task)
            // Working chrome: worker_state only (no orchestrator invent).
            if (state.workerState !== undefined) {
              this.syncWorkingFromWorker(sessionId, state)
            }

            // Scratch backup only when fold never connected.
            if (this.scratchAllowed(state) && (podUp || state.scratch.healthy)) {
              this.ensureScratchLoop(sessionId)
              if (finished && !waitingOnSteer) {
                await this.flushScratchForCompletion(sessionId, state, task, abort.signal)
              } else {
                await this.pollScratch(sessionId, state, task, abort.signal)
              }
            } else {
              this.stopScratchLoop(sessionId)
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

            // listInteractions: seed elicitation only when fold is not healthy;
            // never post agent answers (fold owns transcript).
            for (const i of interactions) {
              const id = String(i.id ?? '')
              if (id && state.seenInteractionIds.has(id)) continue

              if (isUserInitiator(i.initiator)) {
                if (id) state.seenInteractionIds.add(id)
                const text = interactionText(i)
                if (text) state.postedTexts.add(normalizeProgressText(text))
                continue
              }

              if (!isAgentInitiator(i.initiator)) {
                if (id) state.seenInteractionIds.add(id)
                continue
              }
              const text = interactionText(i)
              if (!text) {
                if (id) state.seenInteractionIds.add(id)
                continue
              }

              if (isElicitationInteraction(i) && !state.foldHealthy) {
                const elicitation = parseMinionElicitation(text)
                if (elicitation) {
                  if (id) state.seenInteractionIds.add(id)
                  state.postedTexts.add(normalizeProgressText(text))
                  state.channel.push({
                    type: 'ask_user_question',
                    sessionId,
                    timestamp: new Date().toISOString(),
                    requestId: elicitation.callId,
                    toolUseId: elicitation.callId,
                    questions: elicitation.questions
                  })
                  sawNewAgentInteraction = true
                  if (state.awaitingAgentAfterSteer) state.awaitingAgentAfterSteer = false
                  this.clearStatusChrome(state, sessionId)
                  continue
                }
              }

              // Absorb — fold/WS will surface the real answer by seq.
              if (id) state.seenInteractionIds.add(id)
              this.absorbProgressText(state, text)
            }

            waitingOnSteer = this.awaitingSteerReply(state)

            // Waiting for the user (elicitation / USER_INPUT) — not Working.
            if (isAwaitingUserInput(task) || (state.workerState !== undefined && !isWorkerRunning(state.workerState))) {
              if (state.workerState !== undefined) this.syncWorkingFromWorker(sessionId, state)
              else this.clearStatusChrome(state, sessionId)
              this.remember(sessionId, state)
              // Idle worker with a finished task → soft-stop; else keep polling for follow-ups.
              // Never soft-stop while dialing / attach-waking — that kills the socket
              // before replay and leaves reattach looking empty.
              if (
                finished &&
                state.workerState !== undefined &&
                !isWorkerRunning(state.workerState) &&
                !waitingOnSteer &&
                !this.shouldDeferSoftStop(state)
              ) {
                this.pushIdleTurnComplete(sessionId, state, task, sawNewAgentInteraction)
                this.softStop(sessionId, state)
                return
              }
            } else if (waitingOnSteer && state.workerState === undefined) {
              // Still waiting on PENDING / wake — SETUP only; Working from worker_state.
              this.pushSetupChrome(state, sessionId, task)
              this.remember(sessionId, state)
            } else if (finished && state.workerState === undefined) {
              if (this.shouldDeferSoftStop(state)) {
                this.pushSetupChrome(state, sessionId, task)
                this.remember(sessionId, state)
              } else {
                // Idle completion — never recycle latest_update when fold already
                // streamed the answer (or after a steer / listInteractions post).
                this.pushIdleTurnComplete(sessionId, state, task, sawNewAgentInteraction)
                // softStop keeps Boot SETUP when pod is not RUNNING.
                this.softStop(sessionId, state)
                return
              }
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
        const steerFast =
          this.awaitingSteerReply(state) ||
          (state.lastSteeredAt > 0 && Date.now() - state.lastSteeredAt < STEER_FAST_POLL_MS)
        const socketLive = state.workerSocket?.isLive === true
        const interval = socketLive
          ? POLL_INTERVAL_LIVE_MS
          : early || steerFast
            ? EARLY_POLL_INTERVAL_MS
            : POLL_INTERVAL_MS
        await sleep(interval, abort.signal)
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
