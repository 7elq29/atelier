import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AppBookmarkInput, AppBookmarkRecord, AppBookmarkUpdate } from '../../shared/app-bookmark-types'

type AppBookmarkRow = {
  id: string
  url: string
  title: string
  created_at: string
  updated_at: string
  sort_order: number
}

function rowToRecord(row: AppBookmarkRow): AppBookmarkRecord {
  return {
    id: row.id,
    url: row.url,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sortOrder: row.sort_order
  }
}

export class AppBookmarksStore {
  constructor(private readonly db: Database.Database) {}

  list(): AppBookmarkRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM app_bookmarks ORDER BY sort_order ASC, created_at ASC')
      .all() as AppBookmarkRow[]
    return rows.map(rowToRecord)
  }

  get(id: string): AppBookmarkRecord | undefined {
    const row = this.db.prepare('SELECT * FROM app_bookmarks WHERE id = ?').get(id) as AppBookmarkRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  findByUrl(url: string): AppBookmarkRecord | undefined {
    const row = this.db.prepare('SELECT * FROM app_bookmarks WHERE url = ?').get(url) as AppBookmarkRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  /** Adding a URL that is already bookmarked returns the existing row instead of duplicating it. */
  create(input: AppBookmarkInput): AppBookmarkRecord {
    const existing = this.findByUrl(input.url)
    if (existing) return existing
    const now = new Date().toISOString()
    const id = randomUUID()
    const maxOrder = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM app_bookmarks').get() as {
      m: number
    }
    this.db
      .prepare(
        'INSERT INTO app_bookmarks (id, url, title, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, input.url, input.title ?? '', now, now, maxOrder.m + 1)
    return rowToRecord(this.db.prepare('SELECT * FROM app_bookmarks WHERE id = ?').get(id) as AppBookmarkRow)
  }

  update(id: string, patch: AppBookmarkUpdate): AppBookmarkRecord | undefined {
    const existing = this.db.prepare('SELECT * FROM app_bookmarks WHERE id = ?').get(id) as AppBookmarkRow | undefined
    if (!existing) return undefined
    const url = patch.url !== undefined ? patch.url : existing.url
    const title = patch.title !== undefined ? patch.title : existing.title
    this.db
      .prepare('UPDATE app_bookmarks SET url = ?, title = ?, updated_at = ? WHERE id = ?')
      .run(url, title, new Date().toISOString(), id)
    return rowToRecord(this.db.prepare('SELECT * FROM app_bookmarks WHERE id = ?').get(id) as AppBookmarkRow)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM app_bookmarks WHERE id = ?').run(id).changes > 0
  }
}
