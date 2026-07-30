/**
 * Harness/driver abstraction (task 01-harness-abstraction).
 *
 * A "harness" wraps a coding-agent backend (Claude Code via the Agent SDK
 * today; other drivers can be added later behind the same interface) and
 * exposes a normalized event stream so callers (02-session-lifecycle, and
 * eventually the renderer) never need to know which backend produced a
 * given session.
 *
 * This module is intentionally free of Electron/IPC concerns — it is pure
 * Node and can be exercised from a standalone script (see src/e2e/).
 */

/** Options accepted by `HarnessDriver.start`. */
export interface HarnessStartOptions {
  /** Working directory the agent should operate in. */
  cwd: string
  /** Optional model override; defaults to the harness's own default. */
  model?: string
  /** Optional system prompt append/override, passed through verbatim. */
  systemPrompt?: string
  /** Restrict the built-in tool set available to the agent. */
  allowedTools?: string[]
  /**
   * Environment variables for the underlying process/client. When omitted,
   * the harness inherits `process.env` as-is (this is how auth — e.g.
   * `ANTHROPIC_BASE_URL` — flows through without any credential handling
   * in Gardenia itself).
   */
  env?: NodeJS.ProcessEnv
}

/** A single todo item as reported by the agent's planning tool. */
export interface HarnessTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
  activeForm?: string
}

/**
 * Normalized event stream emitted by every harness implementation.
 * Discriminated on `type` so consumers can `switch` exhaustively.
 */
export type HarnessEvent =
  | {
      type: 'session_started'
      sessionId: string
      timestamp: string
      model: string
      cwd: string
      /** How the underlying client resolved credentials (for auth-inheritance verification). */
      apiKeySource?: string
    }
  | {
      type: 'text_delta'
      sessionId: string
      timestamp: string
      text: string
    }
  | {
      type: 'tool_call_start'
      sessionId: string
      timestamp: string
      toolUseId: string
      name: string
      input: unknown
    }
  | {
      type: 'tool_call_end'
      sessionId: string
      timestamp: string
      toolUseId: string
      isError: boolean
      output: unknown
    }
  | {
      type: 'todo_update'
      sessionId: string
      timestamp: string
      todos: HarnessTodoItem[]
    }
  | {
      type: 'result'
      sessionId: string
      timestamp: string
      isError: boolean
      subtype: string
      result?: string
      numTurns: number
      durationMs: number
      totalCostUsd: number
      usage: unknown
    }
  | {
      type: 'interrupted'
      sessionId: string
      timestamp: string
    }
  | {
      type: 'error'
      sessionId: string
      timestamp: string
      message: string
    }

/** A running (or just-started) agent turn: its id plus its event stream. */
export interface HarnessSession {
  sessionId: string
  events: AsyncGenerator<HarnessEvent, void, void>
}

/**
 * Driver interface every harness implementation must satisfy. Mirrors the
 * shape of Playground's harness-registry.ts at a higher level of
 * abstraction: this project does not spawn/manage a tmux pane, it wraps a
 * programmatic SDK client directly, so there is no `buildLaunchCommand`
 * plumbing here — just start/resume/interrupt/streamInput over a normalized
 * event stream.
 */
export interface HarnessDriver {
  /** Start a brand-new agent turn with an initial prompt. */
  start(prompt: string, opts: HarnessStartOptions): Promise<HarnessSession>

  /** Resume a previously-started session (by the harness's own session id). */
  resume(sessionId: string, opts?: Partial<HarnessStartOptions>): Promise<HarnessSession>

  /** Abort an in-flight session. Resolves once the abort has been sent. */
  interrupt(sessionId: string): Promise<void>

  /**
   * Push an additional user message into a still-open, streaming-input
   * session (e.g. mid-turn steering). No-op if the session has already
   * ended.
   */
  streamInput(sessionId: string, message: string): Promise<void>
}
