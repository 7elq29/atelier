import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from './logger'

let db: Database.Database | undefined

/**
 * Opens (creating if needed) the app's SQLite database file under the
 * user-data dir. Schema/migrations are added in a later task (02-session-lifecycle) —
 * this is just the connection helper so that work has something to build on.
 */
export function openDatabase(): Database.Database {
  if (db) return db

  const dataDir = join(app.getPath('userData'), 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'gardenia.sqlite')

  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  logger.info('database opened', { dbPath })
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = undefined
  }
}
