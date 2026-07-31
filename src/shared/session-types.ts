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
 */
export type SessionStatus = 'working' | 'waiting' | 'idle' | 'disconnected'

export interface SessionStatusEvent {
  sessionId: string
  status: SessionStatus
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
