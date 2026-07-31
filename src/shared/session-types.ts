/**
 * Shared session/message types (02-session-lifecycle). Used by main (DB rows,
 * IPC payloads) and renderer (state, UI) alike — kept free of
 * Electron/Node/better-sqlite3 types so it can be imported from either side.
 */

export type SessionMode = 'terminal' | 'claude-code'

export interface SessionRecord {
  id: string
  name: string
  nameLockedByUser: boolean
  projectPath: string
  mode: SessionMode
  /** null for local sessions; the devpod/SSH host name for remote ones. */
  hostname: string | null
  groupId: string | null
  pinned: boolean
  color: string | null
  createdAt: string
  closedAt: string | null
}

export type MessageRole = 'user' | 'assistant' | 'system'

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
