import type Database from 'better-sqlite3'
import type { WeeklyPlanWizardData } from '../../shared/weekly-plan-types'

type DraftRow = {
  iso_week: string
  step: number
  data_json: string
  updated_at: string
}

export class WeeklyPlanDraftStore {
  constructor(private db: Database.Database) {}

  get(isoWeek: string): { step: number; data: WeeklyPlanWizardData } | null {
    const row = this.db
      .prepare('SELECT step, data_json FROM weekly_plan_drafts WHERE iso_week = ?')
      .get(isoWeek) as Pick<DraftRow, 'step' | 'data_json'> | undefined
    if (!row) return null
    try {
      return { step: row.step, data: JSON.parse(row.data_json) as WeeklyPlanWizardData }
    } catch {
      return null
    }
  }

  save(isoWeek: string, step: number, data: WeeklyPlanWizardData): void {
    const updatedAt = new Date().toISOString()
    this.db
      .prepare(
        `INSERT INTO weekly_plan_drafts (iso_week, step, data_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(iso_week) DO UPDATE SET
           step = excluded.step,
           data_json = excluded.data_json,
           updated_at = excluded.updated_at`
      )
      .run(isoWeek, step, JSON.stringify(data), updatedAt)
  }

  clear(isoWeek: string): void {
    this.db.prepare('DELETE FROM weekly_plan_drafts WHERE iso_week = ?').run(isoWeek)
  }
}

let store: WeeklyPlanDraftStore | null = null

export function getWeeklyPlanDraftStore(db: Database.Database): WeeklyPlanDraftStore {
  if (!store) store = new WeeklyPlanDraftStore(db)
  return store
}
