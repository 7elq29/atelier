import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type {
  MessageRecord,
  MessageRole,
  MessageSearchHit,
  ModelSelection,
  PermissionModeValue,
  SessionGroupRecord,
  SessionMode,
  SessionRecord
} from '../../shared/session-types'
import { extractSearchableText, FTS_SNIPPET_START, FTS_SNIPPET_END } from '../../shared/chat-content'
import type { SessionFileEdit } from '../../shared/session-file-edits'

/**
 * Turns free-typed search input into a safe FTS5 MATCH expression
 * (10b-enrichment-full-text-search): tokenizes on word characters only (so
 * FTS5 syntax characters like `"`, `*`, `:`, `-` in the raw query can never
 * be interpreted as query-language operators), quotes each token, and
 * appends `*` for prefix matching — tokens are ANDed together (FTS5's
 * default when multiple quoted strings appear side by side), so multi-word
 * queries narrow rather than broaden results. Returns null for a query with
 * no indexable tokens (e.g. empty or punctuation-only).
 */
function toFtsMatchQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu) ?? []
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ')
}

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
  notes: string | null
  sort_order: number
  total_cost_usd: number
  ever_connected: number
  permission_mode: string
  model_id: string | null
  effort: string | null
  worktree_path: string | null
  pending_turn_interrupted_notice: number
  last_active_at: string
  linked_daily_task_gid: string | null
  linked_daily_note_date: string | null
  profile_id: string | null
}

interface MessageRow {
  id: number
  session_id: string
  role: string
  content: string
  raw_event: string | null
  created_at: string
}

interface GroupRow {
  id: string
  name: string
  sort_order: number
  collapsed: number
  created_at: string
}

function toGroupRecord(row: GroupRow): SessionGroupRecord {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    collapsed: row.collapsed === 1,
    createdAt: row.created_at
  }
}

function toSessionRecord(row: SessionRow, tags: string[] = []): SessionRecord {
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
    closedAt: row.closed_at,
    tags,
    notes: row.notes,
    sortOrder: row.sort_order,
    totalCostUsd: row.total_cost_usd,
    // fix-no-conversation-found-remote-resume: whether the underlying
    // harness/CLI has ever actually confirmed a real conversation for this
    // session id — see db.ts's '0006_session_ever_connected' migration doc
    // comment and SessionManager.markEverConnected's call site for the full
    // rationale.
    everConnected: row.ever_connected === 1,
    // restore-mode-and-model-on-resume: read from the DB column (populated
    // by SessionStore.setPermissionMode, written whenever the in-memory
    // permissionModes Map changes). SessionManager's `decorate()` overlays
    // its own in-memory value (if present) on top of this, but for sessions
    // first loaded after a relaunch the DB column IS the right value.
    permissionMode: row.permission_mode as PermissionModeValue,
    // restore-mode-and-model-on-resume: read from DB columns; null if never set.
    modelSelection: row.model_id ? { model: row.model_id, effort: row.effort as ModelSelection['effort'] | undefined } : null,
    // use-worktree: absolute path to the session's isolated git worktree, or
    // null for sessions not created with the "Use worktree" toggle.
    worktreePath: row.worktree_path ?? null,
    profileId: row.profile_id ?? null,
    lastActiveAt: row.last_active_at || row.created_at,
    linkedDailyTaskGid: row.linked_daily_task_gid ?? null,
    linkedDailyNoteDate: row.linked_daily_note_date ?? null
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

  /** Batches session_tags lookups for a set of session ids into one query. */
  private tagsFor(sessionIds: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>()
    if (sessionIds.length === 0) return map
    const placeholders = sessionIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT session_id, tag FROM session_tags WHERE session_id IN (${placeholders}) ORDER BY tag ASC`)
      .all(...sessionIds) as { session_id: string; tag: string }[]
    for (const row of rows) {
      const list = map.get(row.session_id) ?? []
      list.push(row.tag)
      map.set(row.session_id, list)
    }
    return map
  }

  private hydrate(rows: SessionRow[]): SessionRecord[] {
    const tagsBySession = this.tagsFor(rows.map((r) => r.id))
    return rows.map((row) => toSessionRecord(row, tagsBySession.get(row.id) ?? []))
  }

  createSession(input: {
    name: string
    projectPath: string
    mode: SessionMode
    hostname: string | null
    groupId?: string | null
    pinned?: boolean
    color?: string | null
    id?: string
    sortOrder?: number
    worktreePath?: string | null
    profileId?: string | null
  }): SessionRecord {
    const id = input.id ?? randomUUID()
    const createdAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, name_locked_by_user, project_path, mode, hostname, group_id, pinned, color, created_at, closed_at, deleted_at, sort_order, worktree_path, last_active_at, profile_id)
         VALUES (@id, @name, 0, @projectPath, @mode, @hostname, @groupId, @pinned, @color, @createdAt, NULL, NULL, @sortOrder, @worktreePath, @lastActiveAt, @profileId)`
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
        createdAt,
        sortOrder: input.sortOrder ?? Date.now(),
        worktreePath: input.worktreePath ?? null,
        lastActiveAt: createdAt,
        profileId: input.profileId ?? null
      })
    return this.getSession(id)!
  }

  getSession(id: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined
    if (!row) return undefined
    return this.hydrate([row])[0]
  }

  /** Active sessions: not closed. Used for the Pinned/grouped sidebar view. */
  listActiveSessions(): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE closed_at IS NULL ORDER BY sort_order ASC, created_at ASC')
      .all() as SessionRow[]
    return this.hydrate(rows)
  }

  /** Closed sessions: still resumable, shown under History. */
  listHistorySessions(): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE closed_at IS NOT NULL ORDER BY closed_at DESC')
      .all() as SessionRow[]
    return this.hydrate(rows)
  }

  listAllSessions(): SessionRecord[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at ASC').all() as SessionRow[]
    return this.hydrate(rows)
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

  setNotes(id: string, notes: string): SessionRecord | undefined {
    this.db.prepare('UPDATE sessions SET notes = ? WHERE id = ?').run(notes, id)
    return this.getSession(id)
  }

  setWorktreePath(id: string, worktreePath: string | null): SessionRecord | undefined {
    this.db.prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?').run(worktreePath, id)
    return this.getSession(id)
  }

  /** Bumps persisted last-active time (session-startup-idle). */
  touchLastActive(id: string, at: string = new Date().toISOString()): void {
    this.db.prepare('UPDATE sessions SET last_active_at = ? WHERE id = ?').run(at, id)
  }

  /**
   * Adds `deltaUsd` to the session's running cost total (10a-enrichment-
   * cost-tracking). The caller (`SessionManager`'s `case 'result'`) is
   * responsible for computing `deltaUsd` as the NEW spend since this is not
   * simply the harness's own `totalCostUsd` — that field is cumulative for
   * the whole live SDK connection (verified for real against the SDK: see
   * `LiveStream.connectionCostUsd` in `manager.ts`), not a per-turn delta.
   * Passing the raw SDK value straight through here would double (or worse)
   * count every turn after the first on a multi-turn connection
   * (fix-session-cost-total-overcounted).
   */
  addCost(id: string, deltaUsd: number): SessionRecord | undefined {
    this.db.prepare('UPDATE sessions SET total_cost_usd = total_cost_usd + ? WHERE id = ?').run(deltaUsd, id)
    return this.getSession(id)
  }

  /**
   * Marks a session as having had at least one real, backend-confirmed
   * connection (fix-no-conversation-found-remote-resume) — called exactly
   * once the harness's `session_started` event (the SDK's own `system`/
   * `init` handshake) has actually fired for this session id, i.e. the
   * underlying CLI has genuinely acknowledged/created this conversation.
   * Idempotent (plain `= 1`, not a toggle) so repeat calls across multiple
   * turns are harmless.
   */
  markEverConnected(id: string): void {
    this.db.prepare('UPDATE sessions SET ever_connected = 1 WHERE id = ?').run(id)
  }

  /** Marks that the next resume should show {@link TURN_INTERRUPTED_NOTICE} once (fix-app-quit-interrupted-turn-notice). */
  setPendingTurnInterruptedNotice(id: string): void {
    this.db.prepare('UPDATE sessions SET pending_turn_interrupted_notice = 1 WHERE id = ?').run(id)
  }

  /**
   * Returns true if a pending interrupted-turn notice was set, and clears the
   * flag atomically so the notice is only ever delivered once per interrupt.
   */
  consumePendingTurnInterruptedNotice(id: string): boolean {
    const row = this.db
      .prepare('SELECT pending_turn_interrupted_notice FROM sessions WHERE id = ?')
      .get(id) as { pending_turn_interrupted_notice: number } | undefined
    if (!row || row.pending_turn_interrupted_notice !== 1) return false
    this.db.prepare('UPDATE sessions SET pending_turn_interrupted_notice = 0 WHERE id = ?').run(id)
    return true
  }

  /** Persists the session's current SDK permission mode (restore-mode-and-model-on-resume). Called at every site that updates the in-memory permissionModes Map. */
  setPermissionMode(id: string, mode: PermissionModeValue): void {
    this.db.prepare('UPDATE sessions SET permission_mode = ? WHERE id = ?').run(mode, id)
  }

  /** Persists the session's model/effort selection (restore-mode-and-model-on-resume). Null clears both columns. Called at every site that updates the in-memory modelSelections Map. */
  setModelSelection(id: string, selection: ModelSelection | null): void {
    this.db
      .prepare('UPDATE sessions SET model_id = ?, effort = ? WHERE id = ?')
      .run(selection?.model ?? null, selection?.effort ?? null, id)
  }


  // ── Tags (06-session-organization) ───────────────────────────────────

  addTag(sessionId: string, tag: string): SessionRecord | undefined {
    const trimmed = tag.trim()
    if (trimmed) {
      this.db
        .prepare('INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)')
        .run(sessionId, trimmed)
    }
    return this.getSession(sessionId)
  }

  removeTag(sessionId: string, tag: string): SessionRecord | undefined {
    this.db.prepare('DELETE FROM session_tags WHERE session_id = ? AND tag = ?').run(sessionId, tag)
    return this.getSession(sessionId)
  }

  /** All distinct tags in use, for filter-suggestion UI. */
  listAllTags(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT tag FROM session_tags ORDER BY tag ASC').all() as { tag: string }[]
    return rows.map((r) => r.tag)
  }

  // ── Groups (06-session-organization) ─────────────────────────────────

  listGroups(): SessionGroupRecord[] {
    const rows = this.db.prepare('SELECT * FROM session_groups ORDER BY sort_order ASC, created_at ASC').all() as GroupRow[]
    return rows.map(toGroupRecord)
  }

  createGroup(name: string, id?: string): SessionGroupRecord {
    const groupId = id ?? randomUUID()
    const createdAt = new Date().toISOString()
    // New groups sort after every existing one by default.
    const maxOrder = this.db.prepare('SELECT MAX(sort_order) as m FROM session_groups').get() as { m: number | null }
    this.db
      .prepare('INSERT INTO session_groups (id, name, sort_order, collapsed, created_at) VALUES (?, ?, ?, 0, ?)')
      .run(groupId, name, (maxOrder.m ?? 0) + 1, createdAt)
    return toGroupRecord(
      this.db.prepare('SELECT * FROM session_groups WHERE id = ?').get(groupId) as GroupRow
    )
  }

  renameGroup(id: string, name: string): SessionGroupRecord | undefined {
    this.db.prepare('UPDATE session_groups SET name = ? WHERE id = ?').run(name, id)
    const row = this.db.prepare('SELECT * FROM session_groups WHERE id = ?').get(id) as GroupRow | undefined
    return row ? toGroupRecord(row) : undefined
  }

  setGroupCollapsed(id: string, collapsed: boolean): SessionGroupRecord | undefined {
    this.db.prepare('UPDATE session_groups SET collapsed = ? WHERE id = ?').run(collapsed ? 1 : 0, id)
    const row = this.db.prepare('SELECT * FROM session_groups WHERE id = ?').get(id) as GroupRow | undefined
    return row ? toGroupRecord(row) : undefined
  }

  /** Deletes a group and un-groups its member sessions (they fall back to "Ungrouped"), never deletes the sessions themselves. */
  deleteGroup(id: string): void {
    const del = this.db.transaction(() => {
      this.db.prepare('UPDATE sessions SET group_id = NULL WHERE group_id = ?').run(id)
      this.db.prepare('DELETE FROM session_groups WHERE id = ?').run(id)
    })
    del()
  }

  reorderGroups(orderedIds: string[]): SessionGroupRecord[] {
    const reorder = this.db.transaction(() => {
      orderedIds.forEach((id, index) => {
        this.db.prepare('UPDATE session_groups SET sort_order = ? WHERE id = ?').run(index, id)
      })
    })
    reorder()
    return this.listGroups()
  }

  setSessionGroup(sessionId: string, groupId: string | null): SessionRecord | undefined {
    this.db.prepare('UPDATE sessions SET group_id = ? WHERE id = ?').run(groupId, sessionId)
    return this.getSession(sessionId)
  }

  /**
   * Persists manual drag-drop order (06-session-organization) for a section
   * — pinned (groupId undefined), a specific group, or ungrouped (groupId
   * null) — by writing sequential `sort_order` values for the given ordered
   * id list. Also moves each session into `groupId` if it isn't already
   * there, so dragging a row into a different group's body both re-parents
   * and re-orders in one persisted write.
   */
  reorderSessions(groupId: string | null | undefined, orderedIds: string[]): SessionRecord[] {
    const reorder = this.db.transaction(() => {
      orderedIds.forEach((id, index) => {
        if (groupId !== undefined) {
          this.db.prepare('UPDATE sessions SET group_id = ?, sort_order = ? WHERE id = ?').run(groupId, index, id)
        } else {
          this.db.prepare('UPDATE sessions SET sort_order = ? WHERE id = ?').run(index, id)
        }
      })
    })
    reorder()
    return orderedIds.map((id) => this.getSession(id)).filter((s): s is SessionRecord => !!s)
  }

  /** Close: disappears from active/pinned view, auto-unpins, transcript stays for later resume. */
  closeSession(id: string): SessionRecord | undefined {
    this.db
      .prepare('UPDATE sessions SET closed_at = ?, pinned = 0 WHERE id = ?')
      .run(new Date().toISOString(), id)
    return this.getSession(id)
  }

  setLinkedDailyTask(sessionId: string, taskGid: string, noteDate: string): SessionRecord | undefined {
    this.db
      .prepare(
        'UPDATE sessions SET linked_daily_task_gid = ?, linked_daily_note_date = ? WHERE id = ?'
      )
      .run(taskGid, noteDate, sessionId)
    return this.getSession(sessionId)
  }

  clearLinkedDailyTask(sessionId: string): SessionRecord | undefined {
    this.db
      .prepare('UPDATE sessions SET linked_daily_task_gid = NULL, linked_daily_note_date = NULL WHERE id = ?')
      .run(sessionId)
    return this.getSession(sessionId)
  }

  /** Resume: clears closed_at so the session reappears in the active view. */
  reopenSession(id: string): SessionRecord | undefined {
    this.db.prepare('UPDATE sessions SET closed_at = NULL WHERE id = ?').run(id)
    return this.getSession(id)
  }

  /** Delete: hard-removes the session row AND all its message rows (distinct from Close). */
  deleteSession(id: string): void {
    const del = this.db.transaction(() => {
      // messages_fts isn't a real foreign-keyed child of `messages` (FTS5
      // virtual tables can't participate in `ON DELETE CASCADE`), so its
      // rows for this session have to be removed explicitly, and BEFORE the
      // `messages` rows themselves since this subquery reads from them.
      this.db
        .prepare('DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE session_id = ?)')
        .run(id)
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
          `INSERT INTO sessions (id, name, name_locked_by_user, project_path, mode, hostname, group_id, pinned, color, created_at, closed_at, deleted_at, sort_order)
           VALUES (@id, @name, 0, @projectPath, @mode, @hostname, @groupId, 0, @color, @createdAt, NULL, NULL, @sortOrder)`
        )
        .run({
          id: newId,
          name: opts?.name ?? source.name,
          projectPath: source.projectPath,
          mode: source.mode,
          hostname: source.hostname,
          groupId: source.groupId,
          color: source.color,
          createdAt,
          sortOrder: Date.now()
        })

      const insertTag = this.db.prepare('INSERT OR IGNORE INTO session_tags (session_id, tag) VALUES (?, ?)')
      for (const tag of source.tags) insertTag.run(newId, tag)

      const messages = this.db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
        .all(sourceId) as MessageRow[]

      const insertMessage = this.db.prepare(
        `INSERT INTO messages (session_id, role, content, raw_event, created_at) VALUES (?, ?, ?, ?, ?)`
      )
      for (const m of messages) {
        const result = insertMessage.run(newId, m.role, m.content, m.raw_event, m.created_at)
        this.indexMessageForSearch({
          id: Number(result.lastInsertRowid),
          sessionId: newId,
          role: m.role as MessageRole,
          content: m.content
        })
      }

      this.db
        .prepare(
          `INSERT INTO session_touched_paths (session_id, path, first_touched_at, last_pending_at)
           SELECT ?, path, first_touched_at, last_pending_at FROM session_touched_paths WHERE session_id = ?`
        )
        .run(newId, sourceId)
      this.db
        .prepare(
          `INSERT INTO session_cap_commits (session_id, hash, subject, committed_at, sort_order)
           SELECT ?, hash, subject, committed_at, sort_order FROM session_cap_commits WHERE session_id = ?`
        )
        .run(newId, sourceId)
      const srcCursor = this.db
        .prepare('SELECT last_head, baseline_head FROM session_git_cursor WHERE session_id = ?')
        .get(sourceId) as { last_head: string | null; baseline_head: string | null } | undefined
      if (srcCursor) {
        this.db
          .prepare(
            `INSERT INTO session_git_cursor (session_id, last_head, baseline_head) VALUES (?, ?, ?)`
          )
          .run(newId, srcCursor.last_head, srcCursor.baseline_head)
      }
    })
    fork()
    return this.getSession(newId)
  }

  /**
   * Keeps `messages_fts` (10b-enrichment-full-text-search) in sync with one
   * message row: always deletes any prior indexed text for this id first
   * (simplest correct thing for both a first-time insert and an in-place
   * `updateMessage` edit — FTS5 doesn't support `INSERT OR REPLACE` on an
   * explicit rowid the way ordinary tables do), then re-inserts only if
   * `extractSearchableText` says this message has plain prose worth indexing
   * (plain user/assistant text — never tool-call JSON, todo/compaction
   * banners, prompt cards, or system rows).
   */
  private indexMessageForSearch(message: { id: number; sessionId: string; role: MessageRole; content: string }): void {
    this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(message.id)
    const text = extractSearchableText(message.role, message.content)
    if (text === null) return
    this.db
      .prepare('INSERT INTO messages_fts (rowid, text, session_id) VALUES (?, ?, ?)')
      .run(message.id, text, message.sessionId)
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
    const record = toMessageRecord(row)
    this.indexMessageForSearch(record)
    return record
  }

  /**
   * In-place update of an existing message row (03-chat-surface-core): used
   * to (a) commit a streamed assistant text segment's final content once it
   * ends, and (b) flip a tool-call message's JSON content from `running` to
   * `completed`/`error` when its `tool_call_end` arrives — both cases keep
   * the "one row per message" model (no extra row for the terminal state).
   */
  updateMessage(id: number, input: { content?: string; rawEvent?: unknown }): MessageRecord | undefined {
    const existing = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
    if (!existing) return undefined
    const content = input.content !== undefined ? input.content : existing.content
    const rawEvent = input.rawEvent !== undefined ? JSON.stringify(input.rawEvent) : existing.raw_event
    this.db.prepare('UPDATE messages SET content = ?, raw_event = ? WHERE id = ?').run(content, rawEvent, id)
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow
    const record = toMessageRecord(row)
    this.indexMessageForSearch(record)
    return record
  }

  /** Hard-delete a single message row (and its FTS index entry). Returns the removed row when it existed. */
  deleteMessage(id: number): MessageRecord | undefined {
    const existing = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined
    if (!existing) return undefined
    this.db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(id)
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
    return toMessageRecord(existing)
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

  /**
   * Cross-session content search (10b-enrichment-full-text-search): matches
   * `query` against every indexed message's plain text via the `messages_fts`
   * FTS5 table, newest-relevance-first (`rank`), then hydrates each hit with
   * the surrounding session/message context the command palette needs to
   * render a result row and jump to it. Returns `[]` for a query with no
   * indexable tokens (see `toFtsMatchQuery`) rather than matching everything.
   *
   * Deliberately two queries, not one JOINed query: FTS5's `snippet()` aux
   * function requires its first argument to be the literal FTS5 table
   * reference for the row it's snippeting — verified live that this breaks
   * ("no such column: mf") the moment `messages_fts` is JOINed under an
   * alias, even though `rank`/`MATCH` against that same alias work fine. A
   * plain, unaliased, JOIN-free `messages_fts` query for the snippet, then a
   * second ordinary query for session/message metadata, sidesteps that
   * entirely.
   */
  searchMessages(query: string, limit = 20): MessageSearchHit[] {
    const match = toFtsMatchQuery(query)
    if (match === null) return []
    const ftsRows = this.db
      .prepare(
        `SELECT rowid AS message_id, session_id, snippet(messages_fts, 0, ?, ?, '…', 10) AS snippet
         FROM messages_fts
         WHERE messages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(FTS_SNIPPET_START, FTS_SNIPPET_END, match, limit) as {
      message_id: number
      session_id: string
      snippet: string
    }[]
    if (ftsRows.length === 0) return []

    const messageIds = ftsRows.map((r) => r.message_id)
    const placeholders = messageIds.map(() => '?').join(',')
    const metaRows = this.db
      .prepare(
        `SELECT msg.id AS message_id, msg.created_at AS created_at, s.name AS session_name
         FROM messages msg
         JOIN sessions s ON s.id = msg.session_id
         WHERE msg.id IN (${placeholders})`
      )
      .all(...messageIds) as { message_id: number; created_at: string; session_name: string }[]
    const metaByMessageId = new Map(metaRows.map((r) => [r.message_id, r]))

    return ftsRows
      .map((row) => {
        const meta = metaByMessageId.get(row.message_id)
        if (!meta) return null
        return {
          sessionId: row.session_id,
          sessionName: meta.session_name,
          messageId: row.message_id,
          snippet: row.snippet,
          createdAt: meta.created_at
        }
      })
      .filter((hit): hit is MessageSearchHit => hit !== null)
  }

  // ── Project path history (fix-bug-triage-jul31 / bug #49) ────────────

  /**
   * Records that `path` was just used to create a session on `hostId`
   * ('local' or a RemoteHostOption.id) — upserts so re-using an existing
   * path just bumps its `used_at` rather than creating a duplicate entry,
   * then prunes to the 10 most-recently-used paths for that host so the
   * table can't grow unbounded across a long-lived install.
   */
  recordProjectPathUsage(hostId: string, path: string): void {
    const usedAt = new Date().toISOString()
    const record = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO project_path_history (host_id, path, used_at) VALUES (?, ?, ?)
           ON CONFLICT (host_id, path) DO UPDATE SET used_at = excluded.used_at`
        )
        .run(hostId, path, usedAt)
      // Prune everything past the 10 most recent for this host.
      this.db
        .prepare(
          `DELETE FROM project_path_history
           WHERE host_id = ?
             AND path NOT IN (
               SELECT path FROM project_path_history
               WHERE host_id = ?
               ORDER BY used_at DESC
               LIMIT 10
             )`
        )
        .run(hostId, hostId)
    })
    record()
  }

  /** Most-recently-used project paths for `hostId`, newest first — capped at 10 by `recordProjectPathUsage`'s pruning. */
  listRecentProjectPaths(hostId: string): string[] {
    const rows = this.db
      .prepare('SELECT path FROM project_path_history WHERE host_id = ? ORDER BY used_at DESC LIMIT 10')
      .all(hostId) as { path: string }[]
    return rows.map((r) => r.path)
  }

  // ── Session changes cap (touched paths, commits, git cursor) ───────────

  registerSessionTouchedPath(sessionId: string, path: string, touchedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO session_touched_paths (session_id, path, first_touched_at, last_pending_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (session_id, path) DO NOTHING`
      )
      .run(sessionId, path, touchedAt, touchedAt)
  }

  listSessionTouchedPaths(
    sessionId: string
  ): Array<{ path: string; firstTouchedAt: string; lastPendingAt: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT path, first_touched_at, last_pending_at FROM session_touched_paths
         WHERE session_id = ? ORDER BY path ASC`
      )
      .all(sessionId) as { path: string; first_touched_at: string; last_pending_at: string | null }[]
    return rows.map((r) => ({
      path: r.path,
      firstTouchedAt: r.first_touched_at,
      lastPendingAt: r.last_pending_at
    }))
  }

  updateSessionTouchedPathPendingAt(sessionId: string, path: string, pendingAt: string): void {
    this.db
      .prepare(`UPDATE session_touched_paths SET last_pending_at = ? WHERE session_id = ? AND path = ?`)
      .run(pendingAt, sessionId, path)
  }

  deleteSessionTouchedPath(sessionId: string, path: string): void {
    this.db.prepare(`DELETE FROM session_touched_paths WHERE session_id = ? AND path = ?`).run(sessionId, path)
  }

  getSessionGitCursor(
    sessionId: string
  ): { lastHead: string | null; baselineHead: string | null } | null {
    const row = this.db
      .prepare('SELECT last_head, baseline_head FROM session_git_cursor WHERE session_id = ?')
      .get(sessionId) as { last_head: string | null; baseline_head: string | null } | undefined
    if (!row) return null
    return { lastHead: row.last_head, baselineHead: row.baseline_head }
  }

  upsertSessionGitCursor(sessionId: string, lastHead: string, baselineHead: string): void {
    this.db
      .prepare(
        `INSERT INTO session_git_cursor (session_id, last_head, baseline_head) VALUES (?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET last_head = excluded.last_head,
           baseline_head = COALESCE(session_git_cursor.baseline_head, excluded.baseline_head)`
      )
      .run(sessionId, lastHead, baselineHead)
  }

  insertSessionCapCommit(
    sessionId: string,
    hash: string,
    subject: string,
    committedAt: string,
    sortOrder: number
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO session_cap_commits (session_id, hash, subject, committed_at, sort_order)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(sessionId, hash, subject, committedAt, sortOrder)
  }

  listSessionCapCommits(
    sessionId: string
  ): Array<{ hash: string; subject: string; committedAt: string; sortOrder: number }> {
    const rows = this.db
      .prepare(
        `SELECT hash, subject, committed_at, sort_order FROM session_cap_commits
         WHERE session_id = ? ORDER BY sort_order DESC`
      )
      .all(sessionId) as {
      hash: string
      subject: string
      committed_at: string
      sort_order: number
    }[]
    return rows.map((r) => ({
      hash: r.hash,
      subject: r.subject,
      committedAt: r.committed_at,
      sortOrder: r.sort_order
    }))
  }

  /** @deprecated v1 cap — use listSessionTouchedPaths + buildSessionChangesCap */
  listSessionFileEdits(sessionId: string): SessionFileEdit[] {
    return []
  }
}
