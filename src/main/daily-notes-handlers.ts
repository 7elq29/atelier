/**
 * IPC handlers for daily-note read/write/watch, wired up from
 * src/main/index.ts the same way app:getVersion etc. are (see progress.md
 * for 00-app-shell's established IPC pattern).
 *
 * This module owns the bug fix described in
 * Features/09-obsidian-integration/spec.md: Playground's daily-note sync
 * derives task ids from line number, so an external delete racing an
 * in-flight full-file rewrite can resurrect the deleted task (the rewrite
 * just re-serializes whatever the renderer still has in memory). Atelier's
 * tasks instead carry a persistent `gid` (see daily-note-io.ts), and every
 * write goes through a tombstone diff: reread the file fresh from disk right
 * before writing, and drop any task id that used to be known-good but is no
 * longer present on disk — regardless of what the incoming write still has.
 */
import { ipcMain, dialog, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import type { DailyNote, DailyTask, RawSections, DailyNoteNotesSliceResult } from '../shared/daily-note-types'
import {
  parseDailyNote,
  serializeDailyNote,
  resolveNotePath,
  generateNewNote,
  getTaskIds,
  extractNotesBodyFromAfterTasks,
  mergeNotesBodyIntoAfterTasks,
  DEFAULT_NOTES_SECTION_HEADING
} from './daily-note-io'
import { logger } from './logger'
import { loadConfig } from './config'

const WATCH_DEBOUNCE_MS = 300

/** How many days back to scan for the most recent existing prior note (UC-2 carry-over). */
const CARRY_OVER_LOOKBACK_DAYS = 14

/**
 * `date` minus `n` days, formatted as `YYYY-MM-DD`. Constructs with an
 * explicit `T00:00:00` local-time suffix — same convention as
 * `getDayOfWeek`/`resolveNotePath` in daily-note-io.ts — to avoid UTC/local
 * timezone drift shifting the computed day.
 */
function subtractDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() - n)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/**
 * Scan backward from (but not including) `date`, up to `CARRY_OVER_LOOKBACK_DAYS`
 * days, for the most recent daily note file that actually exists on disk.
 * Returns its date string, or null if none was found within the window.
 */
function findMostRecentNoteDate(date: string, settings: VaultSettings): string | null {
  for (let n = 1; n <= CARRY_OVER_LOOKBACK_DAYS; n++) {
    const candidateDate = subtractDays(date, n)
    const candidatePath = resolveNotePath(candidateDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
    if (existsSync(candidatePath)) return candidateDate
  }
  return null
}

/**
 * Collect the tasks from a prior note that should carry forward into a new
 * note (UC-2): open or in-progress, non-tracker. In-progress tasks are
 * normalized back to open on carry-forward (a task can't still be "in
 * progress" on a day that hasn't started yet), and any stale completion
 * date is cleared.
 */
function collectCarryOverTasks(note: DailyNote): DailyTask[] {
  return note.tasks
    .filter((t) => (t.status === 'open' || t.status === 'in-progress') && !t.isTracker && t.section !== 'tracker')
    .map((t) => ({ ...t, status: 'open' as const, completion: undefined }))
}

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

/**
 * Per-path record of the exact file content this process most recently wrote
 * (via `daily-note:create` or `daily-note:write`), used to suppress
 * self-triggered fs.watch echoes.
 *
 * Root cause (see fix-note-content-reverts-to-template-on-edit): on macOS,
 * an `fs.watch()` armed on a directory immediately after this process writes
 * a file into it can still receive a coalesced notification for that
 * already-completed write. If the watcher's debounced reparse fires before a
 * concurrent user edit's own debounced write lands, it pushes a stale
 * `daily-note:changed` snapshot to the renderer, which both stomps in-memory
 * state AND cancels the pending write — silently discarding the edit.
 *
 * The fix compares the freshly-read disk content against exactly what this
 * process itself last wrote to that path: if they're identical, the fs event
 * was just an echo of our own write and must not be pushed to the renderer.
 * Only a genuine content difference — a real external edit, e.g. an actual
 * Obsidian save — should propagate. This is content-based rather than a
 * boolean flag or timer so it stays correct regardless of timing: a
 * flag/timer would just relocate the race to a different deadline.
 */
const lastWrittenContent = new Map<string, string>()

function recordWrittenContent(path: string, content: string): void {
  lastWrittenContent.set(path, content)
}

export function recordWrittenContentForPath(path: string, content: string): void {
  recordWrittenContent(path, content)
}

export function recordKnownIdsForPath(path: string, ids: Set<string>): void {
  recordKnownIds(path, ids)
}

export function readVaultSettings(): VaultSettings | null {
  return resolveVaultSettings()
}

export function notifyDailyNoteChanged(getMainWindow: () => BrowserWindow | null, note: DailyNote): void {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('daily-note:changed', note)
  }
}

/**
 * fix-gidless-task-id-not-persisted: `parseDailyNote` mints a fresh random
 * id for any task line lacking a `[gid:: ...]` tag (e.g. hand-typed in
 * Obsidian), but never writes it back on its own — that's this function's
 * job. Called right after every `parseDailyNote(...)` in this file with the
 * `mintedIds` it reported; a no-op when empty (the overwhelmingly common
 * case — nothing to do on every normal re-read).
 *
 * When `mintedIds` is non-empty, `note` already carries those minted ids in
 * memory (same object `parseDailyNote` returned), so serializing it and
 * writing it back is enough to make every task's gid durable — including
 * ones with a pre-existing gid, since `serializeDailyNote`/`serializeTaskLine`
 * always round-trip whatever `task.gid` currently is. This makes the *first*
 * parse to ever see a gid-less task line the one that persists it, so every
 * subsequent parse (a different IPC call, the file watcher, a relaunch)
 * reuses the same id instead of independently minting a new random one.
 *
 * Uses the exact same temp-file + rename + recordWrittenContent/
 * recordKnownIds bookkeeping as every other write in this file, so the
 * fs.watch self-write-echo suppression (see `lastWrittenContent` above,
 * fix-note-content-reverts-to-template-on-edit) correctly treats the fs
 * event this write triggers as our own, not an external edit.
 */
export function persistMintedGids(path: string, note: DailyNote, raw: RawSections, mintedIds: string[]): void {
  if (mintedIds.length === 0) return
  const serialized = serializeDailyNote(note, raw)
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = `${path}.tmp`
  writeFileSync(tmpPath, serialized, 'utf-8')
  renameSync(tmpPath, path)
  recordWrittenContent(path, serialized)
  recordKnownIds(path, getTaskIds(note))
  logger.info('daily-note: persisted newly-minted gid(s) for previously untagged task(s)', {
    path,
    mintedIds
  })
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

const TEMPLATE_RELATIVE_PATH = '92.templates/Daily Note Template.md'

/** Real vault template for scaffolding a new note, or null if the vault doesn't have one (falls back to a built-in skeleton). */
function loadNoteTemplate(vaultRoot: string, templatePath: string = TEMPLATE_RELATIVE_PATH): string | null {
  const fullPath = `${vaultRoot}/${templatePath}`
  if (!existsSync(fullPath)) return null
  return readFileSync(fullPath, 'utf-8')
}

type VaultSettings = {
  root: string
  dailyNotesFolder: string
  notePathPattern: string
  templatePath: string
}

/** Resolves the effective vault root: env var (test/dev override) → persisted config → null. */
function resolveVaultRoot(): string | null {
  const envRoot = process.env.ATELIER_TEST_VAULT_ROOT ?? process.env.ATELIER_VAULT_ROOT ?? null
  if (envRoot) return envRoot
  const root = loadConfig().vault.root
  return root || null
}

/**
 * Resolves the full vault settings for use in IPC handlers. Vault root follows
 * the same env-var → config priority as resolveVaultRoot; layout fields always
 * come from persisted config (with defaults matching the previous hardcoded values).
 */
function resolveVaultSettings(): VaultSettings | null {
  const root = resolveVaultRoot()
  if (!root) return null
  const cfg = loadConfig().vault
  return {
    root,
    dailyNotesFolder: cfg.dailyNotesFolder,
    notePathPattern: cfg.notePathPattern,
    templatePath: cfg.templatePath
  }
}


/** Today's date as YYYY-MM-DD (local time), overridable for deterministic e2e runs. */
function resolveDefaultDate(): string {
  if (process.env.ATELIER_TEST_DATE) return process.env.ATELIER_TEST_DATE
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Shared "read-or-create-from-template" path used by both `daily-note:create`
 * and `daily-note:move-task` (16-task-move-to-date): if `date`'s note already
 * exists, reads/parses it as-is; otherwise scaffolds it via the same
 * template-fill logic `daily-note:create` has always used
 * (`generateNewNote`/`loadNoteTemplate`), optionally running the UC-2
 * carry-over scan (`findMostRecentNoteDate`/`collectCarryOverTasks`) —
 * extracted here so the move-task path doesn't duplicate/diverge from normal
 * note-creation behavior.
 *
 * `carryOver` (default `true`) controls whether that scan runs when the note
 * has to be created. `daily-note:create` always wants it (that's the
 * existing, correct UC-2 behavior for "navigate to a date"). `daily-note:move-task`
 * passes `{ carryOver: false }`: per
 * fix-move-task-creates-note-with-carryover, creating a target note purely to
 * receive one explicitly-moved task must NOT also drag forward every other
 * open task from the source note — the user only asked to move the one task
 * they right-clicked. The target note should come from the template with
 * empty sections, with just that one task appended afterward by the caller.
 */
async function ensureNoteExists(
  date: string,
  settings: VaultSettings,
  options?: { carryOver?: boolean }
): Promise<{ note: DailyNote; raw: RawSections; path: string; created: boolean }> {
  const carryOver = options?.carryOver ?? true
  const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
  if (existsSync(path)) {
    const content = await readFile(path, 'utf-8')
    const { note, raw, mintedIds } = parseDailyNote(content, date)
    persistMintedGids(path, note, raw, mintedIds)
    recordKnownIds(path, getTaskIds(note))
    return { note, raw, path, created: false }
  }

  let carriedTasks: DailyTask[] = []
  if (carryOver) {
    const priorDate = findMostRecentNoteDate(date, settings)
    if (priorDate) {
      const priorPath = resolveNotePath(priorDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
      const priorContent = await readFile(priorPath, 'utf-8')
      const { note: priorNote, raw: priorRaw, mintedIds: priorMintedIds } = parseDailyNote(priorContent, priorDate)
      persistMintedGids(priorPath, priorNote, priorRaw, priorMintedIds)
      carriedTasks = collectCarryOverTasks(priorNote)
      logger.info('daily-note create: carrying tasks forward', {
        path,
        priorDate,
        priorPath,
        carriedIds: carriedTasks.map((t) => t.id)
      })
    }
  }

  const content = generateNewNote(date, carriedTasks, loadNoteTemplate(settings.root, settings.templatePath))
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf-8')
  recordWrittenContent(path, content)
  const { note, raw } = parseDailyNote(content, date)
  recordKnownIds(path, getTaskIds(note))
  logger.info('daily-note created', { path, carryOver })
  return { note, raw, path, created: true }
}

function vaultRelativePath(absPath: string, vaultRoot: string): string {
  const root = vaultRoot.replace(/\/$/, '')
  if (absPath.startsWith(`${root}/`)) return absPath.slice(root.length + 1)
  if (absPath.startsWith(root)) return absPath.slice(root.length).replace(/^\//, '')
  return absPath
}

async function readNotesSliceForDate(
  date: string,
  settings: VaultSettings,
  createIfMissing: boolean
): Promise<DailyNoteNotesSliceResult> {
  const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
  const rel = vaultRelativePath(path, settings.root)
  let created = false

  if (!existsSync(path)) {
    if (!createIfMissing) {
      return { exists: false, notesBody: '', vaultRelativePath: rel, created: false, notesSectionHeading: DEFAULT_NOTES_SECTION_HEADING }
    }
    await ensureNoteExists(date, settings)
    created = true
  }

  const content = await readFile(path, 'utf-8')
  const { note, raw, mintedIds } = parseDailyNote(content, date)
  persistMintedGids(path, note, raw, mintedIds)
  recordKnownIds(path, getTaskIds(note))
  const { notesBody, notesHeadingLine } = extractNotesBodyFromAfterTasks(raw.afterTasks)
  logger.info('daily-note read notes slice', { path, created, bodyLength: notesBody.length })
  return {
    exists: true,
    notesBody,
    vaultRelativePath: rel,
    created,
    notesSectionHeading: notesHeadingLine ?? DEFAULT_NOTES_SECTION_HEADING
  }
}

export function registerDailyNoteHandlers(getMainWindow: () => BrowserWindow | null): void {
  const isTestMode = process.env.ATELIER_TEST_VAULT_ROOT !== undefined

  ipcMain.handle('daily-note:getVaultRoot', () => resolveVaultRoot())
  ipcMain.handle('daily-note:getDefaultDate', () => resolveDefaultDate())

  ipcMain.handle('daily-note:pickVaultRoot', async () => {
    const win = getMainWindow()
    const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('daily-note:read', async (_event, date: string) => {
    const settings = resolveVaultSettings()
    if (!settings) return { note: null, raw: null, exists: false }

    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
    if (!existsSync(path)) return { note: null, raw: null, exists: false }

    const content = await readFile(path, 'utf-8')
    const { note, raw, mintedIds } = parseDailyNote(content, date)
    persistMintedGids(path, note, raw, mintedIds)
    recordKnownIds(path, getTaskIds(note))
    logger.info('daily-note read', { path, taskCount: note.tasks.length })
    return { note, raw, exists: true }
  })

  ipcMain.handle('daily-note:read-notes-slice', async (_event, date: string, createIfMissing?: boolean) => {
    const settings = resolveVaultSettings()
    if (!settings) throw new Error('no vault root configured (ATELIER_VAULT_ROOT / Settings → Vault)')
    return readNotesSliceForDate(date, settings, Boolean(createIfMissing))
  })

  ipcMain.handle('daily-note:write-notes-slice', async (_event, date: string, notesBody: string) => {
    const settings = resolveVaultSettings()
    if (!settings) throw new Error('no vault root configured')

    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
    if (!existsSync(path)) throw new Error(`daily note not found for ${date}`)

    const freshContent = await readFile(path, 'utf-8')
    const parsed = parseDailyNote(freshContent, date)
    persistMintedGids(path, parsed.note, parsed.raw, parsed.mintedIds)
    recordKnownIds(path, getTaskIds(parsed.note))

    const mergedAfter = mergeNotesBodyIntoAfterTasks(parsed.raw.afterTasks, notesBody)
    const newRaw: RawSections = { ...parsed.raw, afterTasks: mergedAfter }
    const serialized = serializeDailyNote(parsed.note, newRaw)

    const tmpPath = `${path}.tmp`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmpPath, serialized, 'utf-8')
    renameSync(tmpPath, path)
    recordWrittenContent(path, serialized)
    recordKnownIds(path, getTaskIds(parsed.note))
    logger.info('daily-note write notes slice committed', { path, bodyLength: notesBody.length })
    return { ok: true as const }
  })

  ipcMain.handle('daily-note:create', async (_event, date: string) => {
    const settings = resolveVaultSettings()
    if (!settings) throw new Error('no vault root configured (ATELIER_VAULT_ROOT / ATELIER_TEST_VAULT_ROOT / Settings → Vault)')
    const { note, raw } = await ensureNoteExists(date, settings)
    return { note, raw, exists: true }
  })

  // 16-task-move-to-date: moves a single task from `sourceDate`'s note to
  // `targetDate`'s note's Backlog section, creating the target note from the
  // template first if needed (via the shared ensureNoteExists path above).
  // Both files are read/rewritten directly here rather than going through
  // `daily-note:write`'s tombstone-diff pipeline, mirroring how
  // `daily-note:create` already writes brand-new notes directly.
  ipcMain.handle(
    'daily-note:move-task',
    async (_event, sourceDate: string, taskId: string, targetDate: string) => {
      const settings = resolveVaultSettings()
      if (!settings) throw new Error('no vault root configured')

      const sourcePath = resolveNotePath(sourceDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
      const targetPath = resolveNotePath(targetDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern)

      if (!existsSync(sourcePath)) throw new Error(`source note not found: ${sourcePath}`)
      const sourceContent = await readFile(sourcePath, 'utf-8')
      const { note: sourceNote, raw: sourceRaw, mintedIds: sourceMintedIds } = parseDailyNote(sourceContent, sourceDate)
      // fix-gidless-task-id-not-persisted: persist unconditionally, right
      // after parsing and before the not-found check / same-file no-op
      // below — this handler does its OWN independent parse of the source
      // note, decoupled from whatever id the renderer captured earlier. If
      // this parse is the first to ever see a gid-less task line, it must
      // not lose that minted id on an early return/throw; the normal
      // "rewrite source note with task removed" write further down already
      // carries these same ids, but persisting here too guarantees the
      // invariant holds even when that later write doesn't happen (task not
      // found, or source === target no-op).
      persistMintedGids(sourcePath, sourceNote, sourceRaw, sourceMintedIds)
      const task = sourceNote.tasks.find((t) => t.id === taskId)
      if (!task) {
        // fix-move-task-not-found-in-source-note: this is the renderer
        // trusting a possibly-stale id (e.g. a Timeline "Move to..." menu
        // opened before an external edit regenerated/removed that task's
        // gid — see Timeline.tsx's moveMenu-close useEffect for the other
        // half of this fix). Log it with the ids actually on disk right
        // now so a real report (like the one that motivated this fix) is
        // diagnosable from main.log alone, not just the renderer's raw
        // console error.
        logger.info('daily-note move-task: task not found in source note', {
          sourcePath,
          taskId,
          sourceDate,
          targetDate,
          freshIds: sourceNote.tasks.map((t) => t.id)
        })
        throw new Error(`task not found in source note: ${taskId}`)
      }

      // Defensive no-op (spec): source and target resolve to the same file.
      // Not realistically reachable via the menu (which only offers future
      // dates relative to the note being viewed), but guard against
      // duplicating/deleting the task incorrectly if it ever is.
      if (sourcePath === targetPath) {
        logger.info('daily-note move-task: source/target resolve to the same file, no-op', {
          sourcePath,
          taskId
        })
        return { sourceNote, targetNote: sourceNote }
      }

      // Write the source note FIRST, with the task already removed, before
      // touching the target. fix-move-task-creates-note-with-carryover: the
      // target note's creation below now runs with carry-over disabled
      // entirely, so this ordering is no longer load-bearing for duplicate
      // prevention — but it's still the more sensible sequencing (the
      // source's mutation is unconditional, the target's creation may fail
      // independently) so it's kept as-is.
      const updatedSourceNote: DailyNote = {
        ...sourceNote,
        tasks: sourceNote.tasks.filter((t) => t.id !== taskId)
      }
      const sourceSerialized = serializeDailyNote(updatedSourceNote, sourceRaw)
      mkdirSync(dirname(sourcePath), { recursive: true })
      const sourceTmp = `${sourcePath}.tmp`
      writeFileSync(sourceTmp, sourceSerialized, 'utf-8')
      renameSync(sourceTmp, sourcePath)
      recordWrittenContent(sourcePath, sourceSerialized)
      recordKnownIds(sourcePath, getTaskIds(updatedSourceNote))

      // fix-move-task-creates-note-with-carryover: creating the target note
      // via this side door must NOT run the UC-2 carry-over scan — only the
      // one task the user explicitly chose to move should land in it. If the
      // target note doesn't exist yet, it's scaffolded purely from the vault
      // template with empty sections, and the moved task is appended below.
      const { note: targetNoteBefore, raw: targetRaw } = await ensureNoteExists(targetDate, settings, {
        carryOver: false
      })

      // Backlog items aren't scheduled to a time slot — strip the time-block.
      // Text, tags, and done-state carry over unchanged.
      const movedTask: DailyTask = { ...task, section: 'unscheduled', timeBlock: undefined }

      const updatedTargetNote: DailyNote = {
        ...targetNoteBefore,
        tasks: [...targetNoteBefore.tasks, movedTask]
      }
      const targetSerialized = serializeDailyNote(updatedTargetNote, targetRaw)

      mkdirSync(dirname(targetPath), { recursive: true })
      const targetTmp = `${targetPath}.tmp`
      writeFileSync(targetTmp, targetSerialized, 'utf-8')
      renameSync(targetTmp, targetPath)
      recordWrittenContent(targetPath, targetSerialized)
      recordKnownIds(targetPath, getTaskIds(updatedTargetNote))

      logger.info('daily-note move-task committed', {
        sourcePath,
        targetPath,
        taskId,
        sourceDate,
        targetDate
      })

      return { sourceNote: updatedSourceNote, targetNote: updatedTargetNote }
    }
  )

  ipcMain.handle('daily-note:write', async (_event, date: string, incoming: DailyNote) => {
    const settings = resolveVaultSettings()
    if (!settings) throw new Error('no vault root configured')

    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
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
    recordWrittenContent(path, serialized)

    // Prune confirmed-gone ids, then record everything we just wrote as known.
    for (const id of tombstoned) everKnown.delete(id)
    recordKnownIds(path, getTaskIds(toWrite))
    logger.info('daily-note write committed', { path, taskCount: toWrite.tasks.length })

    return { note: toWrite }
  })

  ipcMain.handle('daily-note:watch', (_event, date: string) => {
    const settings = resolveVaultSettings()
    if (!settings) return

    if (activeWatcher) {
      activeWatcher.close()
      activeWatcher = null
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }

    const path = resolveNotePath(date, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
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

          // Self-write echo suppression: if the content on disk is exactly
          // what this process itself most recently wrote to this path, this
          // fs event is a stale/coalesced notification for our own write
          // (e.g. the create-then-immediately-watch race), not a genuine
          // external edit. Pushing it anyway would stomp any newer in-memory
          // edit and cancel its pending write — see
          // fix-note-content-reverts-to-template-on-edit. Skip the push (and
          // leave any pending renderer write timer alone) in that case.
          if (lastWrittenContent.get(path) === content) {
            logger.info('daily-note watcher: suppressed self-write echo', { path })
            return
          }

          const { note, raw, mintedIds } = parseDailyNote(content, date)
          // fix-gidless-task-id-not-persisted: persist BEFORE recording known
          // ids / pushing to the renderer. This does its own temp-file +
          // rename write and records it via recordWrittenContent, so the fs
          // event it triggers is caught by the self-write-echo check above on
          // the NEXT invocation of notifyChange — it won't recurse into this
          // one (that check already ran for the event we're handling now).
          persistMintedGids(path, note, raw, mintedIds)
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
