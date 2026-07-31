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

/** Lifecycle notifications forwarded from main -> renderer for sidebar refresh + e2e log grepping. */
export type SessionLifecycleEvent =
  | { type: 'session.created'; session: SessionRecord }
  | { type: 'session.renamed'; session: SessionRecord }
  | { type: 'session.closed'; session: SessionRecord }
  | { type: 'session.resumed'; session: SessionRecord }
  | { type: 'session.forked'; session: SessionRecord; sourceId: string }
  | { type: 'session.deleted'; sessionId: string }
  | { type: 'session.updated'; session: SessionRecord }
