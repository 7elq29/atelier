/**
 * One-time migration from the Gardenia product rename:
 * - `data/gardenia.sqlite` → `data/atelier.sqlite`
 * - Session worktrees at `<project>/.gardenia/worktrees/<id>` → `.atelier/…`
 * - Matching `gardenia-<id-prefix>` branches → `atelier-<id-prefix>`
 */

import type Database from 'better-sqlite3'
import { app } from 'electron'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logger } from '../logger'

export const GARDENIA_TO_ATELIER_WORKTREE_MIGRATION = '0010_gardenia_to_atelier_worktrees'

/** Below this size, `atelier.sqlite` is treated as an empty scaffold, not real session history. */
const MIN_LEGACY_DB_BYTES = 512_000

const LEGACY_WORKTREE_SEGMENT = '/.gardenia/worktrees/'
const NEW_WORKTREE_SEGMENT = '/.atelier/worktrees/'

const SSH_GIT_OPTS = [
  '-o',
  'ControlMaster=auto',
  '-o',
  'ControlPath=/tmp/atelier-ssh-%C',
  '-o',
  'ControlPersist=300',
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=accept-new'
]

/**
 * Dev installs renamed `package.json` from `gardenia` → `atelier`, so Electron's
 * default userData dir changed (`~/Library/Application Support/Gardenia/` vs
 * `…/atelier/`) while the old SQLite file stayed behind. Import it once when
 * the new profile still has no real session DB.
 */
export function migrateLegacyUserDataFromGardeniaProfiles(): void {
  if (app.commandLine.hasSwitch('user-data-dir')) {
    return
  }

  const currentRoot = app.getPath('userData')
  const currentData = join(currentRoot, 'data')
  const atelierDb = join(currentData, 'atelier.sqlite')

  const atelierLooksEmpty = (): boolean => {
    if (!existsSync(atelierDb)) return true
    return statSync(atelierDb).size < MIN_LEGACY_DB_BYTES
  }

  if (!atelierLooksEmpty()) {
    return
  }

  const appData = app.getPath('appData')
  let currentReal: string | undefined
  try {
    currentReal = realpathSync(currentRoot)
  } catch {
    currentReal = currentRoot
  }

  let best: { root: string; dbPath: string; size: number } | null = null
  for (const name of ['Gardenia', 'gardenia', 'Electron']) {
    const root = join(appData, name)
    let rootReal: string
    try {
      rootReal = realpathSync(root)
    } catch {
      continue
    }
    if (rootReal === currentReal) continue

    const dbPath = join(root, 'data', 'gardenia.sqlite')
    if (!existsSync(dbPath)) continue
    const size = statSync(dbPath).size
    if (size < MIN_LEGACY_DB_BYTES) continue
    if (!best || size > best.size) {
      best = { root, dbPath, size }
    }
  }

  if (!best) return

  mkdirSync(currentData, { recursive: true })

  for (const name of ['atelier.sqlite', 'atelier.sqlite-wal', 'atelier.sqlite-shm']) {
    const p = join(currentData, name)
    if (existsSync(p)) rmSync(p)
  }

  copyFileSync(best.dbPath, join(currentData, 'gardenia.sqlite'))

  const legacyConfig = join(best.root, 'data', 'config.json')
  const currentConfig = join(currentData, 'config.json')
  if (existsSync(legacyConfig)) {
    copyFileSync(legacyConfig, currentConfig)
  }

  logger.info('imported legacy Gardenia user-data into Atelier profile', {
    fromUserData: best.root,
    toUserData: currentRoot,
    legacyDbBytes: best.size
  })
}

export function migrateLegacyGardeniaDatabaseFile(dataDir: string): void {
  const legacyPath = join(dataDir, 'gardenia.sqlite')
  const nextPath = join(dataDir, 'atelier.sqlite')
  if (!existsSync(nextPath) && existsSync(legacyPath)) {
    renameSync(legacyPath, nextPath)
    logger.info('migrated legacy SQLite database filename', { from: legacyPath, to: nextPath })
  }
}

function toAtelierWorktreePath(legacyPath: string): string {
  if (!legacyPath.includes(LEGACY_WORKTREE_SEGMENT)) return legacyPath
  return legacyPath.replaceAll(LEGACY_WORKTREE_SEGMENT, NEW_WORKTREE_SEGMENT)
}

function branchNames(sessionId: string): { legacy: string; next: string } {
  const prefix = sessionId.slice(0, 8)
  return { legacy: `gardenia-${prefix}`, next: `atelier-${prefix}` }
}

function renameBranch(projectPath: string, sessionId: string, hostname: string | null): void {
  const { legacy, next } = branchNames(sessionId)
  if (hostname) {
    try {
      execFileSync(
        'ssh',
        [...SSH_GIT_OPTS, hostname, 'git', '-C', projectPath, 'show-ref', '--verify', '--quiet', `refs/heads/${legacy}`],
        { stdio: 'ignore' }
      )
      execFileSync('ssh', [...SSH_GIT_OPTS, hostname, 'git', '-C', projectPath, 'branch', '-m', legacy, next], {
        encoding: 'utf8',
        timeout: 60_000
      })
    } catch {
      // Branch may already be renamed or never created.
    }
    return
  }

  try {
    execFileSync('git', ['-C', projectPath, 'show-ref', '--verify', '--quiet', `refs/heads/${legacy}`], {
      stdio: 'ignore'
    })
    execFileSync('git', ['-C', projectPath, 'branch', '-m', legacy, next], { encoding: 'utf8' })
  } catch {
    // Branch may already be renamed or never created.
  }
}

function moveWorktree(
  projectPath: string,
  legacyPath: string,
  nextPath: string,
  hostname: string | null
): void {
  mkdirSync(dirname(nextPath), { recursive: true })

  if (hostname) {
    execFileSync(
      'ssh',
      [...SSH_GIT_OPTS, hostname, 'git', '-C', projectPath, 'worktree', 'move', legacyPath, nextPath],
      { encoding: 'utf8', timeout: 5 * 60_000 }
    )
    return
  }

  if (!existsSync(legacyPath)) {
    logger.info('legacy worktree path missing on disk, updating DB only', { legacyPath, nextPath })
    return
  }

  execFileSync('git', ['-C', projectPath, 'worktree', 'move', legacyPath, nextPath], { encoding: 'utf8' })
}

/**
 * Moves git worktrees + rewrites persisted paths. Marked complete in `migrations`
 * only when every session row migrates successfully (retries on next launch otherwise).
 */
export function runGardeniaToAtelierWorktreeMigration(db: Database.Database): void {
  const alreadyApplied = db.prepare('SELECT 1 FROM migrations WHERE name = ?').get(GARDENIA_TO_ATELIER_WORKTREE_MIGRATION)
  if (alreadyApplied) return

  const rows = db
    .prepare(
      `SELECT id, project_path, worktree_path, hostname
       FROM sessions
       WHERE worktree_path IS NOT NULL
         AND worktree_path LIKE '%' || ? || '%'
         AND deleted_at IS NULL`
    )
    .all(LEGACY_WORKTREE_SEGMENT) as Array<{
    id: string
    project_path: string
    worktree_path: string
    hostname: string | null
  }>

  const updateWorktreePath = db.prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?')

  for (const row of rows) {
    const nextPath = toAtelierWorktreePath(row.worktree_path)
    try {
      moveWorktree(row.project_path, row.worktree_path, nextPath, row.hostname)
      renameBranch(row.project_path, row.id, row.hostname)
      updateWorktreePath.run(nextPath, row.id)
      logger.info('migrated session worktree path', {
        sessionId: row.id,
        from: row.worktree_path,
        to: nextPath,
        hostname: row.hostname
      })
    } catch (err) {
      logger.warn('session worktree migration failed; will retry on next launch', {
        sessionId: row.id,
        worktreePath: row.worktree_path,
        error: err instanceof Error ? err.message : String(err)
      })
      return
    }
  }

  db.prepare(
    `UPDATE project_path_history
     SET path = replace(path, ?, ?)
     WHERE path LIKE '%' || ? || '%'`
  ).run(LEGACY_WORKTREE_SEGMENT, NEW_WORKTREE_SEGMENT, LEGACY_WORKTREE_SEGMENT)

  db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
    GARDENIA_TO_ATELIER_WORKTREE_MIGRATION,
    new Date().toISOString()
  )
  logger.info('gardenia → atelier worktree migration applied', { sessionsUpdated: rows.length })
}
