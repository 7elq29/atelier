/**
 * MinionHarness — HarnessDriver backed by the Uber Minion orchestrator.
 *
 * Transport: shells out to `aifx mcp call minion-orchestrator <tool>
 * --args-file … -o …` (USSO auth is handled by aifx). Polling replaces
 * streaming: gettask (status + latest_update) and listinteractions are polled
 * every POLL_INTERVAL_MS until the task reaches a terminal status.
 *
 * Session-id contract: the Minion task UUID is used directly as the Atelier
 * session id (same convention as CortanaHarness).
 *
 * Every assistant row is pushed as text_delta + result so SessionManager
 * flushes each one as a distinct transcript message. Completion uses subtype
 * `end_turn`; live agent updates use `minion_progress`. Both trigger desktop /
 * in-app notifications (create/cancel subtypes do not).
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../logger'
import { subprocessEnvWithDevPath } from '../shell-path'
import type { MinionRepo } from '../../shared/session-types'
import type { HarnessDriver, HarnessEvent, HarnessFileInput, HarnessSession, HarnessStartOptions, PromptResponse } from './types'
import {
  extractDevpodTarget,
  getFileContents,
  listScratchFiles,
  type DevpodScratchTarget
} from './minion-scratch-client'
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
const SERVER = 'minion-orchestrator'

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

// ── aifx transport ──────────────────────────────────────────────────────────

/** Default aifx MCP budget. createinteraction uses a shorter hard cap — a hung
 *  aifx child has left the composer Stop-stuck for many minutes when Node's
 *  execFile timeout alone failed to reap the process. */
const AIFX_TIMEOUT_MS = 120_000
const CREATE_INTERACTION_TIMEOUT_MS = 45_000

async function callTool(
  tool: string,
  args: Record<string, unknown>,
  timeoutMs: number = AIFX_TIMEOUT_MS
): Promise<Record<string, any>> {
  const dir = await mkdtemp(join(tmpdir(), 'atelier-minion-'))
  const argsFile = join(dir, 'args.json')
  const outFile = join(dir, 'out.json')
  try {
    await writeFile(argsFile, JSON.stringify(args))
    // Force --usso: GUI-launched Electron has a sparse env that makes aifx
    // auto-detect "service-container" mode and route to localhost:5436
    // (muttley), which is not running on a laptop. Createtask then fails
    // with connection refused before any Minion task exists.
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(hardTimer)
        fn()
      }
      const child = execFile(
        'aifx',
        [
          'mcp',
          'call',
          SERVER,
          `minionorchestrator_${tool}`,
          '--usso',
          '--args-file',
          argsFile,
          '-o',
          outFile
        ],
        { timeout: timeoutMs, killSignal: 'SIGKILL', env: subprocessEnvWithDevPath() },
        (err, _stdout, stderr) => {
          if (err) {
            const msg = `aifx ${tool} failed: ${(stderr || err.message).trim().slice(0, 400)}`
            logger.error('minionHarness: aifx call failed', { tool, error: msg })
            finish(() => reject(new Error(msg)))
          } else {
            finish(() => resolve())
          }
        }
      )
      // Hard ceiling: if SIGKILL doesn't reap (zombie / stuck wait), still
      // unblock the composer so Stop is not stuck forever.
      const hardTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already exited */
        }
        const msg = `aifx ${tool} timed out after ${timeoutMs}ms`
        logger.error('minionHarness: aifx call timed out', { tool, timeoutMs })
        finish(() => reject(new Error(msg)))
      }, timeoutMs + 2_000)
    })
    const raw = (await readFile(outFile, 'utf-8')).trim()
    return raw ? JSON.parse(raw) as Record<string, any> : {}
  } finally {
    void rm(dir, { recursive: true, force: true }).catch(() => {})
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
  const message = task.output?.message ?? task.output?.summary ?? task.status_message
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

/** Map Minion gettask fields → Provision / Boot / Connect stage (Minion web UI). */
function deriveMinionSetup(
  task: Record<string, any>
): {
  active: SetupStepId
  title: string
  detail: string
  steps: Array<{ id: SetupStepId; label: string; state: SetupStepState }>
} | null {
  const status = String(task.status ?? '').toUpperCase()
  if (isTerminalStatus(status)) return null

  const display = extractDisplayStatus(task).toUpperCase()
  const runnerUrl = typeof task.runner_url === 'string' ? task.runner_url : ''
  const blob = `${display} ${status}`

  // Agent already running — no setup card.
  if (
    /TASK_STATUS_RUNNING|TASK_STATUS_IN_PROGRESS|TASK_STATUS_ACTIVE/.test(status) &&
    !/PROVISION|BOOT|PEND|QUEU|CREAT|START|INIT|CONNECT|ALLOC|PENDING/.test(display)
  ) {
    return null
  }
  if (
    /RUNN|IN_PROGRESS|ACTIVE|WORKING/.test(status) &&
    runnerUrl &&
    !/PROVISION|BOOT|PEND|QUEU|CREAT|START|INIT|CONNECT|ALLOC/.test(display)
  ) {
    return null
  }

  let active: SetupStepId = 'provision'
  if (/CONNECT/.test(blob) || (runnerUrl && /BOOT|START|INIT|ALLOC|PROVISION|PEND|QUEU|CREAT/.test(blob))) {
    active = runnerUrl ? 'connect' : 'boot'
  } else if (/BOOT|START|INIT|ALLOC/.test(blob)) {
    active = 'boot'
  } else if (runnerUrl) {
    active = 'connect'
  } else if (/PROVISION|PEND|QUEU|CREAT|UNKNOWN/.test(blob) || !status) {
    active = 'provision'
  } else {
    active = 'boot'
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
    boot: 'DevPod is starting up. I will keep this card updated.',
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

// ── MinionHarness ───────────────────────────────────────────────────────────

/**
 * How long to keep polling for a reply after a steer on a still-running task.
 * Finished tasks relaunch via CreateTask (new DevPod) instead of waiting on
 * a dead CreateInteraction.
 */
const POST_STEER_POLL_MS = 3 * 60 * 1000

interface MinionSessionState {
  channel: EventChannel
  /**
   * Minion task id we poll / steer / cancel. Equals the Atelier session id
   * until a finished-task follow-up CreateTask returns a child task.
   */
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
    const created = await callTool('createtask', {
      name: prompt.trim().split('\n')[0].slice(0, 80) || 'Atelier Minion task',
      prompt,
      runner: 'RUNNER_DEVPOD',
      agent: 'claude-code',
      parent_task_id: '',
      path: '.',
      input: {
        type: 'ARTIFACT_TYPE_BRANCH',
        code: { repo: repo.enum, branch: 'main', repo_name: repo.name, org_name: 'uber-code' }
      },
      expected_artifact_type: 'ARTIFACT_TYPE_PR',
      storage_path: '',
      user_id: '',
      jira_ids: [],
      mcp_servers: [],
      model: '',
      metadata: { source: 'atelier' },
      aifx_config: {},
      execution_mode: 'EXECUTION_MODE_INTERACTIVE',
      planning_mode: 'PLANNING_MODE_DIRECT',
      devpod_overrides: {}
    })
    const taskId: string | undefined = created.task?.id ?? created.id
    if (!taskId) throw new Error('Minion createtask returned no task id')

    const state = this.newState(taskId, { liveFromStart: true, remoteTaskId: taskId })
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
    this.pushSetupChrome(state, taskId, (created.task as Record<string, any>) ?? { status: 'TASK_STATUS_PENDING' })
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
      const res = await callTool('gettask', { id }) as { task?: Record<string, any> }
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
      if (activeFromOpts && activeFromOpts !== existing.remoteTaskId) {
        existing.remoteTaskId = activeFromOpts
        this.remember(sessionId, existing)
      }
      // Already live — just return the current event stream.
      this.ensurePolling(sessionId)
      return { sessionId, events: existing.channel[Symbol.asyncIterator]() }
    }
    if (existing) existing.channel.close()

    const state = this.newState(sessionId, {
      remoteTaskId: activeFromOpts || this.memory.get(sessionId)?.remoteTaskId || sessionId
    })
    this.sessions.set(sessionId, state)
    state.channel.push({
      type: 'session_started',
      sessionId,
      timestamp: new Date().toISOString(),
      model: 'minion',
      cwd: ''
    })
    // Always resume polling — even if the last run completed, a follow-up
    // may relaunch a DevPod (CreateTask) or steer a live job.
    this.ensurePolling(sessionId)
    return { sessionId, events: state.channel[Symbol.asyncIterator]() }
  }

  async interrupt(sessionId: string): Promise<void> {
    const wasPolling = this.polls.has(sessionId)
    this.polls.get(sessionId)?.abort()
    this.polls.delete(sessionId)
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
      await callTool('canceltask', { id: cancelId })
      try {
        const { task } = await callTool('gettask', { id: cancelId }) as { task?: Record<string, any> }
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
      logger.warn('minionHarness: canceltask failed', { sessionId, cancelId, error: String(err) })
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

  async streamInput(sessionId: string, message: string, _attachments?: HarnessFileInput[]): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state || state.closing || state.channel.closed) {
      logger.warn('minionHarness: streamInput for unknown/closing session', { sessionId })
      return
    }
    const text = message.trim()
    if (!text) return
    state.steeredTexts.add(text)
    state.lastSteeredAt = Date.now()

    let task: Record<string, any> | undefined
    try {
      const res = await callTool('gettask', { id: state.remoteTaskId }) as { task?: Record<string, any> }
      task = res.task
    } catch (err) {
      logger.warn('minionHarness: gettask before steer failed', {
        sessionId,
        remoteTaskId: state.remoteTaskId,
        error: err instanceof Error ? err.message : String(err)
      })
    }

    const status = String(task?.status ?? '')
    if (task && isTerminalStatus(status)) {
      try {
        await this.relaunchFromFinishedTask(sessionId, state, task, text)
      } catch (err) {
        state.steeredTexts.delete(text)
        state.lastSteeredAt = 0
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('minionHarness: follow-up CreateTask failed', { sessionId, error: msg })
        if (this.sessions.get(sessionId) === state && !state.closing && !state.channel.closed) {
          state.channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg })
        }
      }
      return
    }

    try {
      await callTool(
        'createinteraction',
        {
          task_id: state.remoteTaskId,
          initiator: 'INTERACTION_INITIATOR_USER',
          message: text,
          content: {
            surface: 'INTERACTION_SURFACE_API',
            type: 'INTERACTION_CONTENT_TYPE_TEXT',
            text
          }
        },
        CREATE_INTERACTION_TIMEOUT_MS
      )
    } catch (err) {
      state.steeredTexts.delete(text)
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('minionHarness: createinteraction failed', { sessionId, error: msg })
      if (this.sessions.get(sessionId) === state && !state.closing && !state.channel.closed) {
        state.channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg })
      }
      return
    }
    if (this.sessions.get(sessionId) !== state || state.closing || state.channel.closed) return
    // No transcript ack — composer busy/Stop is the in-flight signal. Real
    // Minion replies arrive via polling as progress rows.
    this.ensurePolling(sessionId)
  }

  /**
   * Finished/cancelled job: CreateTask with parent_task_id so Minion spins a
   * new DevPod with prior context. Same Atelier session; poll switches to the child.
   */
  private async relaunchFromFinishedTask(
    sessionId: string,
    state: MinionSessionState,
    parent: Record<string, any>,
    followUp: string
  ): Promise<void> {
    const parentId = String(parent.id ?? state.remoteTaskId)
    const input = parent.input && typeof parent.input === 'object'
      ? parent.input
      : {
          type: 'ARTIFACT_TYPE_BRANCH',
          code: { repo: 'REPO_GO_CODE', branch: 'main', repo_name: 'go-code', org_name: 'uber-code' }
        }
    const created = await callTool('createtask', {
      name: followUp.split('\n')[0]!.slice(0, 80) || String(parent.name ?? 'Minion follow-up'),
      prompt: followUp,
      runner: parent.runner || 'RUNNER_DEVPOD',
      agent: parent.agent || 'claude-code',
      parent_task_id: parentId,
      path: typeof parent.path === 'string' && parent.path.trim() ? parent.path : '.',
      input,
      expected_artifact_type: parent.expected_artifact_type || 'ARTIFACT_TYPE_PR',
      storage_path: '',
      user_id: '',
      jira_ids: [],
      mcp_servers: [],
      model: '',
      metadata: { source: 'atelier', follow_up_of: parentId },
      aifx_config: parent.aifx_config && typeof parent.aifx_config === 'object' ? parent.aifx_config : {},
      execution_mode: parent.execution_mode || 'EXECUTION_MODE_INTERACTIVE',
      planning_mode: parent.planning_mode || 'PLANNING_MODE_DIRECT',
      devpod_overrides: {}
    })
    if (this.sessions.get(sessionId) !== state || state.closing || state.channel.closed) return
    const newId: string | undefined = created.task?.id ?? created.id
    if (!newId) throw new Error('Minion follow-up CreateTask returned no task id')
    const childTask = (created.task as Record<string, any>) ?? {
      id: newId,
      status: 'TASK_STATUS_CREATED',
      runner_url: ''
    }

    state.remoteTaskId = newId
    state.completionPosted = false
    state.historySeeded = true
    state.scratch = emptyScratchWatermark()
    state.lastSetupKey = ''
    state.lastWorkingKey = ''
    state.lastLatestUpdate = ''
    state.lastScratchError = ''
    state.startedAt = Date.now()
    this.remember(sessionId, state)
    this.notifyRemoteTask(sessionId, newId)

    pushAssistantMessage(
      state.channel,
      sessionId,
      `Relaunching a DevPod from this job’s context…\n\nNew task: \`${newId}\``,
      'minion_relaunch'
    )
    this.pushSetupChrome(state, sessionId, childTask)
    this.ensurePolling(sessionId)
    this.notifyActivity(sessionId)
    logger.info('minionHarness: follow-up CreateTask relaunched DevPod', {
      sessionId,
      parentTaskId: parentId,
      remoteTaskId: newId
    })
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
   * Sidebar "working": polling a task that has not completed yet.
   * Post-complete / post-steer background polls are quiet — not execution.
   */
  isRemoteActive(sessionId: string): boolean {
    if (!this.polls.has(sessionId)) return false
    const state = this.sessions.get(sessionId)
    return !!state && !state.closing && !state.completionPosted
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
      const { task } = await callTool('gettask', { id: remoteId }) as { task?: Record<string, any> }
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
      // Fresh createtask: show live updates. Cold resume with no memory: seed first.
      historySeeded: opts?.liveFromStart === true || mem != null,
      scratch: mem?.scratch ? { ...mem.scratch } : emptyScratchWatermark(),
      lastWorkingKey: '',
      lastScratchError: ''
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
    const wasPolling = this.polls.has(sessionId)
    this.polls.get(sessionId)?.abort()
    this.polls.delete(sessionId)
    if (wasPolling) this.notifyActivity(sessionId)
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
    const setup = deriveMinionSetup(task)
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

  /** True when Working chrome is only the scratch-not-ready placeholder. */
  private isScratchWaitChrome(state: MinionSessionState): boolean {
    return state.lastWorkingKey.startsWith('Connecting to session')
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
      if (
        state.scratch.seeded &&
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
    if (this.polls.has(sessionId)) return
    void this.pollUntilDone(sessionId)
  }

  private async pollUntilDone(sessionId: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    const abort = new AbortController()
    this.polls.set(sessionId, abort)
    this.notifyActivity(sessionId)
    const { channel } = state
    const deadline = Date.now() + POLL_TIMEOUT_MS
    let errors = 0

    try {
      while (!abort.signal.aborted && Date.now() < deadline) {
        try {
          const taskId = state.remoteTaskId || sessionId
          const { task } = await callTool('gettask', { id: taskId }) as { task?: Record<string, any> }
          if (abort.signal.aborted) return
          errors = 0
          if (task) {
            const status = String(task.status ?? '')
            const update = extractLatestUpdate(task)

            // Cold resume: mark everything currently visible as already-seen so we
            // don't reprint the whole transcript, then wait for genuinely new rows.
            if (!state.historySeeded) {
              if (update) {
                state.lastLatestUpdate = update
                state.postedTexts.add(normalizeProgressText(update))
              }
              const listed = await callTool('listinteractions', {
                task_id: taskId,
                after_interaction_id: '',
                initiator_filter: 0,
                status_filter: 0
              })
              if (abort.signal.aborted) return
              for (const i of (listed.interactions ?? []) as Array<Record<string, any>>) {
                const id = String(i.id ?? i.interaction_id ?? '')
                if (id) state.seenInteractionIds.add(id)
                const text = interactionText(i)
                if (text) state.postedTexts.add(normalizeProgressText(text))
              }
              if (isTerminalStatus(status)) state.completionPosted = true
              state.historySeeded = true
              this.remember(sessionId, state)
              // Terminal cold-seed: drop "working" without waiting for softStop.
              this.notifyActivity(sessionId)
              this.pushSetupChrome(state, sessionId, task)
              // Seed scratch tools into the transcript once (no toast storm —
              // tool events don't notify; text goes through postedTexts).
              await this.pollScratch(sessionId, state, task, abort.signal)
              continue
            }

            if (update && update !== state.lastLatestUpdate) {
              state.lastLatestUpdate = update
              if (!state.scratch.healthy) {
                this.pushProgressOnce(state, sessionId, update)
              } else {
                // Still remember so a later fallback doesn't reprint.
                state.postedTexts.add(normalizeProgressText(update))
              }
            }

            // SETUP first; scratch may clear SETUP once chat.jsonl is live.
            // (Do not call pushSetupChrome after a healthy scratch poll — it
            // would stomp Working chrome while Connect is still "in progress".)
            if (!state.scratch.healthy) {
              this.pushSetupChrome(state, sessionId, task)
            }

            // Scratch Working/tool feed (append-aware). Prefer this over
            // orchestrator prose when healthy so we don't double-post.
            await this.pollScratch(sessionId, state, task, abort.signal)
            if (abort.signal.aborted) return
            // If scratch is still catching up, surface gettask status in Working
            // chrome instead of leaving "Connecting to session…".
            if (!state.scratch.healthy) {
              this.pushOrchestratorWorkingChrome(state, sessionId, task)
            }

            let sawNewInteraction = false
            const listed = await callTool('listinteractions', {
              task_id: taskId,
              after_interaction_id: '',
              initiator_filter: 0,
              status_filter: 0
            })
            if (abort.signal.aborted) return
            const interactions: Array<Record<string, any>> = listed.interactions ?? []
            for (const i of interactions) {
              const id = String(i.id ?? i.interaction_id ?? '')
              if (id) {
                if (state.seenInteractionIds.has(id)) continue
                state.seenInteractionIds.add(id)
              }
              const text = interactionText(i)
              if (!text) continue
              if (isUserInitiator(i.initiator) && state.steeredTexts.has(text)) continue
              if (state.scratch.healthy) {
                state.postedTexts.add(normalizeProgressText(text))
                continue
              }
              // Prefer interaction id dedupe; also skip if latest_update already showed this body.
              if (!this.pushProgressOnce(state, sessionId, text)) continue
              sawNewInteraction = true
            }

            if (isTerminalStatus(status)) {
              // Final scratch flush before announcing completion.
              await this.pollScratch(sessionId, state, task, abort.signal)
              if (!state.completionPosted && !state.closing) {
                state.completionPosted = true
                this.clearStatusChrome(state, sessionId)
                pushAssistantMessage(channel, sessionId, formatTaskSummary(task), 'end_turn', taskCost(task))
                this.notifyActivity(sessionId)
              }
              // After a recent steer on a still-running job that just finished,
              // keep polling briefly so the agent's reply can land.
              const awaitingReply =
                state.lastSteeredAt > 0 && Date.now() - state.lastSteeredAt < POST_STEER_POLL_MS
              if (!awaitingReply && !sawNewInteraction) {
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
