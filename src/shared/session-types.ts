/**
 * Shared session/message types (02-session-lifecycle). Used by main (DB rows,
 * IPC payloads) and renderer (state, UI) alike — kept free of
 * Electron/Node/better-sqlite3 types so it can be imported from either side.
 */

export type SessionMode = 'terminal' | 'claude-code'

/**
 * SDK permission-mode values Gardenia exposes to the user (11-composer-mode-
 * indicator). Deliberately a SUBSET of the real SDK's own `PermissionMode`
 * (verified against the installed `@anthropic-ai/claude-agent-sdk@0.3.212`'s
 * `sdk.d.ts`: `'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' |
 * 'dontAsk' | 'auto'`) — `bypassPermissions`/`dontAsk` are out of scope per
 * spec.md's scope decision and are never surfaced by the composer's cycle.
 * Single source of truth for both the main process (`HarnessStartOptions.
 * permissionMode`, `SessionManager`'s tracked map) and the renderer (the
 * composer's mode pill) — this file is imported by both.
 */
export type PermissionModeValue = 'default' | 'plan' | 'acceptEdits' | 'auto'

export interface SessionRecord {
  id: string
  name: string
  nameLockedByUser: boolean
  projectPath: string
  mode: SessionMode
  /** null for local sessions; the devpod/SSH host name for remote ones. */
  hostname: string | null
  /** References SessionGroupRecord.id (06-session-organization), or null (ungrouped). */
  groupId: string | null
  pinned: boolean
  color: string | null
  createdAt: string
  closedAt: string | null
  /** Free-form tags (06-session-organization), stored in the session_tags join table. */
  tags: string[]
  /** Freeform per-session note shown in a detail popover (06-session-organization). */
  notes: string | null
  /** Manual drag-drop position within its section (pinned / a group / ungrouped) — lower sorts first. */
  sortOrder: number
  /**
   * Running total dollar cost for this session (10a-enrichment-cost-tracking),
   * accumulated from every harness `result` event's real `totalCostUsd`
   * (sourced directly from the SDK — never independently computed from token
   * counts). Persisted in SQLite so it survives relaunch. `0` until the
   * session's first turn completes.
   */
  totalCostUsd: number
  /**
   * Current SDK permission mode for this session (11-composer-mode-indicator),
   * decorated onto the DB row at read time by `SessionManager` (not itself a
   * DB column — same "tracked in-memory, re-passed on every resume/follow-up"
   * mechanism as the pre-existing plan-mode tracking this generalizes, see
   * `SessionManager.permissionModes`). Always `'default'` for a session that
   * was never started in plan mode and has never had its mode cycled.
   */
  permissionMode: PermissionModeValue
}

/** A named, collapsible, reorderable session group (06-session-organization). */
export interface SessionGroupRecord {
  id: string
  name: string
  sortOrder: number
  collapsed: boolean
  createdAt: string
}

/**
 * Concurrent per-session status (06-session-organization), tracked for EVERY
 * session at once (not just the active one) — see SessionManager's `live`
 * map and `getStatus`.
 *
 * Definitions (documented in Features/06-session-organization/progress.md):
 *  - 'working': a claude-code session with a turn actively in flight (from
 *    the moment a prompt is sent/streamed until its terminal result/error/
 *    interrupted event).
 *  - 'waiting': a claude-code session that has an open live connection this
 *    app run, isn't currently mid-turn, and whose most recent message is
 *    NOT a user message — i.e. the agent finished a turn and is waiting on
 *    the user's next instruction ("waiting for input").
 *  - 'idle': a claude-code session with no open live connection this app
 *    run (never opened, or its most recent message IS a user message with
 *    no live turn yet observed).
 *  - 'disconnected': terminal-mode sessions (no harness at all) and closed
 *    sessions.
 *  - 'connecting': a claude-code session between triggering a resume
 *    (`SessionManager.reconnect()` starting) and the live harness connection
 *    actually being (re)established — see 'connecting'-pill in the topbar
 *    (fix-session-resume-stale-sigterm-and-no-connect-indicator).
 */
export type SessionStatus = 'working' | 'waiting' | 'idle' | 'disconnected' | 'connecting'

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
}

export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * An image dropped/pasted into the composer (10g-enrichment-image-attachment),
 * passed over IPC alongside the typed text on `session:sendMessage`.
 * `mimeType` is restricted to what the Anthropic Messages API's image content
 * block actually accepts (see `HarnessImageInput` in
 * `main/harness/types.ts`, verified against the installed SDK's types) —
 * anything else read off a dropped/pasted file is rejected before it ever
 * reaches IPC (see Composer's file-handling).
 */
export interface ImageAttachment {
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  /** Raw base64 (no `data:...;base64,` prefix). */
  data: string
}

export interface MessageRecord {
  id: number
  sessionId: string
  role: MessageRole
  /** Normalized display content (plain text, tool summaries, etc). */
  content: string
  /** The raw HarnessEvent (or null for synthetic rows) that produced this message, for replay/debug. */
  rawEvent: unknown
  createdAt: string
}

/** Options accepted by session:create. */
export interface CreateSessionOptions {
  projectPath: string
  mode: SessionMode
  /** Optional initial prompt (Claude Code mode only). */
  prompt?: string
  /** Remote host id (matches RemoteHostOption.id), or 'local'. */
  hostId: string
  groupId?: string | null
  /** Start the session in the SDK's plan permission mode (05-interactive-prompts): Claude explores/plans without editing files until a proposed plan is accepted via the plan card. */
  planMode?: boolean
}

/**
 * Reasoning-effort levels accepted by the SDK's own `effort` option
 * (10f-enrichment-model-effort-picker). Mirrored here — rather than importing
 * `@anthropic-ai/claude-agent-sdk`'s own `EffortLevel` type — because
 * `shared/` is imported by the renderer bundle, which cannot pull in the
 * (Node/ESM-only) SDK package at all. Verified against the installed
 * `@anthropic-ai/claude-agent-sdk@0.3.212`'s `sdk.d.ts`:
 * `export declare type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';`
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Per-turn model/effort override (10f-enrichment-model-effort-picker), sent
 * alongside a follow-up message via `session:sendMessage`. Both fields are
 * independently optional; `undefined` on either means "leave whatever this
 * session is already using for that field unchanged". Only takes effect for
 * the turn(s) sent AFTER the override is applied — never the turn already in
 * flight, since the underlying SDK only reads `model`/`effort` at its own
 * `start()`/`resume()` call time (see `HarnessStartOptions`), not mid-turn.
 */
export interface ModelSelection {
  model?: string
  effort?: EffortLevel
}

/**
 * One cross-session content match (10b-enrichment-full-text-search), from
 * `SessionStore.searchMessages`'s SQLite FTS5 query over `messages_fts`.
 * Surfaced in the command palette's "Session" results alongside plain
 * session-name matches; selecting one opens `sessionId` and scrolls/jumps to
 * `messageId` in its transcript.
 */
export interface MessageSearchHit {
  sessionId: string
  sessionName: string
  messageId: number
  /** FTS5 `snippet()` output around the match, with `…` markers around each matched term (see CommandPalette's rendering). */
  snippet: string
  createdAt: string
}

export interface RemoteHostOption {
  id: string
  /** SSH host / devpod name, e.g. "qingqin-go.devpod-us-or". */
  sshHost: string
  label: string
  status: 'running' | 'sleeping' | 'unknown'
  /**
   * Absolute path to the `claude` executable on the remote host. Required:
   * non-interactive `ssh host -- claude ...` does not source the user's
   * shell profile, so `~/.local/bin` (where aifx-provisioned `claude` is
   * symlinked) is not on PATH even though it works fine in an interactive
   * login shell. Verified directly against qingqin-go.devpod-us-or.
   */
  remoteExecutablePath?: string
}

/** Event forwarded from main -> renderer over IPC as a session streams. */
export interface SessionStreamEvent {
  sessionId: string
  message: MessageRecord
}

/**
 * Token-level assistant text push (03-chat-surface-core). Fired on every
 * `text_delta` for the in-progress assistant message identified by
 * `messageId` (already created, empty, via a `session:message` push) —
 * purely a live-render signal, never itself persisted; the final content is
 * committed to SQLite and re-pushed as an ordinary `session:message` once
 * the turn's text segment ends.
 */
export interface SessionStreamDeltaEvent {
  sessionId: string
  messageId: number
  /** Cumulative text so far for this message (not just the incremental delta) — simplest for the renderer to apply directly. */
  text: string
}

/** Lifecycle notifications forwarded from main -> renderer for sidebar refresh + e2e log grepping. */
export type SessionLifecycleEvent =
  | { type: 'session.created'; session: SessionRecord }
  | { type: 'session.renamed'; session: SessionRecord }
  | { type: 'session.closed'; session: SessionRecord }
  | { type: 'session.resumed'; session: SessionRecord }
  | { type: 'session.forked'; session: SessionRecord; sourceId: string }
  | { type: 'session.deleted'; sessionId: string }
  | { type: 'session.updated'; session: SessionRecord }

/** Group-management notifications (06-session-organization), analogous to SessionLifecycleEvent. */
export type SessionGroupEvent =
  | { type: 'group.created'; group: SessionGroupRecord }
  | { type: 'group.renamed'; group: SessionGroupRecord }
  | { type: 'group.deleted'; groupId: string }
  | { type: 'group.reordered'; groups: SessionGroupRecord[] }
  | { type: 'group.updated'; group: SessionGroupRecord }

/**
 * Composer Send/Stop toggle state (04-composer-core). `busy: true` from the
 * moment a turn starts (initial prompt, a follow-up, or a message streamed
 * live into an already-in-flight turn) until its terminal harness event
 * (`result` / `interrupted` / `error`) lands — see
 * `SessionManager.sendTurnState`.
 */
export interface SessionTurnStateEvent {
  sessionId: string
  busy: boolean
}

/**
 * The renderer's answer to a `permission_request` / `ask_user_question` /
 * `plan_proposed` card (05-interactive-prompts), sent over
 * `session:respondToPrompt`. Mirrors (but is decoupled from) the harness's
 * own `PromptResponse` — kept as a separate shared type since preload/
 * renderer must not import `main/harness/types.ts`.
 */
export type PromptDecision =
  | { kind: 'permission'; decision: 'allow' | 'deny'; alwaysAllow?: boolean }
  | { kind: 'ask_user_question'; answers: Record<string, string>; freeText?: string }
  | { kind: 'plan'; decision: 'accept' | 'reject' | 'keep_planning'; feedback?: string }

/**
 * One slash command the SDK reports as actually available for a session
 * (bug #56 — the live command registry). Field-for-field mirror of
 * `@anthropic-ai/claude-agent-sdk`'s own `SlashCommand` type (verified
 * against the installed `sdk.d.ts:6495`: `{ name, description,
 * argumentHint, aliases? }`), redeclared here — rather than imported —
 * since `shared/` is loaded by the renderer bundle, which cannot pull in
 * the (Node/ESM-only) SDK package at all (see `EffortLevel`'s doc comment
 * above for the same reasoning).
 */
export interface SlashCommandInfo {
  name: string
  description: string
  argumentHint?: string
  aliases?: string[]
}

/**
 * Live slash-command list push (bug #56), forwarded main -> renderer
 * whenever the harness's real command registry for a session is known or
 * changes: once shortly after session start/resume (from the SDK's
 * `query.initializationResult()`, i.e. `SDKControlInitializeResponse.commands`
 * — sdk.d.ts:3394/3398) and again any time the SDK pushes a
 * `commands_changed` system message mid-session (`SDKCommandsChangedMessage`,
 * sdk.d.ts:2880 — e.g. new skills discovered as the agent explores a
 * subdirectory). `commands` is the FULL replacement list each time, per
 * that type's own doc comment ("`supportedCommands()` is captured once at
 * initialize and never reflects mid-session changes, so a client re-fetch
 * would return the stale init list") — consumers should replace their
 * cached list, never merge into it.
 */
export interface SessionCommandsEvent {
  sessionId: string
  commands: SlashCommandInfo[]
}
