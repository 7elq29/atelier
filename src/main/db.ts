import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger'

let db: Database.Database | undefined

/** Ordered list of migrations. Each runs once, tracked in the `migrations` table. */
const MIGRATIONS: Array<{ name: string; sql: string }> = [
  {
    name: '0001_sessions_and_messages',
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_locked_by_user INTEGER NOT NULL DEFAULT 0,
        project_path TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('terminal', 'claude-code')),
        hostname TEXT,
        group_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        color TEXT,
        created_at TEXT NOT NULL,
        closed_at TEXT,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        raw_event TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_closed_at ON sessions(closed_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_group_id ON sessions(group_id);
    `
  },
  {
    // 06-session-organization: tags (free-form, many-to-many via join table),
    // notes (freeform text per session), a real `session_groups` table
    // (group_id on `sessions` previously held an arbitrary caller-chosen
    // string used directly as the display label — now it's a foreign id into
    // this table, with its own name/order/collapsed state), and a
    // `sort_order` column on `sessions` for manual drag-drop ordering within
    // a group (or within the ungrouped/pinned sections).
    name: '0002_tags_notes_groups_ordering',
    sql: `
      ALTER TABLE sessions ADD COLUMN notes TEXT;
      ALTER TABLE sessions ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;

      CREATE TABLE IF NOT EXISTS session_tags (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tag TEXT NOT NULL,
        PRIMARY KEY (session_id, tag)
      );
      CREATE INDEX IF NOT EXISTS idx_session_tags_tag ON session_tags(tag);

      CREATE TABLE IF NOT EXISTS session_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        sort_order REAL NOT NULL DEFAULT 0,
        collapsed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `
  },
  {
    // 10a-enrichment-cost-tracking: running per-session dollar total, sourced
    // exclusively from the SDK's own `result` event's `totalCostUsd` (see
    // HarnessEvent's 'result' variant) — persisted so it survives relaunch.
    name: '0003_session_cost_tracking',
    sql: `
      ALTER TABLE sessions ADD COLUMN total_cost_usd REAL NOT NULL DEFAULT 0;
    `
  },
  {
    // 10b-enrichment-full-text-search: an FTS5 virtual table over each
    // message's plain searchable text (see shared/chat-content.ts's
    // `extractSearchableText` — user/assistant plain text only, never raw
    // tool-call JSON or other structured-content rows). NOT an "external
    // content" FTS5 table: rows are inserted/updated/deleted explicitly by
    // `SessionStore` (using `rowid = messages.id`) exactly when a message is
    // written, rather than via SQL triggers mirroring `messages` verbatim —
    // that's the only way to apply `extractSearchableText`'s JS-side
    // filtering (skip system rows, skip structured JSON) before indexing.
    // Used by `SessionStore.searchMessages` for the cross-session content
    // search surfaced in the command palette's "Session" results.
    name: '0004_message_full_text_search',
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        text,
        session_id UNINDEXED,
        tokenize = 'unicode61'
      );
    `
  },
  {
    // fix-bug-triage-jul31 / bug #49: remembers recently-used project paths
    // per host so the New Session modal can offer them again on reopen,
    // instead of NewSessionModal's `isOpen` effect unconditionally wiping
    // `projectPath` back to null every time it opens. Keyed on (host_id,
    // path) so re-using an existing path is an upsert (bumps `used_at`,
    // never duplicates) rather than growing unbounded — pruning to the 10
    // most recent per host happens in SessionStore.recordProjectPathUsage.
    name: '0005_project_path_history',
    sql: `
      CREATE TABLE IF NOT EXISTS project_path_history (
        host_id TEXT NOT NULL,
        path TEXT NOT NULL,
        used_at TEXT NOT NULL,
        PRIMARY KEY (host_id, path)
      );
      CREATE INDEX IF NOT EXISTS idx_project_path_history_host_used ON project_path_history(host_id, used_at);
    `
  }
]

function runMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const applied = new Set(
    database.prepare('SELECT name FROM migrations').all().map((row) => (row as { name: string }).name)
  )

  const insertMigration = database.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)')

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue
    const runOne = database.transaction(() => {
      database.exec(migration.sql)
      insertMigration.run(migration.name, new Date().toISOString())
    })
    runOne()
    logger.info('database migration applied', { name: migration.name })
  }
}

/**
 * Opens (creating if needed) the app's SQLite database file under the
 * user-data dir, and runs any pending migrations (sessions/messages schema
 * added in 02-session-lifecycle).
 */
export function openDatabase(): Database.Database {
  if (db) return db

  const dataDir = join(app.getPath('userData'), 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'gardenia.sqlite')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  logger.info('database opened', { dbPath })
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = undefined
  }
}
