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

import type { PermissionModeValue } from '../../shared/session-types'

/**
 * A remote host to execute the agent process on, added in 02-session-lifecycle
 * for devpod/SSH sessions. `cwd` on `HarnessStartOptions` is interpreted as a
 * path on this host (not the local machine) when `host` is set.
 */
export interface RemoteHost {
  /** SSH destination, e.g. "qingqin-go.devpod-us-or" (a plain `ssh <host>`-resolvable name). */
  sshHost: string
  /** Absolute path to the `claude` executable on the remote host. Defaults to "claude" (resolved via the remote shell's PATH). */
  remoteExecutablePath?: string
}

/** Options accepted by `HarnessDriver.start`. */
export interface HarnessStartOptions {
  /** Working directory the agent should operate in (on `host`, if set — otherwise local). */
  cwd: string
  /** Minion task creation options (MinionHarness only). */
  minion?: import('../../shared/session-types').MinionCreateOptions
  /** Optional model override; defaults to the harness's own default. */
  model?: string
  /**
   * Optional reasoning-effort override (10f-enrichment-model-effort-picker),
   * passed straight through to the SDK's own `Options.effort` field —
   * verified live against the installed `@anthropic-ai/claude-agent-sdk`
   * 0.3.212's `sdk.d.ts`: `effort?: EffortLevel` where `EffortLevel = 'low'
   * | 'medium' | 'high' | 'xhigh' | 'max'`. Like `model` above, this is only
   * read by the SDK at `query()` construction time (i.e. this driver's
   * `start()`/`resume()`) — there is no way to change it on an already-open
   * streaming-input session, so a caller that wants a new effort level to
   * take effect must tear down and reconnect (see `SessionManager.
   * sendUserMessage`'s forced-reconnect-on-change logic).
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Optional system prompt append/override, passed through verbatim. */
  systemPrompt?: string
  /**
   * Extra instructions appended to Claude Code's own default system prompt
   * (the SDK's `systemPrompt: { type: 'preset', preset: 'claude_code', append }`
   * shape). Distinct from `systemPrompt` above, which REPLACES the preset
   * outright — this keeps the stock prompt and its dynamic sections intact.
   * Ignored when `systemPrompt` is set, since the two are mutually exclusive
   * in the SDK's own option. Used for worktree sessions (see
   * `worktreeSystemPromptAppend`).
   */
  appendSystemPrompt?: string
  /** Restrict the built-in tool set available to the agent. */
  allowedTools?: string[]
  /**
   * Environment variables for the underlying process/client. When omitted,
   * the harness inherits `process.env` as-is (this is how auth — e.g.
   * `ANTHROPIC_BASE_URL` — flows through without any credential handling
   * in Atelier itself). Ignored for remote sessions (the remote host's own
   * `claude` settings supply its auth).
   */
  env?: NodeJS.ProcessEnv
  /**
   * When set, the agent process runs on this remote host over SSH instead of
   * locally. Minimal, backward-compatible addition — omitted entirely for
   * existing local-only callers.
   */
  host?: RemoteHost
  /**
   * CLI conversation id for `startWithId` when it should differ from Atelier's
   * session row id (`/clear` after disconnect). Omitted: use `sessionId`.
   */
  cliSessionId?: string
  /**
   * CLI conversation id to `--resume` when it should differ from Atelier's
   * session row id (`SDKConversationResetMessage.new_conversation_id`).
   */
  resumeSessionId?: string
  /**
   * When true, the returned session's event generator stays open past its
   * first turn's `result` — waiting on further `streamInput()` calls into
   * the SAME connection/subprocess (see `ClaudeAgentSdkHarness.normalize()`)
   * — instead of completing right after that `result`, which is the
   * default (and was the ONLY behavior before 04-composer-core). Only
   * `SessionManager`'s real interactive chat sessions (create/reconnect/
   * follow-up) set this; one-shot internal calls like the auto-naming
   * summarizer must NOT set it — a one-shot caller's `for await (const
   * event of session.events)` never pushes further input and never
   * interrupts, so without this defaulting to `false` its loop would just
   * hang forever after the single `result` it's waiting for (this was a
   * real bug caught here during this task: the initial version of this fix
   * made EVERY session — including the auto-namer's — stay open
   * indefinitely, hanging `maybeAutoName()` forever on a live run).
   */
  keepAlive?: boolean
  /**
   * SDK permission mode (05-interactive-prompts; widened to 4 values in
   * 11-composer-mode-indicator). `'plan'` starts the session in the SDK's
   * own plan mode: Claude explores/plans without auto-approved file edits
   * until a proposed plan (`ExitPlanMode`) is accepted via the plan card.
   * `'acceptEdits'`/`'auto'` are reachable only via the composer's Shift+Tab
   * cycle (see `ClaudeAgentSdkHarness.setPermissionMode`), never as a
   * `session:create` starting option. Omitted entirely preserves the
   * existing `'default'` behavior for every caller that predates this task.
   */
  permissionMode?: PermissionModeValue
}

/**
 * A file attached to a user message — image, PDF, or plain text.
 * - Images (image/*): `data` is raw base64, sent as an image content block.
 * - PDFs (application/pdf): `data` is raw base64, sent as a document block with Base64PDFSource.
 * - Plain text (text/plain): `data` is raw UTF-8 text (not base64), sent as a document block
 *   with PlainTextSource.
 * All MIME types verified against the installed SDK's ContentBlockParam union.
 */
export interface HarnessFileInput {
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'application/pdf' | 'text/plain'
  data: string
  name?: string
}

/** @deprecated Use HarnessFileInput. Kept for any call sites not yet migrated. */
export type HarnessImageInput = HarnessFileInput

/** A single todo item as reported by the agent's planning tool. */
export interface HarnessTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
  activeForm?: string
}

/**
 * One slash command the SDK reports as actually available for a session
 * (bug #56). Field-for-field mirror of the installed
 * `@anthropic-ai/claude-agent-sdk`'s own `SlashCommand` type (verified
 * against `sdk.d.ts:6495`: `{ name, description, argumentHint, aliases? }`).
 */
export interface HarnessSlashCommand {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
}

/** One model row from `query.initializationResult().models` (sdk.d.ts ModelInfo). */
export interface HarnessModelInfo {
  value: string
  displayName: string
  description: string
  resolvedModel?: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
}

/**
 * Interactive-prompt types (05-interactive-prompts). All three interaction
 * kinds below — permission prompts, `AskUserQuestion`, and plan-mode's
 * `ExitPlanMode` — are, per the real `@anthropic-ai/claude-agent-sdk`
 * (verified live against v0.3.212, not guessed), all routed through the same
 * `canUseTool` callback passed into `query({ options: { canUseTool } })`:
 * there is no separate SDK channel for them. `onUserDialog` /
 * `request_user_dialog` (also present in the SDK's types) was never invoked
 * in any live run that triggered these three flows — it exists for other
 * dialog kinds (e.g. `refusal_fallback_prompt`), not these.
 */

/** One option in an `AskUserQuestion` question, verbatim from the SDK's own `AskUserQuestionInput` shape. */
export interface HarnessAskQuestionOption {
  label: string
  description: string
}

/** One question in an `AskUserQuestion` tool call. */
export interface HarnessAskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: HarnessAskQuestionOption[]
}

/**
 * The response a UI sends back after a `permission_request` /
 * `ask_user_question` / `plan_proposed` prompt is resolved by the user,
 * routed back into the harness's pending `canUseTool` call via
 * `HarnessDriver.respondToPrompt`.
 */
export type PromptResponse =
  | { kind: 'permission'; decision: 'allow' | 'deny'; alwaysAllow?: boolean }
  | { kind: 'ask_user_question'; answers: Record<string, string>; freeText?: string }
  | { kind: 'ask_user_question'; cancelled: true }
  | { kind: 'plan'; decision: 'accept' | 'reject' | 'keep_planning'; feedback?: string }

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
      parentToolUseId?: string | null
    }
  | {
      type: 'thinking_block_start'
      sessionId: string
      timestamp: string
      parentToolUseId: string | null
    }
  | {
      type: 'thinking_delta'
      sessionId: string
      timestamp: string
      text: string
      parentToolUseId: string | null
    }
  | {
      type: 'thinking_block_end'
      sessionId: string
      timestamp: string
      parentToolUseId: string | null
    }
  | {
      type: 'thinking_tokens'
      sessionId: string
      timestamp: string
      estimatedTokens: number
      estimatedTokensDelta: number
    }
  | {
      type: 'tool_input_delta'
      sessionId: string
      timestamp: string
      toolUseId: string
      partialJson: string
      parentToolUseId: string | null
    }
  | {
      type: 'tool_call_start'
      sessionId: string
      timestamp: string
      toolUseId: string
      name: string
      input: unknown
      /**
       * Id of the enclosing Task tool_use (the "parent") when this call was
       * made by a spawned subagent rather than the top-level turn; `null`
       * for top-level calls. Sourced directly from the Agent SDK's own
       * `parent_tool_use_id` field on the assistant message that carried
       * this tool_use block (verified present on `SDKAssistantMessage` in
       * the installed `@anthropic-ai/claude-agent-sdk` types) — added here
       * in 03-chat-surface-core because 01-harness-abstraction's
       * normalization dropped it.
       */
      parentToolUseId: string | null
    }
  | {
      /**
       * Live heartbeat for a long-running tool (SDK `SDKToolProgressMessage`).
       * Updates the matching in-flight tool card's elapsed timer — no new
       * transcript row.
       */
      type: 'tool_progress'
      sessionId: string
      timestamp: string
      toolUseId: string
      toolName: string
      parentToolUseId: string | null
      elapsedTimeSeconds: number
      taskId?: string
    }
  | {
      type: 'tool_call_end'
      sessionId: string
      timestamp: string
      toolUseId: string
      isError: boolean
      output: unknown
      /** See `tool_call_start.parentToolUseId`. Sourced from the same field on the SDKUserMessage carrying the tool_result. */
      parentToolUseId: string | null
    }
  | {
      type: 'todo_update'
      sessionId: string
      timestamp: string
      todos: HarnessTodoItem[]
    }
  | {
      /**
       * Context-compaction boundary. Added in 03-chat-surface-core from the
       * Agent SDK's `SDKCompactBoundaryMessage` (`type: 'system', subtype:
       * 'compact_boundary'`), which 01-harness-abstraction did not
       * normalize.
       */
      type: 'compaction'
      sessionId: string
      timestamp: string
      trigger: 'manual' | 'auto'
      preTokens: number
      postTokens?: number
    }
  | {
      type: 'result'
      sessionId: string
      timestamp: string
      isError: boolean
      subtype: string
      result?: string
      /** Populated on SDK error results (`SDKResultError.errors`). */
      errors?: string[]
      numTurns: number
      durationMs: number
      totalCostUsd: number
      usage: unknown
      /**
       * Per-model token usage for this connection (token-usage-indicator),
       * sourced from the SDK's own `SDKResultMessage.modelUsage`. Keys are
       * model ids; each value carries at minimum `inputTokens` (cumulative for
       * the whole connection, same scope as `totalCostUsd`) and `contextWindow`
       * (the model's declared context length). Undefined only if the SDK
       * message somehow omitted it.
       */
      modelUsage?: Record<string, { inputTokens: number; contextWindow: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>
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
      /** When true, the UI should offer a retry action to re-send the last user turn. */
      retryable?: true
    }
  | {
      /**
       * A tool call is blocked awaiting a user decision — sourced from a
       * live `canUseTool` invocation for a tool other than `AskUserQuestion`/
       * `ExitPlanMode` (typically `Bash`, `Write`, `Edit`, ...). `requestId`
       * is the SDK's own `toolUseID` for this call (stable, unique per tool
       * use) — pass it back unchanged to `HarnessDriver.respondToPrompt`.
       */
      type: 'permission_request'
      sessionId: string
      timestamp: string
      requestId: string
      toolUseId: string
      toolName: string
      input: unknown
      /** Full prompt sentence from the bridge, e.g. "Claude wants to run a shell command", when the SDK supplied one. */
      title?: string
      description?: string
      /**
       * Pattern from the SDK's own `addRules` suggestion (e.g. "npm test *"),
       * when offered — the basis for an "Always allow `<pattern>`" checkbox.
       * Absent when the SDK didn't suggest a re-usable rule for this call.
       */
      suggestedPattern?: string
    }
  | {
      /** The agent called `AskUserQuestion`; blocked in `canUseTool` awaiting the user's picks. */
      type: 'ask_user_question'
      sessionId: string
      timestamp: string
      requestId: string
      toolUseId: string
      questions: HarnessAskQuestion[]
    }
  | {
      /**
       * The agent called `ExitPlanMode` (plan-mode); blocked in `canUseTool`
       * awaiting accept/reject. `plan` is the markdown plan text exactly as
       * the SDK's `ExitPlanModeInput.plan` field supplied it.
       */
      type: 'plan_proposed'
      sessionId: string
      timestamp: string
      requestId: string
      toolUseId: string
      plan: string
      planFilePath?: string
    }
  | {
      /**
       * Live slash-command registry for this session (bug #56). Pushed once
       * shortly after `start()`/`resume()`, sourced from the SDK's own
       * control-protocol `query.initializationResult()` call (richer than
       * the plain `slash_commands: string[]` on the streamed `system`/`init`
       * SDKMessage — that one lacks descriptions/argumentHint/aliases
       * entirely), and again any time the SDK's own `commands_changed`
       * system message fires (e.g. new skills discovered dynamically as the
       * agent explores a subdirectory). `commands` is always the FULL
       * replacement list, never a delta — see `SDKCommandsChangedMessage`'s
       * own doc comment in `sdk.d.ts` for why a client must replace rather
       * than merge.
       */
      type: 'commands_updated'
      sessionId: string
      timestamp: string
      commands: HarnessSlashCommand[]
    }
  | {
      /** Live model registry from `query.initializationResult().models`. Full replacement list. */
      type: 'models_updated'
      sessionId: string
      timestamp: string
      models: HarnessModelInfo[]
    }
  | {
      /**
       * Predicted next user prompt (`SDKPromptSuggestionMessage`). Arrives
       * after `result` when `promptSuggestions` is enabled — not a transcript row.
       */
      type: 'prompt_suggestion'
      sessionId: string
      timestamp: string
      suggestion: string
    }
  | {
      type: 'background_tasks_changed'
      sessionId: string
      timestamp: string
      tasks: { taskId: string; taskType: string; description: string }[]
    }
  | {
      type: 'task_started'
      sessionId: string
      timestamp: string
      taskId: string
      description: string
      taskType?: string
      subagentType?: string
      workflowName?: string
      skipTranscript?: boolean
    }
  | {
      type: 'task_updated'
      sessionId: string
      timestamp: string
      taskId: string
      patch: {
        status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused'
        description?: string
        error?: string
        isBackgrounded?: boolean
      }
    }
  | {
      type: 'task_progress'
      sessionId: string
      timestamp: string
      taskId: string
      description: string
      lastToolName?: string
      summary?: string
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
    }
  | {
      type: 'task_notification'
      sessionId: string
      timestamp: string
      taskId: string
      status: 'completed' | 'failed' | 'stopped'
      summary: string
    }
  | {
      type: 'sdk_notification'
      sessionId: string
      timestamp: string
      key: string
      text: string
      priority: 'low' | 'medium' | 'high' | 'immediate'
    }
  | {
      type: 'permission_denied'
      sessionId: string
      timestamp: string
      toolUseId: string
      toolName: string
      message: string
    }
  | {
      type: 'model_refusal_fallback'
      sessionId: string
      timestamp: string
      fallbackModel: string
      content: string
    }
  | {
      type: 'model_refusal_no_fallback'
      sessionId: string
      timestamp: string
      content: string
    }
  | {
      type: 'sdk_status'
      sessionId: string
      timestamp: string
      status: 'compacting' | 'requesting' | 'minion_setup' | null
      permissionMode?: string
      compactResult?: 'success' | 'failed'
      compactError?: string
      /** Minion SETUP card — same transcript slot as Cortana requesting/compacting. */
      title?: string
      detail?: string
      setupSteps?: Array<{
        id: 'provision' | 'boot' | 'connect'
        label: string
        state: 'done' | 'active' | 'pending'
      }>
    }
  | {
      type: 'api_retry'
      sessionId: string
      timestamp: string
      attempt: number
      maxRetries: number
    }
  | {
      type: 'rate_limit_event'
      sessionId: string
      timestamp: string
      status: 'allowed' | 'allowed_warning' | 'rejected'
      resetsAt?: number
      utilization?: number
    }
  | {
      type: 'local_command_output'
      sessionId: string
      timestamp: string
      content: string
    }
  | {
      type: 'auth_status'
      sessionId: string
      timestamp: string
      isAuthenticating: boolean
      error?: string
      output: string[]
    }
  | {
      type: 'hook_started'
      sessionId: string
      timestamp: string
      hookName: string
      hookEvent: string
    }
  | {
      type: 'hook_progress'
      sessionId: string
      timestamp: string
      hookName: string
      hookEvent: string
      line: string
    }
  | {
      type: 'hook_response'
      sessionId: string
      timestamp: string
      hookName: string
      hookEvent: string
      outcome: 'success' | 'error' | 'cancelled'
      exitCode?: number
    }
  | {
      type: 'conversation_reset'
      sessionId: string
      timestamp: string
      newConversationId: string
    }
  | {
      type: 'worker_shutting_down'
      sessionId: string
      timestamp: string
      agentId?: string
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

  /**
   * Starts a brand-new agent turn like `start()`, but reuses a SPECIFIC,
   * caller-supplied session id instead of generating one internally
   * (fix-no-conversation-found-remote-resume). Passes the SDK the same
   * `sessionId` option `start()` uses (never `resume`) — this is a genuinely
   * fresh conversation as far as the underlying CLI is concerned, just one
   * whose id Atelier already fixed in its own SQLite row (e.g. reopening a
   * session that was closed/interrupted before it ever completed a real
   * turn, so the CLI never actually recorded a conversation for it — calling
   * `resume()` for that id fails with "No conversation found"). See
   * `SessionRecord.everConnected`.
   */
  startWithId(sessionId: string, prompt: string, opts: HarnessStartOptions): Promise<HarnessSession>

  /** Resume a previously-started session (by the harness's own session id). */
  resume(sessionId: string, opts?: Partial<HarnessStartOptions>): Promise<HarnessSession>

  /** Abort an in-flight session. Resolves once the abort has been sent. */
  interrupt(sessionId: string): Promise<void>

  /**
   * Validates a `/model <id>` against the SDK's own live acceptance logic
   * (calls `Query.setModel()` on the connected session and reports whether
   * it threw) — `{ ok: false, error: 'not connected' }` if the session
   * isn't connected yet. See `ClaudeAgentSdkHarness.validateModel`'s doc
   * comment for why this, not a static list, is the only reliable check.
   */
  validateModel(sessionId: string, model: string): Promise<{ ok: true } | { ok: false; error: string }>

  /** Live SDK validation for Settings → default model (probe session). */
  validateClaudeModel(model: string): Promise<{ ok: true } | { ok: false; error: string }>

  /**
   * Push an additional user message into a still-open, streaming-input
   * session (e.g. mid-turn steering). No-op if the session has already
   * ended. `image`, when present (10g-enrichment-image-attachment), turns
   * the message's `content` into a real multi-block array (an optional text
   * block followed by an image block) instead of a plain string — see
   * `ClaudeAgentSdkHarness`'s `userMessage()` for the exact block shapes,
   * verified against the installed SDK's types.
   */
  streamInput(sessionId: string, message: string, attachments?: HarnessFileInput[]): Promise<void>

  /**
   * True while `sessionId` still has a live, streaming-input query open
   * (i.e. its `start`/`resume` event generator hasn't returned yet) — added
   * in 04-composer-core so callers can tell a genuinely-live session (safe
   * to `streamInput()` directly, injecting into the SAME open
   * `AsyncIterable`/subprocess with no reconnect) apart from one that has
   * already ended (generator returned after an `interrupted`/fatal `error`,
   * or the process was never started this run) and therefore needs a fresh
   * `resume()` first. See `ClaudeAgentSdkHarness.normalize()`: with the fix
   * in this task, the generator no longer returns after every turn's
   * `result` — only when interrupted or on a fatal error — so a session
   * that's simply idle between turns (connected, no error) is still
   * "active" here and never needs a reconnect for its next follow-up
   * message either.
   */
  isActive(sessionId: string): boolean

  /**
   * Optional (Cortana): after resume, if the gateway finished while Atelier was
   * dead and the local transcript still ends on a user message, emit that
   * assistant reply so the UI is not stuck pending with no text.
   */
  syncCompletedTurn?(sessionId: string): Promise<void>

  /**
   * Returns the current context window usage for a live session via the SDK's
   * own `getContextUsage()` query — call this after a `result` event to get
   * `totalTokens` (all in-context categories summed) and `contextWindow`
   * (effective usable window — SDK `maxTokens`). Returns `null` if the session is not live.
   */
  getContextUsage(sessionId: string): Promise<{ totalTokens: number; contextWindow: number } | null>

  /**
   * Resolves a pending `permission_request` / `ask_user_question` /
   * `plan_proposed` prompt, unblocking the `canUseTool` call that emitted it
   * (05-interactive-prompts). No-op if `requestId` is unknown or already
   * resolved (e.g. a stale double-click).
   */
  respondToPrompt(sessionId: string, requestId: string, response: PromptResponse): Promise<void>

  /**
   * Flips a LIVE session's SDK permission mode immediately
   * (11-composer-mode-indicator), via the same `query.setPermissionMode()`
   * call already used after an accepted `ExitPlanMode` (see
   * `ClaudeAgentSdkHarness`'s `canUseTool` handler). No-op (resolves without
   * effect) if `sessionId` has no live connection right now — the caller
   * (`SessionManager.cycleMode`) is responsible for also updating its own
   * tracked mode so the NEXT `start()`/`resume()` call re-passes it, exactly
   * like the pre-existing plan-mode tracking.
   */
  setPermissionMode(sessionId: string, mode: PermissionModeValue): Promise<void>

  /**
   * Optional: return uploaded artifacts for a session (e.g. Cortana file uploads).
   * Used by SessionManager to populate the workspace diff panel after each turn.
   */
  listFiles?(sessionId: string): Promise<Array<{ name: string; url: string }>>
}
