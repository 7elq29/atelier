import { APP_DISPLAY_NAME } from './app-brand'

/**
 * Shared session/message types (02-session-lifecycle). Used by main (DB rows,
 * IPC payloads) and renderer (state, UI) alike — kept free of
 * Electron/Node/better-sqlite3 types so it can be imported from either side.
 */

export type SessionMode = 'terminal' | 'claude-code' | 'cortana' | 'minion'

/** Repos a Uber Minion task can target. */
export type MinionRepo = 'go-code' | 'java-code' | 'android-code' | 'web-code' | 'ios-code' | 'uber-one' | 'ml-code'

export interface MinionCreateOptions {
  repo: MinionRepo
  runner?: 'devpod' | 'buildkite'
  /**
   * Attach to an existing Minion task instead of createtask.
   * Prefer a parsed UUID from `parseMinionTaskId` (link or bare id).
   */
  attachTaskId?: string
}

const MINION_TASK_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MINION_TASK_UUID_CAPTURE_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/**
 * Accepts a bare task UUID or a Minion web link
 * (`https://minion.uberinternal.com/v2?taskId=…`, path `/…/<uuid>`, etc.).
 */
export function parseMinionTaskId(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  if (MINION_TASK_UUID_RE.test(raw)) return raw.toLowerCase()
  try {
    const u = new URL(raw)
    for (const key of ['taskId', 'task_id', 'id']) {
      const fromQuery = u.searchParams.get(key)
      if (fromQuery && MINION_TASK_UUID_RE.test(fromQuery)) return fromQuery.toLowerCase()
    }
    for (const part of u.pathname.split('/')) {
      if (MINION_TASK_UUID_RE.test(part)) return part.toLowerCase()
    }
  } catch {
    /* not a URL */
  }
  const labeled = raw.match(/taskId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  if (labeled && MINION_TASK_UUID_RE.test(labeled[1])) return labeled[1].toLowerCase()
  const embedded = raw.match(MINION_TASK_UUID_CAPTURE_RE)
  if (embedded && MINION_TASK_UUID_RE.test(embedded[1])) return embedded[1].toLowerCase()
  return null
}

/**
 * The workspace tabs a claude-code session can be parked on
 * (07-secondary-panels). Lives here rather than next to `TabBar` because the
 * last-used tab is a persisted session column read by main and renderer alike.
 */
export const SESSION_TABS = ['chat', 'diff', 'files', 'terminal', 'ports'] as const

export type SessionTab = (typeof SESSION_TABS)[number]

/**
 * Narrows an arbitrary persisted `active_tab` value to a tab this session can
 * actually show: unknown strings fall back to chat, and so does `'ports'` for
 * a local session, whose strip has no Ports tab to restore onto.
 */
export function restorableSessionTab(tab: string | null | undefined, hostname: string | null): SessionTab {
  if (!tab || !(SESSION_TABS as readonly string[]).includes(tab)) return 'chat'
  if (tab === 'ports' && !hostname) return 'chat'
  return tab as SessionTab
}

/** System transcript copy shown once after a mid-turn app close/quit (fix-app-quit-interrupted-turn-notice). */
export const TURN_INTERRUPTED_NOTICE = `The previous turn was stopped because ${APP_DISPLAY_NAME} closed while the assistant was still working. You can continue from the transcript below.`

/**
 * SDK permission-mode values Atelier exposes to the user (11-composer-mode-
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
  /**
   * Set as soon as the user requests permanent deletion. While non-null the
   * sidebar keeps this row visible but disabled until filesystem/worktree
   * cleanup finishes and the database row is purged.
   */
  deletedAt: string | null
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
  /**
   * Whether the underlying harness/CLI backend has EVER actually confirmed a
   * real conversation for this session id (fix-no-conversation-found-remote-
   * resume) — true once its `session_started` harness event (the SDK's own
   * `system`/`init` handshake) has fired at least once, persisted so it
   * survives relaunch. A session can have an open, `isActive()` harness
   * connection (e.g. right after creation with no initial prompt) while this
   * is still `false` — the CLI doesn't emit its init handshake until it
   * actually receives a first real turn. `SessionManager` uses this to
   * decide whether a reconnect must go through `harness.startWithId()`
   * (fresh, safe for a session the CLI has never heard of) instead of
   * `harness.resume()` (a `--resume <id>` reconnect, which the CLI rejects
   * with "No conversation found" for a session id it never actually started).
   */
  everConnected: boolean
  /**
   * Persisted model/effort override for this session (restore-mode-and-model-
   * on-resume), stored in SQLite and restored when the session is resumed
   * after an app relaunch. Null for sessions that were never sent a message
   * with an explicit model override (they use the app default). Decorated
   * onto the DB row at read time by `SessionManager.decorate()`, which
   * overlays the in-memory `modelSelections` Map value (if present) first —
   * same "in-memory wins, DB is the persistent fallback" pattern as
   * `permissionMode`.
   */
  modelSelection: ModelSelection | null
  /**
   * Absolute path to the session's isolated git worktree (use-worktree), or
   * null if this session was not created with the "Use worktree" toggle. When
   * set, Claude Code runs inside this worktree path instead of the original
   * projectPath. The worktree and its branch are removed when the session is
   * deleted.
   */
  worktreePath: string | null
  /** Saved session profile id from New Session, or null for a plain project path. */
  profileId: string | null
  /**
   * ISO timestamp of the last time the user actively used this session
   * (session-startup-idle): updated on select, send, reconnect, and create.
   * Used to skip auto harness reconnect on relaunch when older than 1 hour.
   */
  lastActiveAt: string
  /**
   * Workspace tab the user was last on in this session (remember-session-tab),
   * persisted so switching away and back — or relaunching the app — returns to
   * Files/Diff/Terminal instead of snapping to Chat. `'chat'` for sessions the
   * user has never moved off the default tab.
   */
  activeTab: SessionTab
  /** Obsidian daily-note task gid linked via todo-session-link. */
  linkedDailyTaskGid: string | null
  /** Date (YYYY-MM-DD) of the note containing `linkedDailyTaskGid`. */
  linkedDailyNoteDate: string | null
}

/** Fired after a harness reconnect finishes handshaking — renderer preloads secondary panels. */
export interface SessionReconnectCompleteEvent {
  sessionId: string
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
 *  - 'startup-idle': an open claude-code session deliberately left
 *    disconnected on app launch because its persisted last-active time is
 *    more than 1 hour ago — only affects auto reconnect on restart; the user
 *    must click Reconnect to restore Claude and secondary panels.
 *  - 'disconnected': terminal-mode sessions (no harness at all) and closed
 *    sessions.
 *  - 'connecting': a claude-code session between triggering a resume
 *    (`SessionManager.reconnect()` starting) and the live harness connection
 *    actually being (re)established — see 'connecting'-pill in the topbar
 *    (fix-session-resume-stale-sigterm-and-no-connect-indicator).
 */
export type SessionStatus =
  | 'working'
  | 'waiting'
  | 'idle'
  | 'startup-idle'
  | 'disconnected'
  | 'connecting'
  | 'creating-worktree'
  | 'cleaning-up'

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
}

export interface SessionStaleEvent {
  sessionId: string
  stale: boolean
}

export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * MIME types accepted for file attachments in the composer.
 * Images are sent as image content blocks; PDFs as base64 document blocks;
 * text/plain as plain-text document blocks (data = raw UTF-8, not base64).
 */
export type FileAttachmentMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'application/pdf'
  | 'text/plain'

/** A file (image, PDF, or text) attached to a user message. */
export interface FileAttachment {
  mimeType: FileAttachmentMimeType
  /** Base64 for images/PDFs; raw UTF-8 text for text/plain. */
  data: string
  /** Original filename, used for display only. */
  name?: string
}

/**
 * Kept for backward-compat: existing transcript rows store single-image
 * messages as `{ kind: 'image_attachment', ... }`. New messages with any
 * attachments use `FilesAttachmentContent` instead.
 */
export interface ImageAttachment {
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  /** Raw base64 (no `data:...;base64,` prefix). */
  data: string
}

/**
 * Result of `session:validateModel` — calls the SDK's own `Query.setModel()`
 * on the connected session and reports whether it threw, used to validate a
 * typed `/model <id>` against the SDK's real acceptance logic (no static
 * list can substitute — see `ClaudeAgentSdkHarness.validateModel`'s doc
 * comment for why).
 */
export type ModelValidationResult = { ok: true } | { ok: false; error: string }

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
  /** Create an isolated git worktree for this session (use-worktree). Only meaningful for local claude-code sessions. */
  useWorktree?: boolean
  /** Override the default derived session name (e.g. quick local terminal rows). */
  suggestedName?: string
  /** Saved session profile id — cwd comes from the profile workspace. */
  profileId?: string
  /** Minion task options (mode === 'minion'). */
  minion?: MinionCreateOptions
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

/** Result of stopping an in-flight turn — either fully withdrawn (pre-execution) or interrupted mid-run. */
export type SessionInterruptResult =
  | { action: 'withdrawn'; restoredText: string }
  | { action: 'interrupted' }

/** A user message held in the main-process turn queue, waiting for the current SDK turn to complete. */
export interface PendingQueuedMessage {
  /** UUID for cancellation via `session:cancelQueued`. */
  id: string
  /** Display text shown in the queued-strip UI. */
  text: string
}

/** Pushed from main → renderer whenever the per-session turn queue changes (enqueue, drain, cancel, clear). */
export interface SessionQueueEvent {
  sessionId: string
  items: PendingQueuedMessage[]
}

/** Notifies the renderer that a persisted transcript row was removed (e.g. ESC-withdraw before execution). */
export interface SessionMessageRemovedEvent {
  sessionId: string
  messageId: number
}

/** `/clear` / SDK conversation_reset: the session's transcript was wiped. */
export interface SessionMessagesClearedEvent {
  sessionId: string
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
  | { kind: 'ask_user_question'; cancelled: true }
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

/** Live model list from the SDK's `initializationResult().models`. */
export interface ModelInfo {
  value: string
  displayName: string
  description: string
  resolvedModel?: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'xhigh' | 'max')[]
}

export interface SessionModelsEvent {
  sessionId: string
  models: ModelInfo[]
}

/** Live Claude Code working directory (composer context bar). From the SDK's `system`/`init` `cwd` and updated on Bash `cd` when inferrable. */
export interface SessionHarnessCwdEvent {
  sessionId: string
  cwd: string
}

/**
 * Context-window token usage push (token-usage-indicator). Fired after every
 * completed turn's `result` harness event from the SDK's `getContextUsage()`.
 * `inputTokens` is total in-context tokens (`totalTokens` from the SDK);
 * `contextWindow` is the effective usable window (`maxTokens` from
 * `getContextUsage()`), not the auto-compaction trigger or raw catalog max.
 */
export interface SessionTokenUsageEvent {
  sessionId: string
  /** Total tokens currently occupying the context window. */
  inputTokens: number
  /** Token count at which auto-compaction is expected to run. */
  contextWindow: number
}

/** Composer ghost prompt from SDK `prompt_suggestion` (not persisted). */
export interface SessionPromptSuggestionEvent {
  sessionId: string
  /** Null clears the placeholder (new turn started, user sent a message). */
  suggestion: string | null
}

/** Worktree creation progress push (use-worktree), fired during `git worktree add` for large repos. */
export interface SessionWorktreeProgressEvent {
  sessionId: string
  /** Integer 0–100 from `git worktree add`'s "Updating files: N%" stderr output. */
  percent: number
}
