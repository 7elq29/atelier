/**
 * CortanaHarness — HarnessDriver backed by the Uber Agent Gateway REST API.
 *
 * Transport: every API call is routed through `aifx mcp call agent-gateway`
 * which handles USSO auth automatically. Polling replaces streaming: the async
 * endpoint returns a message_id immediately, and we poll get_session_history
 * until the assistant's reply appears.
 *
 * Session-id contract: the cortana_session_id returned by create_session is
 * used directly as the Atelier app session id (same UUID format as the Claude
 * CLI assigns), so SessionManager's existing id-as-primary-key convention
 * requires no changes.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { logger } from '../logger'
import type { HarnessDriver, HarnessEvent, HarnessFileInput, HarnessSession, HarnessStartOptions, PromptResponse } from './types'

/** Minimum polling interval between get_session_history calls, in ms. */
const POLL_INTERVAL_MS = 1500
/** How long to poll before giving up on a response, in ms. */
const POLL_TIMEOUT_MS = 5 * 60 * 1000

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

// ── aifx transport ──────────────────────────────────────────────────────────

function callAgentGateway(tool: string, args: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'aifx',
      ['mcp', 'call', 'agent-gateway', tool, '--args', JSON.stringify(args)],
      { timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`aifx mcp call agent-gateway ${tool} failed: ${err.message}\nstderr: ${stderr}`))
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(new Error(`Invalid JSON from agent-gateway ${tool}: ${stdout.slice(0, 300)}`))
        }
      }
    )
  })
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
    const result = await callAgentGateway('create_session', { agent_name: 'cortana' }) as {
      session_id: string
    }
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
      const sent = await callAgentGateway('agent_gateway_chat_session_async', {
        session_id: cortanaSessionId,
        user_input: text
      }) as { message_id: string; status: string }
      messageId = sent.message_id
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
          const resp = await callAgentGateway('get_session_history', {
            session_id: cortanaSessionId,
            message_id: messageId
          }) as { history: Array<{ role: string; content: string; message_id: string }> }
          history = resp.history ?? []
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error('cortanaHarness: poll error', { sessionId, error: msg })
          channel.push({ type: 'error', sessionId, timestamp: new Date().toISOString(), message: msg })
          return
        }

        // The assistant reply shares the user message's message_id.
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
