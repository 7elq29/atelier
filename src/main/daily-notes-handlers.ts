/**
 * IPC handlers for daily-note read/write/watch, wired up from
 * src/main/index.ts the same way app:getVersion etc. are (see progress.md
 * for 00-app-shell's established IPC pattern).
 *
 * This module owns the bug fix described in
 * Features/09-obsidian-integration/spec.md: Playground's daily-note sync
 * derives task ids from line number, so an external delete racing an
 * in-flight full-file rewrite can resurrect the deleted task (the rewrite
 * just re-serializes whatever the renderer still has in memory). Gardenia's
 * tasks instead carry a persistent `gid` (see daily-note-io.ts), and every
 * write goes through a tombstone diff: reread the file fresh from disk right
 * before writing, and drop any task id that used to be known-good but is no
 * longer present on disk — regardless of what the incoming write still has.
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import type { DailyNote } from '../shared/daily-note-types'
import { parseDailyNote, serializeDailyNote, resolveNotePath, generateNewNote, getTaskIds } from './daily-note-io'
import { logger } from './logger'

const WATCH_DEBOUNCE_MS = 300

/**
 * Per-path "ever known" task-id sets: every id we've ever observed in a
 * fresh disk read (initial read, watcher reparse, or a write's own pre-write
 * reread), unioned in — never overwritten wholesale. It only shrinks when a
 * write explicitly prunes ids it just confirmed tombstoned.
 *
 * This must be union-only rather than "latest snapshot wins": the fs watcher
 * and a pending write's fresh-disk-read both update this map independently
 * and can interleave in either order. If the watcher's reparse (which runs
 * concurrently while a write is deliberately delayed — see
 * pendingTestWriteDelayMs) *replaced* this map with its own fresh id set, a
 * write that computes `tombstoned = knownGood - freshIds` immediately after
 * would see `knownGood` already missing the deleted id and conclude nothing
 * was tombstoned — the very bug this mechanism exists to prevent, just
 * relocated one level up. Union-only growth plus per-write pruning (below)
 * keeps that ordering irrelevant: whichever of {watcher, write} reads the
 * deletion off disk first, the id stays recorded as "known" until a write
 * actually computes the tombstone diff and drops it for good.
 */
const everKnownIds = new Map<string, Set<string>>()

function recordKnownIds(path: string, ids: Set<string>): void {
  const existing = everKnownIds.get(path)
  if (!existing) {
    everKnownIds.set(path, new Set(ids))
    return
  }
  for (const id of ids) existing.add(id)
}

let activeWatcher: FSWatcher | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let watchedPath: string | null = null

/**
 * Set (once) by the test-only `daily-note:testDelayNextWrite` handler. When
 * present, the *next* write-daily-note call sleeps this many ms after
 * capturing the incoming write's intended state but *before* doing its
 * fresh-disk-read + tombstone diff — simulating "a write already in flight"
 * while an external edit (e.g. a direct edit to the fixture file in a test)
 * lands concurrently. Consumed once per write, then cleared.
 */
let pendingTestWriteDelayMs: number | null = null

function resolveVaultRoot(): string | null {
  return process.env.GARDENIA_TEST_VAULT_ROOT ?? process.env.GARDENIA_VAULT_ROOT ?? null
}

/** Today's date as YYYY-MM-DD (local time), overridable for deterministic e2e runs. */
function resolveDefaultDate(): string {
  if (process.env.GARDENIA_TEST_DATE) return process.env.GARDENIA_TEST_DATE
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function registerDailyNoteHandlers(getMainWindow: () => BrowserWindow | null): void {
  const isTestMode = process.env.GARDENIA_TEST_VAULT_ROOT !== undefined

  ipcMain.handle('daily-note:getVaultRoot', () => resolveVaultRoot())
  ipcMain.handle('daily-note:getDefaultDate', () => resolveDefaultDate())


  ipcMain.handle('daily-note:read', async (_event, date: string) => {
    const vaultRoot = resolveVaultRoot()
    if (!vaultRoot) return { note: null, raw: null, exists: false }

    const path = resolveNotePath(date, vaultRoot)
    if (!existsSync(path)) return { note: null, raw: null, exists: false }

    const content = await readFile(path, 'utf-8')
    const { note, raw } = parseDailyNote(content, date)
    recordKnownIds(path, getTaskIds(note))
    logger.info('daily-note read', { path, taskCount: note.tasks.length })
    return { note, raw, exists: true }
  })

  ipcMain.handle('daily-note:create', async (_event, date: string) => {
    const vaultRoot = resolveVaultRoot()
    if (!vaultRoot) throw new Error('no vault root configured (GARDENIA_VAULT_ROOT / GARDENIA_TEST_VAULT_ROOT)')

    const path = resolveNotePath(date, vaultRoot)
    if (existsSync(path)) {
      const content = await readFile(path, 'utf-8')
      const { note, raw } = parseDailyNote(content, date)
      recordKnownIds(path, getTaskIds(note))
      return { note, raw, exists: true }
    }

    const content = generateNewNote(date)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf-8')
    const { note, raw } = parseDailyNote(content, date)
    recordKnownIds(path, getTaskIds(note))
    logger.info('daily-note created', { path })
    return { note, raw, exists: true }
  })

  ipcMain.handle('daily-note:write', async (_event, date: string, incoming: DailyNote) => {
    const vaultRoot = resolveVaultRoot()
    if (!vaultRoot) throw new Error('no vault root configured')

    const path = resolveNotePath(date, vaultRoot)
    const incomingIds = getTaskIds(incoming)

    // Test-only hook: simulate a write that's already "in flight" (its
    // payload captured) but hasn't yet reached the fresh-disk-read/tombstone
    // step. See pendingTestWriteDelayMs doc comment above.
    if (pendingTestWriteDelayMs !== null) {
      const delay = pendingTestWriteDelayMs
      pendingTestWriteDelayMs = null
      logger.info('daily-note write delayed (test hook)', { path, delayMs: delay, incomingIds: [...incomingIds] })
      await sleep(delay)
    }

    // Tombstone diff: reread fresh from disk RIGHT BEFORE writing, not at
    // whatever earlier moment this write was scheduled/invoked. This is what
    // makes the fix race-proof rather than merely correct-in-the-common-case:
    // even if the write's payload was captured before an external delete
    // happened, the diff below is computed against the disk state at write
    // time, so the delete is already visible.
    let freshNote: DailyNote
    let rawSections
    if (existsSync(path)) {
      const freshContent = await readFile(path, 'utf-8')
      const parsed = parseDailyNote(freshContent, date)
      freshNote = parsed.note
      rawSections = parsed.raw
    } else {
      freshNote = { date, dayOfWeek: '', tasks: [], bigThree: [] }
      rawSections = { frontmatter: [], beforeTasks: [], afterTasks: [] }
    }
    const freshIds = getTaskIds(freshNote)
    recordKnownIds(path, freshIds)
    const everKnown = everKnownIds.get(path) ?? freshIds

    // A true external delete: an id we've seen on disk before, at any point,
    // that is no longer in the current fresh read. (Ids never seen on disk
    // — freshly minted by addTask locally — are left alone: `everKnown`
    // wouldn't contain them yet, so they can't be mistaken for a delete.)
    const tombstoned = [...everKnown].filter((id) => !freshIds.has(id))
    const tombstonedSet = new Set(tombstoned)
    const survivingTasks = incoming.tasks.filter((t) => !tombstonedSet.has(t.id))

    if (tombstoned.length > 0) {
      logger.info('daily-note tombstone diff: dropping externally-deleted tasks', {
        path,
        tombstoned,
        incomingIds: [...incomingIds],
        freshIds: [...freshIds]
      })
    }

    const toWrite: DailyNote = { ...incoming, tasks: survivingTasks }
    const serialized = serializeDailyNote(toWrite, rawSections)

    const tmpPath = `${path}.tmp`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmpPath, serialized, 'utf-8')
    renameSync(tmpPath, path)

    // Prune confirmed-gone ids, then record everything we just wrote as known.
    for (const id of tombstoned) everKnown.delete(id)
    recordKnownIds(path, getTaskIds(toWrite))
    logger.info('daily-note write committed', { path, taskCount: toWrite.tasks.length })

    return { note: toWrite }
  })

  ipcMain.handle('daily-note:watch', (_event, date: string) => {
    const vaultRoot = resolveVaultRoot()
    if (!vaultRoot) return

    if (activeWatcher) {
      activeWatcher.close()
      activeWatcher = null
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    const path = resolveNotePath(date, vaultRoot)
    watchedPath = path
    if (!existsSync(path)) return

    const dir = dirname(path)
    const targetName = basename(path)

    const notifyChange = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        try {
          if (!existsSync(path)) return
          const content = readFileSync(path, 'utf-8')
          const { note } = parseDailyNote(content, date)
          recordKnownIds(path, getTaskIds(note))
          logger.info('daily-note watcher: reparsed after change', { path, taskCount: note.tasks.length })
          const win = getMainWindow()
          if (win && !win.isDestroyed()) {
            win.webContents.send('daily-note:changed', note)
          }
        } catch {
          // File may be mid-write (temp-file swap in progress); ignore, the
          // next fs event (the rename completing) will retrigger this.
        }
      }, WATCH_DEBOUNCE_MS)
    }

    // Watch the parent directory, not the file itself: Obsidian (and our own
    // write-back) saves atomically via write-temp-then-rename, which swaps
    // the file's inode. fs.watch() on a specific path can silently stop
    // reporting further changes once that swap happens (a well-known
    // macOS/APFS + Linux/inotify limitation, since the watch descriptor is
    // tied to the original inode). Watching the containing directory and
    // filtering by filename survives the rename because the directory itself
    // is never replaced.
    const watcher = watch(dir, (_eventType, filename) => {
      if (filename && filename !== targetName) return
      logger.info('daily-note watcher: fs event', { path, filename })
      notifyChange()
    })
    watcher.unref()
    activeWatcher = watcher
    logger.info('daily-note watcher: started', { path, dir })
  })

  ipcMain.handle('daily-note:unwatch', () => {
    if (activeWatcher) {
      activeWatcher.close()
      activeWatcher = null
      logger.info('daily-note watcher: stopped', { path: watchedPath })
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    watchedPath = null
  })

  // Test-only: never registered outside test mode, so it's unreachable from
  // a real end-user build even if the renderer somehow tried to call it.
  if (isTestMode) {
    ipcMain.handle('daily-note:testDelayNextWrite', (_event, ms: number) => {
      pendingTestWriteDelayMs = ms
    })
  }
}
