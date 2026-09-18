import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AppNoteRecord, AppNoteUpdate } from '../../shared/app-note-types'

type AppNoteRow = {
  id: string
  title: string
  content: string
  created_at: string
  updated_at: string
  sort_order: number
}

function rowToRecord(row: AppNoteRow): AppNoteRecord {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    path: '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sortOrder: row.sort_order
  }
}

export class AppNotesStore {
  constructor(private readonly db: Database.Database) {}

  list(): AppNoteRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM app_notes ORDER BY sort_order ASC, updated_at DESC')
      .all() as AppNoteRow[]
    return rows.map(rowToRecord)
  }

  get(id: string): AppNoteRecord | undefined {
    const row = this.db.prepare('SELECT * FROM app_notes WHERE id = ?').get(id) as AppNoteRow | undefined
    return row ? rowToRecord(row) : undefined
  }

  create(title = 'Untitled note'): AppNoteRecord {
    const now = new Date().toISOString()
    const id = randomUUID()
    const maxOrder = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM app_notes').get() as { m: number }
    const sortOrder = maxOrder.m + 1
    this.db
      .prepare(
        'INSERT INTO app_notes (id, title, content, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, title, '', now, now, sortOrder)
    return rowToRecord(this.db.prepare('SELECT * FROM app_notes WHERE id = ?').get(id) as AppNoteRow)
  }

  update(id: string, patch: AppNoteUpdate): AppNoteRecord | undefined {
    const existing = this.db.prepare('SELECT * FROM app_notes WHERE id = ?').get(id) as AppNoteRow | undefined
    if (!existing) return undefined
    const title = patch.title !== undefined ? patch.title : existing.title
    const content = patch.content !== undefined ? patch.content : existing.content
    const updatedAt = new Date().toISOString()
    this.db.prepare('UPDATE app_notes SET title = ?, content = ?, updated_at = ? WHERE id = ?').run(title, content, updatedAt, id)
    return rowToRecord(this.db.prepare('SELECT * FROM app_notes WHERE id = ?').get(id) as AppNoteRow)
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM app_notes WHERE id = ?').run(id).changes > 0
  }
}
