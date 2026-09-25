/**
 * CortanaHarness — HarnessDriver backed by the Uber Agent Gateway REST API.
 *
 * Transport: direct HTTPS to agent-gateway.uberinternal.com with a USSO
 * bearer token obtained via `usso -fetch`. Polling replaces streaming: the
 * async endpoint returns a message_id immediately, and we poll
 * get_session_snapshot until the assistant's reply appears.
 *
 * Session-id contract: the session_id returned by create_session is used
 * directly as the Atelier app session id (same UUID format as the Claude CLI
 * assigns), so SessionManager's existing id-as-primary-key convention requires
 * no changes.
 */

import { execFile } from 'node:child_process'
import { logger } from '../logger'
import type { HarnessDriver, HarnessEvent, HarnessFileInput, HarnessSession, HarnessStartOptions, PromptResponse } from './types'

/** Minimum polling interval between get_session_snapshot calls, in ms. */
const POLL_INTERVAL_MS = 1500
/** How long to poll before giving up on a response, in ms. */
const POLL_TIMEOUT_MS = 30 * 60 * 1000

const AGENT_GATEWAY_BASE = 'https://agent-gateway.uberinternal.com'
/** Cache USSO tokens for 4 minutes (tokens are valid for ~5 minutes). */
const TOKEN_TTL_MS = 4 * 60 * 1000

// ── EventChannel ────────────────────────────────────────────────────────────

/**
 * A push-into/pull-from async generator channel. push() enqueues events;
 * close() signals the generator to return. Callers iterate via
 * `channel[Symbol.asyncIterator]()` which is what HarnessSession.events expects.
 */
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
      Authorization: `Bearer ${token}`,
      'Rpc-Caller': 'atelier',
      'X-Uber-Source': 'atelier',
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

// ── CortanaHarness ──────────────────────────────────────────────────────────

interface CortanaSessionState {
  /** The Agent Gateway session_id (== Atelier app session id). */
  cortanaSessionId: string
  /** The event channel for the current connection. Replaced on resume(). */
  channel: EventChannel
}

export class CortanaHarness implements HarnessDriver {
  /** sessionId → state for all active Cortana sessions. */
  private readonly sessions = new Map<string, CortanaSessionState>()
  /** sessionId → AbortController for the current in-flight poll. */
  private readonly polls = new Map<string, AbortController>()

  // ── HarnessDriver: lifecycle ─────────────────────────────────────────────

  async start(prompt: string, _opts: HarnessStartOptions): Promise<HarnessSession> {
    const result = await callRest('POST', '/api/v1/sessions/create', {
      agent_name: 'cortana',
      metadata: {},
    }) as { session_id: string }
    const cortanaSessionId = result.session_id
    const channel = new EventChannel()
    this.sessions.set(cortanaSessionId, { cortanaSessionId, channel })

    channel.push({
      type: 'session_started',
      sessionId: cortanaSessionId,
      timestamp: new Date().toISOString(),
      model: 'cortana',
      cwd: ''
    })

    if (prompt.trim()) {
      void this.sendAndPoll(cortanaSessionId, prompt)
    }

    return { sessionId: cortanaSessionId, events: channel[Symbol.asyncIterator]() }
  }

  async startWithId(_sessionId: string, prompt: string, opts: HarnessStartOptions): Promise<HarnessSession> {
    // Cortana has no concept of a pre-assigned session id — create fresh.
    return this.start(prompt, opts)
  }

  async resume(sessionId: string, _opts?: Partial<HarnessStartOptions>): Promise<HarnessSession> {
    // The sessionId IS the cortana_session_id — create a new channel so the
    // manager's consume() loop gets a fresh generator for this reconnect.
    const existing = this.sessions.get(sessionId)
    const cortanaSessionId = existing?.cortanaSessionId ?? sessionId
    const channel = new EventChannel()
    this.sessions.set(sessionId, { cortanaSessionId, channel })
    channel.push({
      type: 'session_started',
      sessionId,
      timestamp: new Date().toISOString(),
      model: 'cortana',
      cwd: ''
    })
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
      state.channel.push({ type: 'interrupted', sessionId, timestamp: new Date().toISOString() })
      state.channel.close()
      this.sessions.delete(sessionId)
    }
  }

  // ── HarnessDriver: messaging ─────────────────────────────────────────────

  async streamInput(sessionId: string, message: string, _attachments?: HarnessFileInput[]): Promise<void> {
    void this.sendAndPoll(sessionId, message)
  }

  isActive(sessionId: string): boolean {
    return this.polls.has(sessionId)
  }

  // ── HarnessDriver: stubs for Claude-SDK-specific features ────────────────

  async validateModel(_sessionId: string, _model: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: false, error: 'Model selection is not supported for Cortana sessions.' }
  }

  async validateClaudeModel(_model: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: false, error: 'Model selection is not supported for Cortana sessions.' }
  }

  async getContextUsage(_sessionId: string): Promise<{ totalTokens: number; contextWindow: number } | null> {
    return null
  }

  async respondToPrompt(_sessionId: string, _requestId: string, _response: PromptResponse): Promise<void> {
    // Cortana does not emit interactive prompts.
  }

  async setPermissionMode(_sessionId: string, _mode: string): Promise<void> {
    // Cortana has no permission-mode concept.
  }

  // ── Internal: async send + poll ──────────────────────────────────────────

  private async sendAndPoll(sessionId: string, text: string): Promise<void> {
    const state = this.sessions.get(sessionId)
    if (!state) {
      logger.warn('cortanaHarness: sendAndPoll called for unknown session', { sessionId })
      return
    }
    const { cortanaSessionId, channel } = state

    let messageId: string
    try {
      const sent = await callRest('POST', '/api/v1/chat/session/async', {
        session_id: cortanaSessionId,
        user_input: text,
      }) as { message_id?: string; status?: string }
      if (!sent.message_id) {
        throw new Error('No message_id in async chat response')
      }
      messageId = sent.message_id
      logger.info('cortanaHarness: message sent, polling for reply', { sessionId, messageId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.error('cortanaHarness: failed to send message', { sessionId, error: msg })
      channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg })
      return
    }

    const abort = new AbortController()
    this.polls.set(sessionId, abort)
    const deadline = Date.now() + POLL_TIMEOUT_MS

    try {
      while (!abort.signal.aborted && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS)
        if (abort.signal.aborted) return

        let history: Array<{ role: string; content: string; message_id: string }>
        try {
          const resp = await callRest(
            'GET',
            `/api/v1/sessions/${cortanaSessionId}/snapshot?limit=1000&offset=0`
          ) as { history: Array<{ role: string; content: string; message_id: string }> }
          history = resp.history ?? []
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error('cortanaHarness: poll error', { sessionId, error: msg })
          channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg })
          return
        }

        const reply = history.find(
          (m) => m.role === 'assistant' && m.message_id === messageId
        )
        if (reply) {
          const ts = new Date().toISOString()
          channel.push({ type: 'text_delta', sessionId, timestamp: ts, text: reply.content })
          channel.push({
            type: 'result',
            sessionId,
            timestamp: ts,
            isError: false,
            subtype: 'end_turn',
            numTurns: 1,
            durationMs: 0,
            totalCostUsd: 0,
            usage: null
          })
          return
        }
      }

      if (!abort.signal.aborted) {
        channel.push({
          type: 'error',
          sessionId,
          timestamp: new Date().toISOString(),
          message: 'Cortana response timed out.'
        })
      }
    } finally {
      this.polls.delete(sessionId)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Convenience re-export so index.ts has a single import path. */
export const cortanaHarness = new CortanaHarness()
