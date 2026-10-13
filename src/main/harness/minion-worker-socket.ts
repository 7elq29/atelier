/**
 * Minion DevPod worker WebSocket — port of uTerm `worker-socket.ts` / Minion Web pool.
 *
 * URL: wss://minion.uberinternal.com/ws/ws/{taskId}?x-proxy-devpod-*&batching_size…
 * Auth: USSO Bearer (same token as Minion HTTP).
 *
 * Lifecycle: connecting → replaying → live ⇄ backoff.
 * Working signal: connected.worker_state / status_change status === 2 (RUNNING).
 */

import { WebSocket as UndiciWebSocket } from 'undici'
import { logger } from '../logger'
import { getMinionBearerToken, invalidateMinionToken } from './minion-http-client'

/**
 * Electron main has no global WebSocket (Chromium's is renderer-only; Electron's
 * Node build is older than the undici global). Use undici's WHATWG client.
 */
type WorkerWebSocket = InstanceType<typeof UndiciWebSocket>

export const MINION_WS_BASE = 'wss://minion.uberinternal.com/ws/ws'
export const MINION_WORKER_PORT = 8766
export const MINION_STATUS_RUNNING = 2
export const WS_CONNECT_TIMEOUT_MS = 10_000
export const WS_PING_INTERVAL_MS = 20_000
export const WS_PONG_TIMEOUT_MS = 10_000
export const WS_BACKOFF_BASE_MS = 1_000
export const WS_BACKOFF_MAX_MS = 30_000
export const WS_BATCHING_SIZE = 500

export type WorkerSocketState = 'idle' | 'connecting' | 'replaying' | 'live' | 'backoff' | 'stopped'

export type MinionWsCommand =
  | { type: 'USER_MESSAGE'; data: { message: string; attachments?: string[] } }
  | {
      type: 'ELICITATION_RESPONSE'
      data: { call_id: string; answers: Record<string, string | readonly string[]> }
    }
  | { type: 'INTERRUPT'; data: Record<string, never> }
  | { type: 'CHANGE_MODE'; data: { mode: 'interactive' | 'auto' | 'plan' } }

export type MinionWorkerEvent = {
  type: string
  seq: number
  timestamp?: number
  status?: number
  call_id?: string
  text?: string
  role?: string
  message?: string
  questions?: unknown
  answers?: Record<string, string | readonly string[]>
  raw: Record<string, unknown>
}

export type MinionConnectedParams = {
  workerState?: number
  lastSeq?: number
  executionMode?: string
  pendingElicitation?: { callId: string; questions: unknown[] }
}

export function workerSocketUrl(opts: {
  taskId: string
  devpodName: string
  region: string
  since?: number
  wsBase?: string
}): string {
  const params = new URLSearchParams({
    'x-proxy-devpod-name': opts.devpodName,
    'x-proxy-devpod-region': opts.region,
    'x-proxy-devpod-port': String(MINION_WORKER_PORT),
    batching_size: String(WS_BATCHING_SIZE)
  })
  if (opts.since !== undefined && opts.since >= 0) params.set('since', String(opts.since))
  const base = opts.wsBase ?? MINION_WS_BASE
  return `${base}/${encodeURIComponent(opts.taskId)}?${params.toString()}`
}

export function userMessageCommand(message: string, attachments: string[] = []): MinionWsCommand {
  return {
    type: 'USER_MESSAGE',
    data: attachments.length ? { message, attachments: [...attachments] } : { message }
  }
}

export function elicitationResponseCommand(
  callId: string,
  answers: Record<string, string | readonly string[]>
): MinionWsCommand {
  return { type: 'ELICITATION_RESPONSE', data: { call_id: callId, answers } }
}

export function interruptCommand(): MinionWsCommand {
  return { type: 'INTERRUPT', data: {} }
}

export function commandFrame(command: MinionWsCommand): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'command',
    params: { type: command.type, data: command.data }
  })
}

export function isWorkerRunning(workerState: number | undefined | null): boolean {
  return workerState === MINION_STATUS_RUNNING
}

function backoffDelay(attempt: number): number {
  const ceiling = Math.min(WS_BACKOFF_MAX_MS, WS_BACKOFF_BASE_MS * 2 ** Math.min(attempt, 16))
  return Math.floor(Math.random() * ceiling)
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function decodeEvent(raw: Record<string, unknown>): MinionWorkerEvent | null {
  const type = typeof raw.type === 'string' ? raw.type : ''
  const seq = num(raw, 'seq')
  if (!type || seq === undefined) return null
  const statusChange = asRecord(raw.status_change)
  const textDelta = asRecord(raw.text_delta)
  const userMessage = asRecord(raw.user_message)
  const elicitation = asRecord(raw.elicitation_request) ?? asRecord(raw.elicitation)
  const elicitationResponse = asRecord(raw.elicitation_response)
  return {
    type,
    seq,
    timestamp: num(raw, 'timestamp'),
    status: statusChange ? num(statusChange, 'status') : undefined,
    call_id:
      (typeof elicitation?.call_id === 'string' && elicitation.call_id) ||
      (typeof elicitationResponse?.call_id === 'string' && elicitationResponse.call_id) ||
      undefined,
    text: typeof textDelta?.text === 'string' ? textDelta.text : undefined,
    role: typeof textDelta?.role === 'string' ? textDelta.role : undefined,
    message: typeof userMessage?.message === 'string' ? userMessage.message : undefined,
    questions: elicitation?.questions,
    answers:
      elicitationResponse?.answers && typeof elicitationResponse.answers === 'object'
        ? (elicitationResponse.answers as Record<string, string | readonly string[]>)
        : undefined,
    raw
  }
}

export type WorkerSocketCallbacks = {
  onState?: (state: WorkerSocketState) => void
  onConnected?: (params: MinionConnectedParams) => void
  onEvents?: (events: MinionWorkerEvent[], phase: 'replay' | 'live') => void
  onWorkerState?: (workerState: number | undefined) => void
  onReset?: () => void
  /** Return false to stop reconnecting. */
  onDisconnect?: (reason: string, attempt: number) => boolean | Promise<boolean>
}

export class MinionWorkerSocket {
  private ws: WorkerWebSocket | null = null
  private stateValue: WorkerSocketState = 'idle'
  private attempt = 0
  private lastSeqValue: number | undefined
  private workerStateValue: number | undefined
  private buffer: MinionWorkerEvent[] = []
  private generation = 0
  private unauthorizedRetried = false
  private connectTimer: ReturnType<typeof setTimeout> | undefined
  private pingTimer: ReturnType<typeof setTimeout> | undefined
  private pongTimer: ReturnType<typeof setTimeout> | undefined
  private backoffTimer: ReturnType<typeof setTimeout> | undefined
  private pingId = 0

  constructor(
    private readonly opts: {
      taskId: string
      devpodName: string
      region: string
      /** Resume cursor — dial with since= (omit for full replay / resetOnConnect). */
      initialSince?: number
    } & WorkerSocketCallbacks
  ) {
    if (opts.initialSince !== undefined && opts.initialSince >= 0) {
      this.lastSeqValue = opts.initialSince
    }
  }

  get state(): WorkerSocketState {
    return this.stateValue
  }

  get lastSeq(): number | undefined {
    return this.lastSeqValue
  }

  /** Clear resume cursor so the next dial requests a full replay. */
  clearResumeCursor(): void {
    this.lastSeqValue = undefined
  }

  get workerState(): number | undefined {
    return this.workerStateValue
  }

  get isLive(): boolean {
    return this.stateValue === 'live'
  }

  start(): void {
    if (this.stateValue !== 'idle' && this.stateValue !== 'stopped') return
    if (this.stateValue === 'stopped') this.stateValue = 'idle'
    void this.connect()
  }

  stop(): void {
    this.generation++
    this.clearTimers()
    this.dropSocket()
    this.setState('stopped')
  }

  sendCommand(command: MinionWsCommand): boolean {
    if (!this.isLive || !this.ws || this.ws.readyState !== UndiciWebSocket.OPEN) return false
    try {
      this.ws.send(commandFrame(command))
      return true
    } catch {
      this.fail('network')
      return false
    }
  }

  private setState(state: WorkerSocketState): void {
    this.stateValue = state
    this.opts.onState?.(state)
  }

  private clearTimers(): void {
    for (const t of [this.connectTimer, this.pingTimer, this.pongTimer, this.backoffTimer]) {
      if (t !== undefined) clearTimeout(t)
    }
    this.connectTimer = this.pingTimer = this.pongTimer = this.backoffTimer = undefined
  }

  private dropSocket(): void {
    const ws = this.ws
    this.ws = null
    if (!ws) return
    try {
      ws.close()
    } catch {
      /* ignore */
    }
  }

  private async connect(): Promise<void> {
    const generation = ++this.generation
    this.buffer = []
    this.setState('connecting')
    const url = workerSocketUrl({
      ...this.opts,
      ...(this.lastSeqValue !== undefined ? { since: this.lastSeqValue } : {})
    })
    let token: string
    try {
      token = await getMinionBearerToken()
    } catch (err) {
      logger.warn('minionWorkerSocket: usso token failed', { error: String(err) })
      this.fail('unauthorized')
      return
    }
    if (generation !== this.generation) return

    let ws: WorkerWebSocket
    try {
      ws = new UndiciWebSocket(url, {
        headers: { Authorization: `Bearer ${token}` }
      })
    } catch (err) {
      logger.warn('minionWorkerSocket: constructor failed', { error: String(err) })
      this.fail('network')
      return
    }
    this.ws = ws
    this.connectTimer = setTimeout(() => {
      this.connectTimer = undefined
      if (generation === this.generation) this.fail('timeout')
    }, WS_CONNECT_TIMEOUT_MS)

    ws.addEventListener('open', () => {
      /* wait for connected frame */
    })
    ws.addEventListener('error', () => {
      if (generation === this.generation) this.fail('network')
    })
    ws.addEventListener('close', (ev) => {
      if (generation === this.generation) {
        this.fail(ev.code === 1006 ? 'unreachable' : 'network')
      }
    })
    ws.addEventListener('message', (ev) => {
      if (generation === this.generation) this.onMessage(String(ev.data ?? ''))
    })
  }

  private onMessage(text: string): void {
    if (!text || text.length > 32 * 1024 * 1024) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    const frame = asRecord(parsed)
    if (!frame) return

    if (frame.method === 'connected') {
      if (this.connectTimer !== undefined) {
        clearTimeout(this.connectTimer)
        this.connectTimer = undefined
      }
      this.unauthorizedRetried = false
      this.setState('replaying')
      const params = asRecord(frame.params) ?? {}
      const workerState = num(params, 'worker_state')
      const lastSeq = num(params, 'last_seq')
      if (workerState !== undefined) {
        this.workerStateValue = workerState
        this.opts.onWorkerState?.(workerState)
      }
      // Worker store reset: our cursor is ahead of the server — full replay.
      if (lastSeq !== undefined && this.lastSeqValue !== undefined && this.lastSeqValue > lastSeq) {
        this.lastSeqValue = undefined
        this.opts.onReset?.()
        this.generation++
        this.dropSocket()
        void this.connect()
        return
      }
      const pe = asRecord(params.pending_elicitation)
      const connected: MinionConnectedParams = {
        ...(workerState !== undefined ? { workerState } : {}),
        ...(lastSeq !== undefined ? { lastSeq } : {}),
        ...(typeof params.execution_mode === 'string' ? { executionMode: params.execution_mode } : {}),
        ...(pe && typeof pe.call_id === 'string' && Array.isArray(pe.questions)
          ? { pendingElicitation: { callId: pe.call_id, questions: pe.questions as unknown[] } }
          : {})
      }
      this.opts.onConnected?.(connected)
      return
    }

    if (frame.method === 'replay_complete') {
      const params = asRecord(frame.params) ?? {}
      const truncated = params.truncated === true
      this.onReplayComplete(truncated)
      return
    }

    if (frame.method === 'pong') {
      if (this.pongTimer !== undefined) {
        clearTimeout(this.pongTimer)
        this.pongTimer = undefined
      }
      return
    }

    if (frame.method === 'events_batch' || frame.method === 'event') {
      const params = asRecord(frame.params) ?? {}
      const list: Record<string, unknown>[] = []
      if (frame.method === 'events_batch' && Array.isArray(params.events)) {
        for (const e of params.events) {
          const r = asRecord(e)
          if (r) list.push(r)
        }
      } else {
        list.push(params)
      }
      const decoded = this.dedupe(list.map(decodeEvent).filter((e): e is MinionWorkerEvent => !!e))
      if (!decoded.length) return
      if (this.stateValue === 'live') {
        this.lastSeqValue = decoded[decoded.length - 1]!.seq
        this.applyStatusFromEvents(decoded)
        this.opts.onEvents?.(decoded, 'live')
      } else {
        this.buffer.push(...decoded)
      }
      return
    }

    // Some workers send bare event objects (type+seq) without jsonrpc envelope.
    if (typeof frame.type === 'string' && num(frame, 'seq') !== undefined) {
      const ev = decodeEvent(frame)
      if (!ev) return
      const decoded = this.dedupe([ev])
      if (!decoded.length) return
      if (this.stateValue === 'live') {
        this.lastSeqValue = decoded[decoded.length - 1]!.seq
        this.applyStatusFromEvents(decoded)
        this.opts.onEvents?.(decoded, 'live')
      } else {
        this.buffer.push(...decoded)
      }
    }
  }

  private applyStatusFromEvents(events: MinionWorkerEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'status_change' && typeof ev.status === 'number') {
        this.workerStateValue = ev.status
        this.opts.onWorkerState?.(ev.status)
      }
    }
  }

  private dedupe(events: MinionWorkerEvent[]): MinionWorkerEvent[] {
    let floor =
      this.stateValue === 'live'
        ? this.lastSeqValue
        : (this.buffer.at(-1)?.seq ?? this.lastSeqValue)
    const accepted: MinionWorkerEvent[] = []
    for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
      if (floor !== undefined && event.seq <= floor) continue
      accepted.push(event)
      floor = event.seq
    }
    return accepted
  }

  private onReplayComplete(truncated: boolean): void {
    if (this.stateValue !== 'replaying' && this.stateValue !== 'connecting') return
    if (this.connectTimer !== undefined) {
      clearTimeout(this.connectTimer)
      this.connectTimer = undefined
    }
    if (truncated && this.lastSeqValue !== undefined) {
      this.buffer = []
      this.lastSeqValue = undefined
      this.opts.onReset?.()
      this.generation++
      this.dropSocket()
      void this.connect()
      return
    }
    const events = this.buffer
    this.buffer = []
    if (events.length) this.lastSeqValue = events[events.length - 1]!.seq
    this.applyStatusFromEvents(events)
    this.attempt = 0
    this.setState('live')
    if (events.length) this.opts.onEvents?.(events, 'replay')
    this.schedulePing()
  }

  private schedulePing(): void {
    if (this.pingTimer !== undefined) clearTimeout(this.pingTimer)
    this.pingTimer = setTimeout(() => {
      this.pingTimer = undefined
      if (this.stateValue !== 'live' || !this.ws) return
      const id = ++this.pingId
      try {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', id }))
      } catch {
        this.fail('network')
        return
      }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = undefined
        this.fail('pong-timeout')
      }, WS_PONG_TIMEOUT_MS)
      this.schedulePing()
    }, WS_PING_INTERVAL_MS)
  }

  private fail(reason: string): void {
    if (this.stateValue === 'stopped' || this.stateValue === 'backoff') return
    this.generation++
    this.clearTimers()
    this.dropSocket()
    this.buffer = []
    if (reason === 'unauthorized') {
      if (this.unauthorizedRetried) {
        this.setState('stopped')
        void this.opts.onDisconnect?.(reason, this.attempt)
        return
      }
      this.unauthorizedRetried = true
      invalidateMinionToken()
      void this.connect()
      return
    }
    this.attempt++
    const attempt = this.attempt
    const generation = this.generation
    this.setState('backoff')
    void Promise.resolve(this.opts.onDisconnect?.(reason, attempt) ?? true).then((keepGoing) => {
      if (generation !== this.generation || this.stateValue !== 'backoff') return
      if (keepGoing === false) {
        this.stop()
        return
      }
      this.backoffTimer = setTimeout(() => {
        this.backoffTimer = undefined
        if (generation === this.generation && this.stateValue === 'backoff') void this.connect()
      }, backoffDelay(attempt - 1))
    })
  }
}
