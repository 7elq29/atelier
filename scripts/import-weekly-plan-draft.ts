/**
 * One-off: import a markdown backup into weekly_plan_drafts (Atelier SQLite).
 *
 * Usage:
 *   npx tsx scripts/import-weekly-plan-draft.ts <markdown-path> [isoWeek] [step]
 *
 * Default DB: ~/Library/Application Support/Atelier/data/atelier.sqlite
 * Override: ATELIER_USER_DATA=/path/to/userData
 */
import Database from 'better-sqlite3'
import { readFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseWeeklyPlanWizardDataFromMarkdown } from '../src/shared/weekly-plan-import'
import { getISOWeek, getISOWeekYear } from '../src/main/daily-note-io'

const MIGRATION_WEEKLY_DRAFTS = `
CREATE TABLE IF NOT EXISTS weekly_plan_drafts (
  iso_week TEXT PRIMARY KEY,
  step INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`

function formatIsoWeekKey(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return `${getISOWeekYear(d)}-W${String(getISOWeek(d)).padStart(2, '0')}`
}

function openDbAtUserData(userDataDir: string): Database.Database {
  const dataDir = join(userDataDir, 'data')
  mkdirSync(dataDir, { recursive: true })
  const dbPath = join(dataDir, 'atelier.sqlite')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(MIGRATION_WEEKLY_DRAFTS)
  return db
}

function main(): void {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: npx tsx scripts/import-weekly-plan-draft.ts <markdown-path> [isoWeek] [step]')
    process.exit(1)
  }
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }

  const isoWeekArg = process.argv[3]
  const stepArg = process.argv[4]
  const today = new Date()
  const dateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const isoWeek = isoWeekArg ?? formatIsoWeekKey(dateKey)
  const step = stepArg !== undefined ? parseInt(stepArg, 10) : 0

  const userData =
    process.env.ATELIER_USER_DATA ?? join(homedir(), 'Library', 'Application Support', 'Atelier')

  const content = readFileSync(filePath, 'utf-8')
  const data = parseWeeklyPlanWizardDataFromMarkdown(content)
  const db = openDbAtUserData(userData)
  const updatedAt = new Date().toISOString()
  db.prepare(
    `INSERT INTO weekly_plan_drafts (iso_week, step, data_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(iso_week) DO UPDATE SET
       step = excluded.step,
       data_json = excluded.data_json,
       updated_at = excluded.updated_at`
  ).run(isoWeek, step, JSON.stringify(data), updatedAt)
  db.close()

  console.log(JSON.stringify({ ok: true, userData, isoWeek, step, filePath }, null, 2))
}

main()
