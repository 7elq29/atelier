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
