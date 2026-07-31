import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { MessageRecord, MessageRole, SessionMode, SessionRecord } from '../../shared/session-types'

/** Raw DB row shapes (snake_case, sqlite ints for booleans). */
interface SessionRow {
  id: string
  name: string
  name_locked_by_user: number
  project_path: string
  mode: string
  hostname: string | null
  group_id: string | null
  pinned: number
  color: string | null
  created_at: string
  closed_at: string | null
  deleted_at: string | null
}

interface MessageRow {
  id: number
  session_id: string
  role: string
  content: string
  raw_event: string | null
  created_at: string
}

function toSessionRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    nameLockedByUser: row.name_locked_by_user === 1,
    projectPath: row.project_path,
    mode: row.mode as SessionMode,
    hostname: row.hostname,
    groupId: row.group_id,
    pinned: row.pinned === 1,
    color: row.color,
    createdAt: row.created_at,
    closedAt: row.closed_at
  }
}

function toMessageRecord(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as MessageRole,
    content: row.content,
    rawEvent: row.raw_event ? JSON.parse(row.raw_event) : null,
    createdAt: row.created_at
  }
}

/**
 * SQLite-backed CRUD for sessions/messages (02-session-lifecycle). Pure data
 * access — no harness/IPC concerns — so it can be unit-exercised on its own.
 */
export class SessionStore {
  constructor(private readonly db: Database.Database) {}

  createSession(input: {
    name: string
    projectPath: string
    mode: SessionMode
    hostname: string | null
    groupId?: string | null
    pinned?: boolean
    color?: string | null
    id?: string
  }): SessionRecord {
    const id = input.id ?? randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, name_locked_by_user, project_path, mode, hostname, group_id, pinned, color, created_at, closed_at, deleted_at)
         VALUES (@id, @name, 0, @projectPath, @mode, @hostname, @groupId, @pinned, @color, @createdAt, NULL, NULL)`
      )
      .run({
        id,
        name: input.name,
        projectPath: input.projectPath,
        mode: input.mode,
        hostname: input.hostname,
        groupId: input.groupId ?? null,
        pinned: input.pinned ? 1 : 0,
        color: input.color ?? null,
        createdAt
      })
    return this.getSession(id)!
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    return row ? toSessionRecord(row) : undefined
  }

  /** Active sessions: not closed. Used for the Pinned/grouped sidebar view. */
  listActiveSessions(): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY created_at ASC')
      .all() as SessionRow[]
    return rows.map(toSessionRecord)
  }

  /** Closed sessions: still resumable, shown under History. */
  listHistorySessions(): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE closed_at IS NOT NULL ORDER BY closed_at DESC')
      .all() as SessionRow[]
    return rows.map(toSessionRecord)
  }

  listAllSessions(): SessionRecord[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at ASC').all() as SessionRow[]
    return rows.map(toSessionRecord)
  }

  /** Manual rename: locks the name so auto-naming can never revert it (Bug #93 regression guard). */
  renameSession(id: string, name: string): SessionRecord | undefined {
    this.db.prepare('UPDATE sessions SET name = ?, name_locked_by_user = 1 WHERE id = ?').run(name, id)
    return this.getSession(id)
  }

  /**
   * Auto-naming summarizer's write path: only ever takes effect if the user
   * has NOT manually renamed the session. This guard lives here (not just in
   * the caller) so it's structurally impossible to bypass.
   */
  setAutoName(id: string, name: string): SessionRecord | undefined {
    const session = this.getSession(id)
    if (!session || session.nameLockedByUser) return session
    this.db.prepare('UPDATE sessions SET name = ? WHERE id = ? AND name_locked_by_user = 0').run(name, id)
    return this.getSession(id)
  }

  setPinned(id: string, pinned: boolean): SessionRecord | undefined {
    this.db.prepare('UPDATE sessions SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
    return this.getSession(id)
  }

  setColor(id: string, color: string): SessionRecord | undefined {
    this.db.prepare('UPDATE sessions SET color = ? WHERE id = ?').run(color, id)
    return this.getSession(id)
  }

  /** Close: disappears from active/pinned view, auto-unpins, transcript stays for later resume. */
  closeSession(id: string): SessionRecord | undefined {
    this.db
      .prepare('UPDATE sessions SET closed_at = ?, pinned = 0 WHERE id = ?')
      .run(new Date().toISOString(), id)
    return this.getSession(id)
  }

  /** Resume: clears closed_at so the session reappears in the active view. */
  reopenSession(id: string): SessionRecord | undefined {
    this.db.prepare('UPDATE sessions SET closed_at = NULL WHERE id = ?').run(id)
    return this.getSession(id)
  }

  /** Delete: hard-removes the session row AND all its message rows (distinct from Close). */
  deleteSession(id: string): void {
    const del = this.db.transaction(() => {
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
    })
    del()
  }

  /** Fork/duplicate: copies full message history under a new id, same group. */
  forkSession(sourceId: string, opts?: { name?: string; id?: string }): SessionRecord | undefined {
    const source = this.getSession(sourceId)
    if (!source) return undefined

    const newId = opts?.id ?? randomUUID()
    const createdAt = new Date().toISOString()

    const fork = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, name, name_locked_by_user, project_path, mode, hostname, group_id, pinned, color, created_at, closed_at, deleted_at)
           VALUES (@id, @name, 0, @projectPath, @mode, @hostname, @groupId, 0, @color, @createdAt, NULL, NULL)`
        )
        .run({
          id: newId,
          name: opts?.name ?? source.name,
          projectPath: source.projectPath,
          mode: source.mode,
          hostname: source.hostname,
          groupId: source.groupId,
          color: source.color,
          createdAt
        })

      const messages = this.db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
        .all(sourceId) as MessageRow[]

      const insertMessage = this.db.prepare(
        `INSERT INTO messages (session_id, role, content, raw_event, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      for (const m of messages) {
        insertMessage.run(newId, m.role, m.content, m.raw_event, m.created_at)
      }
    })
    fork()
    return this.getSession(newId)
  }

  addMessage(input: { sessionId: string; role: MessageRole; content: string; rawEvent?: unknown }): MessageRecord {
    const createdAt = new Date().toISOString()
    const result = this.db
      .prepare(
        `INSERT INTO messages (session_id, role, content, raw_event, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId,
        input.role,
        input.content,
        input.rawEvent !== undefined ? JSON.stringify(input.rawEvent) : null,
        createdAt
      )
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(result.lastInsertRowid) as MessageRow
    return toMessageRecord(row)
  }

  listMessages(sessionId: string): MessageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
      .all(sessionId) as MessageRow[]
    return rows.map(toMessageRecord)
  }

  countMessages(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as c FROM messages WHERE session_id = ?').get(sessionId) as {
      c: number
    }
    return row.c
  }
}
