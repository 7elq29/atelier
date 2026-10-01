/**
 * CortanaHarness — HarnessDriver backed by the Uber Agent Gateway REST API.
 *
 * Transport: direct HTTPS to agent-gateway.uberinternal.com with a USSO
 * bearer token from `usso -fetch`. Polling replaces streaming: the async
 * endpoint returns a message_id immediately, and we poll get_session_snapshot
 * until the assistant's reply (or a new final_response) appears.
 *
 * Session-id contract: the session_id returned by create_session is used
 * directly as the Atelier app session id (same UUID format as the Claude CLI
 * assigns), so SessionManager's existing id-as-primary-key convention requires
 * no changes.
 *
 * Relaunch / mid-turn follow-up (Features/cortana-poll-reattach): in-memory
 * polls die on process exit. `resume()` reattaches to a gateway turn that
 * still lacks `final_response`. A follow-up while already polling is POSTed
 * but must not start a second poll keyed to a new message_id — Cortana
 * finishes under the original turn id.
 */

import { execFile } from 'node:child_process'
import { logger } from '../logger'
import type { HarnessDriver, HarnessEvent, HarnessFileInput, HarnessSession, HarnessStartOptions, PromptResponse } from './types'

const POLL_INTERVAL_MS = 5000
const POLL_TIMEOUT_MS = 30 * 60 * 1000

const AGENT_GATEWAY_BASE = 'https://agent-gateway.uberinternal.com'
const TOKEN_TTL_MS = 4 * 60 * 1000

// ── EventChannel ────────────────────────────────────────────────────────────

class EventChannel {
  private readonly queue: HarnessEvent[] = []
  private waiter: (() => void) | null = null
  private done = false

  push(event: HarnessEvent): void {
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

// ── USSO token + REST transport ──────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null

function fetchUssoToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'usso',
      ['-fetch', 'agent-gateway.uberinternal.com', '-print'],
      { timeout: 15_000 },
      (err, stdout) => {
        if (err) reject(new Error(`usso failed: ${err.message}`))
        else resolve(stdout.trim())
      }
    )
  })
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value
  const value = await fetchUssoToken()
  cachedToken = { value, expiresAt: Date.now() + TOKEN_TTL_MS }
  return value
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Rpc-Caller': 'atelier',
    'X-Uber-Source': 'atelier',
  }
}

async function callRest(
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
  _retry = true
): Promise<unknown> {
  const token = await getToken()
  const resp = await fetch(`${AGENT_GATEWAY_BASE}${path}`, {
    method,
    headers: {
      ...authHeaders(token),
      'Content-Type': 'application/json',
      ...(method === 'POST' ? { 'x-csrf-token': 'x' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (resp.status === 401 && _retry) {
    cachedToken = null
    return callRest(method, path, body, false)
  }
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`agent-gateway ${method} ${path}: HTTP ${resp.status}: ${text.slice(0, 300)}`)
  }
  return resp.json()
}

async function uploadFile(
  sessionId: string,
  attachment: HarnessFileInput
): Promise<{ filename: string; terrablobPath: string | null; terrablobUrl: string | null } | null> {
  const token = await getToken()
  const bytes = attachment.mimeType === 'text/plain'
    ? Buffer.from(attachment.data, 'utf-8')
    : Buffer.from(attachment.data, 'base64')
  const filename = attachment.name ?? `attachment.${attachment.mimeType.split('/')[1] ?? 'bin'}`
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: attachment.mimeType }), filename)
  const url = `${AGENT_GATEWAY_BASE}/api/v1/files/upload?session_id=${sessionId}&agent_name=cortana&author=human`
  const resp = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(token), 'x-csrf-token': 'x' },
    body: form,
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    logger.warn('cortanaHarness: file upload failed', {
      sessionId,
      filename,
      status: resp.status,
      body: body.slice(0, 300),
    })
    return null
  }
  const data = await resp.json() as {
    filename?: string
    terrablob_path?: string
    terrablob_url?: string
  }
  const uploadedName = data.filename ?? filename
  logger.info('cortanaHarness: file uploaded', {
    sessionId,
    filename: uploadedName,
    terrablobPath: data.terrablob_path ?? null,
  })
  return {
    filename: uploadedName,
    terrablobPath: data.terrablob_path ?? null,
    terrablobUrl: data.terrablob_url ?? null,
  }
}

// ── Snapshot types ───────────────────────────────────────────────────────────

interface SnapshotMessage {
  role: string
  content: string
  message_id: string
}

interface ExecutionEvent {
  event_type: string
  timestamp: string
  message_id: string
  content: string
  data: Record<string, unknown>
}

interface SnapshotResponse {
  history: SnapshotMessage[]
  execution_events: ExecutionEvent[]
  total_cost_usd: number
  cost_by_message_id: Record<string, number>
}

function finalResponseMessageIds(events: ExecutionEvent[] | undefined): Set<string> {
  const ids = new Set<string>()
  for (const e of events ?? []) {
    if (e.event_type === 'final_response' && e.message_id) ids.add(e.message_id)
  }
  return ids
}

/**
 * Gateway turn still running: execution_events include a message_id that has
 * not emitted `final_response` yet. Prefer the oldest such id (original turn).
 */
export function findInFlightMessageId(snapshot: SnapshotResponse): string | null {
  const events = snapshot.execution_events ?? []
  if (events.length === 0) return null
  const done = finalResponseMessageIds(events)
  const order: string[] = []
  const seen = new Set<string>()
  for (const e of events) {
    if (!e.message_id || seen.has(e.message_id)) continue
    seen.add(e.message_id)
    order.push(e.message_id)
  }
  for (const mid of order) {
    if (!done.has(mid)) return mid
  }
  return null
}

/**
 * Prefer assistant history for the tracked id; otherwise accept a *new*
 * final_response (and its assistant twin) so a mid-turn follow-up id does not
 * hang forever when Cortana finishes under the original turn id.
 */
export function resolveCortanaPollReply(
  snapshot: SnapshotResponse,
  trackedMessageId: string,
  seenFinalIds: Set<string>
): { messageId: string; content: string } | null {
  const history = snapshot.history ?? []
  const exact = history.find(m => m.role === 'assistant' && m.message_id === trackedMessageId)
  if (exact) return { messageId: trackedMessageId, content: exact.content }

  const events = snapshot.execution_events ?? []
  const newFinal = events.find(
    e => e.event_type === 'final_response' && e.message_id && !seenFinalIds.has(e.message_id)
  )
  if (!newFinal?.message_id) return null
  const fromHistory = history.find(m => m.role === 'assistant' && m.message_id === newFinal.message_id)
  const content = (fromHistory?.content ?? newFinal.content ?? '').trim()
  if (!content) return null
  return { messageId: newFinal.message_id, content: fromHistory?.content ?? newFinal.content }
}

// ── CortanaHarness ──────────────────────────────────────────────────────────

interface CortanaSessionState {
  cortanaSessionId: string
  channel: EventChannel
  /** The message_id of the in-flight turn, needed to call /sessions/stop on interrupt. */
  currentMessageId: string | null
  /** Cumulative session cost seen so far; used to compute per-turn delta. */
  lastTotalCostUsd: number
}

export class CortanaHarness implements HarnessDriver {
  private readonly sessions = new Map<string, CortanaSessionState>()
  private readonly polls = new Map<string, AbortController>()

  // ── HarnessDriver: lifecycle ─────────────────────────────────────────────

  async start(prompt: string, _opts: HarnessStartOptions): Promise<HarnessSession> {
    const result = await callRest('POST', '/api/v1/sessions/create', {
      agent_name: 'cortana',
      metadata: {},
    }) as { session_id: string }
    const cortanaSessionId = result.session_id
    const channel = new EventChannel()
    this.sessions.set(cortanaSessionId, { cortanaSessionId, channel, currentMessageId: null, lastTotalCostUsd: 0 })

    channel.push({
      type: 'session_started',
      sessionId: cortanaSessionId,
      timestamp: new Date().toISOString(),
      model: 'cortana',
      cwd: ''
    })

    if (prompt.trim()) {
      void this.sendAndPoll(cortanaSessionId, prompt, [])
    }

    return { sessionId: cortanaSessionId, events: channel[Symbol.asyncIterator]() }
  }

  async startWithId(_sessionId: string, prompt: string, opts: HarnessStartOptions): Promise<HarnessSession> {
    return this.start(prompt, opts)
  }

  async resume(sessionId: string, _opts?: Partial<HarnessStartOptions>): Promise<HarnessSession> {
    const existing = this.sessions.get(sessionId)
    // Same-process resume while a poll is live: keep the existing channel so
    // SessionManager can consume the eventual result (minion-style).
    if (existing && this.polls.has(sessionId)) {
      return { sessionId, events: existing.channel[Symbol.asyncIterator]() }
    }

    // fix-cortana-resume-orphan-poll: abort any leftover poll before swapping
    // the event channel so its `finally` cannot delete a newer turn's
    // AbortController from `this.polls` (same sessionId key).
    const inFlight = this.polls.get(sessionId)
    if (inFlight) {
      inFlight.abort()
      this.polls.delete(sessionId)
      logger.info('cortanaHarness: resume() aborted in-flight poll', { sessionId })
    }
    if (existing) existing.channel.close()
    const cortanaSessionId = existing?.cortanaSessionId ?? sessionId
    const channel = new EventChannel()
    this.sessions.set(sessionId, {
      cortanaSessionId,
      channel,
      currentMessageId: existing?.currentMessageId ?? null,
      lastTotalCostUsd: existing?.lastTotalCostUsd ?? 0
    })
    channel.push({
      type: 'session_started',
      sessionId,
      timestamp: new Date().toISOString(),
      model: 'cortana',
      cwd: ''
    })
    await this.tryReattachInFlight(sessionId)
    return { sessionId, events: channel[Symbol.asyncIterator]() }
  }

  async interrupt(sessionId: string): Promise<void> {
    const controller = this.polls.get(sessionId)
    if (controller) {
      controller.abort()
      this.polls.delete(sessionId)
    }
    const state = this.sessions.get(sessionId)
    if (state) {
      // Tell the backend to stop the in-flight turn.
      if (state.currentMessageId) {
        callRest('POST', '/api/v1/sessions/stop', {
          session_id: state.cortanaSessionId,
          message_id: state.currentMessageId,
        }).catch(err => {
          logger.warn('cortanaHarness: stop request failed', { sessionId, error: String(err) })
        })
      }
      state.channel.push({ type: 'interrupted', sessionId, timestamp: new Date().toISOString() })
      state.channel.close()
      this.sessions.delete(sessionId)
    }
  }

  // ── HarnessDriver: messaging ─────────────────────────────────────────────

  async streamInput(sessionId: string, message: string, attachments?: HarnessFileInput[]): Promise<void> {
    void this.sendAndPoll(sessionId, message, attachments ?? [])
  }

  isActive(sessionId: string): boolean {
    return this.polls.has(sessionId)
  }

  /**
   * After relaunch, if the gateway finished while we were dead and the local
   * transcript still ends on a user message, emit that assistant reply once.
   * Caller (SessionManager) must only invoke this when the DB trailing message
   * is role=user so we do not duplicate an already-stored assistant.
   *
   * When `knownAssistantContents` already includes the gateway's last final
   * text, skip — idle follow-ups reconnect with a trailing user message that
   * was just appended for the *new* turn; without this guard we re-emit the
   * previous turn's reply into the transcript every time.
   */
  async syncCompletedTurn(
    sessionId: string,
    opts?: { knownAssistantContents?: string[] }
  ): Promise<void> {
    if (this.polls.has(sessionId)) return
    const state = this.sessions.get(sessionId)
    if (!state) return
    try {
      const snapshot = await callRest(
        'GET',
        `/api/v1/sessions/${state.cortanaSessionId}/snapshot?limit=1000&offset=0`
      ) as SnapshotResponse
      if (findInFlightMessageId(snapshot)) {
        // In-flight handling belongs to tryReattachInFlight (already started on resume).
        return
      }
      const events = snapshot.execution_events ?? []
      const finals = events.filter(e => e.event_type === 'final_response' && e.message_id)
      const lastFinal = finals[finals.length - 1]
      if (!lastFinal?.message_id) return
      const fromHistory = (snapshot.history ?? []).find(
        m => m.role === 'assistant' && m.message_id === lastFinal.message_id
      )
      const content = (fromHistory?.content ?? lastFinal.content ?? '').trim()
      if (!content) return
      const known = opts?.knownAssistantContents ?? []
      if (known.some((c) => c.trim() === content)) {
        logger.info('cortanaHarness: syncCompletedTurn skipped; final already in transcript', {
          sessionId,
          messageId: lastFinal.message_id,
        })
        return
      }
      logger.info('cortanaHarness: syncing completed turn after resume', {
        sessionId,
        messageId: lastFinal.message_id,
      })
      const ts = new Date().toISOString()
      const sessionTotal = snapshot.total_cost_usd ?? 0
      const turnCost = Math.max(0, sessionTotal - state.lastTotalCostUsd)
      state.lastTotalCostUsd = sessionTotal
      state.channel.push({ type: 'sdk_status', sessionId, timestamp: ts, status: null })
      state.channel.push({ type: 'text_delta', sessionId, timestamp: ts, text: fromHistory?.content ?? lastFinal.content })
      state.channel.push({
        type: 'result',
        sessionId,
        timestamp: ts,
        isError: false,
        subtype: 'end_turn',
        numTurns: 1,
        durationMs: 0,
        totalCostUsd: turnCost,
        usage: null,
      })
      state.currentMessageId = null
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('cortanaHarness: syncCompletedTurn failed', { sessionId, error: msg })
    }
  }

  // ── HarnessDriver: stubs ─────────────────────────────────────────────────

  async validateModel(_sessionId: string, _model: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: false, error: 'Model selection is not supported for Cortana sessions.' }
  }

  async validateClaudeModel(_model: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: false, error: 'Model selection is not supported for Cortana sessions.' }
  }

  async getContextUsage(_sessionId: string): Promise<{ totalTokens: number; contextWindow: number } | null> {
    return null
  }

  async respondToPrompt(_sessionId: string, _requestId: string, _response: PromptResponse): Promise<void> {}

  async setPermissionMode(_sessionId: string, _mode: string): Promise<void> {}

  async listFiles(sessionId: string): Promise<Array<{ name: string; url: string }>> {
    const state = this.sessions.get(sessionId)
    const cortanaSessionId = state?.cortanaSessionId ?? sessionId
    const resp = await callRest('GET', `/api/v1/files/list?session_id=${cortanaSessionId}`) as {
      files: Array<{ filename: string; terrablob_url?: string }>
    }
    return (resp.files ?? []).map(f => ({ name: f.filename, url: f.terrablob_url ?? '' }))
  }

  // ── Internal: reattach + send + poll snapshot ────────────────────────────

  /** After relaunch: if gateway still has a turn without final_response, poll it. */
  private async tryReattachInFlight(sessionId: string): Promise<void> {
    if (this.polls.has(sessionId)) return
    const state = this.sessions.get(sessionId)
    if (!state) return
    try {
      const snapshot = await callRest(
        'GET',
        `/api/v1/sessions/${state.cortanaSessionId}/snapshot?limit=1000&offset=0`
      ) as SnapshotResponse
      const messageId = findInFlightMessageId(snapshot)
      if (!messageId) return
      state.currentMessageId = messageId
      logger.info('cortanaHarness: reattaching poll to in-flight turn', { sessionId, messageId })
      state.channel.push({
        type: 'sdk_status',
        sessionId,
        timestamp: new Date().toISOString(),
        status: 'requesting'
      })
      void this.pollForMessage(sessionId, messageId, { initialSnapshot: snapshot })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn('cortanaHarness: reattach snapshot failed', { sessionId, error: msg })
    }
  }

  private async sendAndPoll(sessionId: string, text: string, attachments: HarnessFileInput[]): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      logger.warn('cortanaHarness: sendAndPoll called for unknown session', { sessionId })
      return
    }
    const { cortanaSessionId, channel } = state

    // Upload attachments into this session's agent artifacts, then tell Cortana
    // to open those filenames via session file tools. Pasting terrablob URLs
    // alone fails for screenshots — the gateway URLs are auth-gated and are
    // not multimodal content blocks (fix-cortana-attachment-session-artifact).
    let userInput = text
    if (attachments.length > 0) {
      const uploads = await Promise.all(attachments.map((a) => uploadFile(cortanaSessionId, a)))
      const failed = uploads
        .map((u, i) => (u ? null : attachments[i]?.name ?? `attachment-${i + 1}`))
        .filter((name): name is string => name != null)
      if (failed.length > 0) {
        const msg = `Failed to upload attachment(s): ${failed.join(', ')}`
        logger.error('cortanaHarness: attachment upload failed', { sessionId, failed })
        channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg, retryable: true })
        return
      }
      const lines = uploads.map((u) => {
        const pathHint = u!.terrablobPath ? ` (artifact path: ${u!.terrablobPath})` : ''
        return `- ${u!.filename}${pathHint}`
      })
      const preamble = text.trim()
      const instruction = [
        "The user attached the following file(s) to THIS Cortana session's artifact store.",
        'Open each file with your session file tools and inspect it (for images: look at the pixels and describe what you see).',
        'Do NOT try to fetch terrablob or external URLs — use the session artifact filename/path below.',
        ...lines,
      ].join('\n')
      userInput = preamble ? `${preamble}\n\n${instruction}` : instruction
    }

    // Already attached to a gateway turn (e.g. after resume reattach). Post the
    // follow-up so Cortana sees it, but do not poll a new message_id — that id
    // never gets an assistant twin when the original turn finishes.
    if (this.polls.has(sessionId)) {
      logger.info('cortanaHarness: already polling; posting follow-up without new poll', {
        sessionId,
        currentMessageId: state.currentMessageId,
      })
      try {
        await callRest('POST', '/api/v1/chat/session/async', {
          session_id: cortanaSessionId,
          user_input: userInput,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error('cortanaHarness: follow-up send failed', { sessionId, error: msg })
        channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg })
      }
      return
    }

    let messageId: string
    try {
      const sent = await callRest('POST', '/api/v1/chat/session/async', {
        session_id: cortanaSessionId,
        user_input: userInput,
      }) as { message_id?: string; response?: { response_text?: string } }

      // 200 inline response — emit and return without polling.
      if (!sent.message_id) {
        const content = sent.response?.response_text ?? ''
        logger.info('cortanaHarness: inline response received', { sessionId })
        const ts = new Date().toISOString()
        channel.push({ type: 'text_delta', sessionId, timestamp: ts, text: content })
        channel.push({ type: 'result', sessionId, timestamp: ts, isError: false, subtype: 'end_turn', numTurns: 1, durationMs: 0, totalCostUsd: 0, usage: null })
        return
      }

      messageId = sent.message_id
      state.currentMessageId = messageId
      logger.info('cortanaHarness: message sent, polling snapshot', { sessionId, messageId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('cortanaHarness: failed to send message', { sessionId, error: msg })
      channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg })
      return
    }

    channel.push({ type: 'sdk_status', sessionId, timestamp: new Date().toISOString(), status: 'requesting' })
    await this.pollForMessage(sessionId, messageId)
  }

  private async pollForMessage(
    sessionId: string,
    messageId: string,
    opts?: { initialSnapshot?: SnapshotResponse }
  ): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) return
    if (this.polls.has(sessionId)) {
      logger.warn('cortanaHarness: pollForMessage skipped; poll already active', { sessionId, messageId })
      return
    }

    const { cortanaSessionId, channel } = state
    const abort = new AbortController()
    this.polls.set(sessionId, abort)
    const deadline = Date.now() + POLL_TIMEOUT_MS

    // Skip replaying historical tool events on reattach; only emit new ones.
    let emittedEventCount = opts?.initialSnapshot?.execution_events?.length ?? 0
    const seenFinalIds = finalResponseMessageIds(opts?.initialSnapshot?.execution_events)
    const openAgentToolUseIds = new Map<string, string>()
    let consecutivePollErrors = 0
    const MAX_CONSECUTIVE_POLL_ERRORS = 3

    const completeWith = (snapshot: SnapshotResponse, reply: { messageId: string; content: string }): void => {
      const ts = new Date().toISOString()
      const sessionTotal = snapshot.total_cost_usd ?? 0
      const turnCost = Math.max(0, sessionTotal - state.lastTotalCostUsd)
      state.lastTotalCostUsd = sessionTotal
      channel.push({ type: 'sdk_status', sessionId, timestamp: ts, status: null })
      channel.push({ type: 'text_delta', sessionId, timestamp: ts, text: reply.content })
      channel.push({
        type: 'result',
        sessionId,
        timestamp: ts,
        isError: false,
        subtype: 'end_turn',
        numTurns: 1,
        durationMs: 0,
        totalCostUsd: turnCost,
        usage: null,
      })
      state.currentMessageId = null
    }

    try {
      if (opts?.initialSnapshot) {
        const early = resolveCortanaPollReply(opts.initialSnapshot, messageId, seenFinalIds)
        if (early) {
          completeWith(opts.initialSnapshot, early)
          return
        }
      }

      while (!abort.signal.aborted && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS)
        if (abort.signal.aborted) return

        let snapshot: SnapshotResponse
        try {
          snapshot = await callRest(
            'GET',
            `/api/v1/sessions/${cortanaSessionId}/snapshot?limit=1000&offset=0`
          ) as SnapshotResponse
          consecutivePollErrors = 0
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          consecutivePollErrors++
          if (consecutivePollErrors < MAX_CONSECUTIVE_POLL_ERRORS) {
            logger.warn('cortanaHarness: poll error (retrying)', { sessionId, error: msg, consecutivePollErrors })
            continue
          }
          logger.error('cortanaHarness: poll error (giving up)', { sessionId, error: msg, consecutivePollErrors })
          channel.push({ type: 'sdk_status', sessionId, timestamp: new Date().toISOString(), status: null })
          channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg, retryable: true })
          return
        }

        const allEvents = snapshot.execution_events ?? []
        const newEvents = allEvents.slice(emittedEventCount)
        for (const evt of newEvents) {
          emittedEventCount++
          this.emitExecutionEvent(sessionId, channel, evt, messageId, openAgentToolUseIds)
        }

        const reply = resolveCortanaPollReply(snapshot, messageId, seenFinalIds)
        if (reply) {
          if (reply.messageId !== messageId) {
            logger.info('cortanaHarness: completing via final_response under different message_id', {
              sessionId,
              trackedMessageId: messageId,
              completedMessageId: reply.messageId,
            })
          }
          completeWith(snapshot, reply)
          return
        }
      }

      if (!abort.signal.aborted) {
        channel.push({ type: 'sdk_status', sessionId, timestamp: new Date().toISOString(), status: null })
        channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: 'Cortana response timed out.' })
      }
    } finally {
      // Only clear our own controller — a resume()/newer sendAndPoll may have
      // already replaced polls.get(sessionId) with a different AbortController.
      if (this.polls.get(sessionId) === abort) {
        this.polls.delete(sessionId)
      }
    }
  }

  private emitExecutionEvent(
    sessionId: string,
    channel: EventChannel,
    evt: ExecutionEvent,
    messageId: string,
    openIds: Map<string, string>
  ): void {
    const ts = evt.timestamp ?? new Date().toISOString()

    if (evt.event_type === 'tool_invocation') {
      const toolId = (evt.data.tool_id as string | undefined) ?? `cortana-tool-${Date.now()}`
      const toolName = (evt.data.tool_name as string | undefined) ?? 'Tool'
      let input: unknown = evt.data.input_data ?? {}
      if (typeof input === 'string') {
        try { input = JSON.parse(input) } catch { /* keep as string */ }
      }
      openIds.set(toolId, toolId)
      channel.push({
        type: 'tool_call_start',
        sessionId,
        timestamp: ts,
        toolUseId: toolId,
        name: toolName,
        input,
        parentToolUseId: null,
      })
    } else if (evt.event_type === 'tool_result') {
      const toolId = (evt.data.tool_use_id as string | undefined) ?? ''
      openIds.delete(toolId)
      channel.push({
        type: 'tool_call_end',
        sessionId,
        timestamp: ts,
        toolUseId: toolId,
        isError: evt.data.is_error === 'True' || evt.data.is_error === true,
        output: evt.data.output ?? '',
        parentToolUseId: null,
      })
    } else if (evt.event_type === 'agent_start' && evt.data.execution_type === 'claude_agent') {
      const toolUseId = `cortana-agent-${messageId}`
      openIds.set('claude_agent', toolUseId)
      channel.push({
        type: 'tool_call_start',
        sessionId,
        timestamp: ts,
        toolUseId,
        name: (evt.data.agent_name as string | undefined) ?? 'Cortana',
        input: { model: evt.data.model ?? 'cortana' },
        parentToolUseId: null,
      })
    } else if (evt.event_type === 'agent_end' && evt.data.execution_type === 'claude_agent') {
      const toolUseId = openIds.get('claude_agent') ?? `cortana-agent-${messageId}`
      openIds.delete('claude_agent')
      channel.push({
        type: 'tool_call_end',
        sessionId,
        timestamp: ts,
        toolUseId,
        isError: evt.data.success === false,
        output: evt.data.output ?? '',
        parentToolUseId: null,
      })
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export const cortanaHarness = new CortanaHarness()
