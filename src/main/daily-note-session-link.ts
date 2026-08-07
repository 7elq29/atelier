/**
 * Bidirectional link between a daily-note task (gid + `[session:: id]` in the
 * vault) and a session row (`linked_daily_task_gid` / `linked_daily_note_date`).
 */
import type { BrowserWindow } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DailyNote } from '../shared/daily-note-types'
import { parseDailyNote, serializeDailyNote, resolveNotePath, getTaskIds } from './daily-note-io'
import type { SessionStore } from './sessions/store'
import { logger } from './logger'
import {
  notifyDailyNoteChanged,
  persistMintedGids,
  readVaultSettings,
  recordKnownIdsForPath,
  recordWrittenContentForPath
} from './daily-notes-handlers'

async function writeNoteAtPath(path: string, date: string, note: DailyNote, raw: ReturnType<typeof parseDailyNote>['raw']): Promise<void> {
  const serialized = serializeDailyNote(note, raw)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, serialized, 'utf-8')
  renameSync(tmp, path)
  recordWrittenContentForPath(path, serialized)
  recordKnownIdsForPath(path, getTaskIds(note))
  logger.info('daily-note session-link write', { path, taskCount: note.tasks.length })
}

export async function linkDailyTaskToSession(
  store: SessionStore,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string,
  noteDate: string,
  taskGid: string
): Promise<DailyNote> {
  const settings = readVaultSettings()
  if (!settings) throw new Error('no vault root configured')

  const path = resolveNotePath(noteDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
  if (!existsSync(path)) throw new Error(`daily note not found: ${noteDate}`)

  const content = await readFile(path, 'utf-8')
  const { note, raw, mintedIds } = parseDailyNote(content, noteDate)
  persistMintedGids(path, note, raw, mintedIds)

  const task = note.tasks.find((t) => t.id === taskGid)
  if (!task) throw new Error(`task not found: ${taskGid}`)

  const previousSessionId = task.linkedSessionId
  if (previousSessionId && previousSessionId !== sessionId) {
    store.clearLinkedDailyTask(previousSessionId)
  }

  const updatedTasks = note.tasks.map((t) =>
    t.id === taskGid ? { ...t, linkedSessionId: sessionId } : t
  )
  const updatedNote: DailyNote = { ...note, tasks: updatedTasks }
  await writeNoteAtPath(path, noteDate, updatedNote, raw)

  store.setLinkedDailyTask(sessionId, taskGid, noteDate)
  notifyDailyNoteChanged(getMainWindow, updatedNote)
  return updatedNote
}

export async function completeLinkedDailyTask(
  store: SessionStore,
  getMainWindow: () => BrowserWindow | null,
  sessionId: string
): Promise<DailyNote | null> {
  const session = store.getSession(sessionId)
  if (!session?.linkedDailyTaskGid || !session.linkedDailyNoteDate) return null

  const settings = readVaultSettings()
  if (!settings) throw new Error('no vault root configured')

  const noteDate = session.linkedDailyNoteDate
  const taskGid = session.linkedDailyTaskGid
  const path = resolveNotePath(noteDate, settings.root, settings.dailyNotesFolder, settings.notePathPattern)
  if (!existsSync(path)) return null

  const content = await readFile(path, 'utf-8')
  const { note, raw, mintedIds } = parseDailyNote(content, noteDate)
  persistMintedGids(path, note, raw, mintedIds)

  const updatedTasks = note.tasks.map((t) => {
    if (t.id !== taskGid) return t
    return { ...t, status: 'done' as const, completion: noteDate }
  })
  const updatedNote: DailyNote = { ...note, tasks: updatedTasks }
  await writeNoteAtPath(path, noteDate, updatedNote, raw)
  notifyDailyNoteChanged(getMainWindow, updatedNote)
  return updatedNote
}
