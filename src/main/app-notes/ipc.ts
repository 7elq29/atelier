import { ipcMain } from 'electron'
import { openDatabase } from '../db'
import { logger } from '../logger'
import type { AppNoteUpdate } from '../../shared/app-note-types'
import { AppNotesStore } from './store'

let store: AppNotesStore | undefined

function notesStore(): AppNotesStore {
  if (!store) store = new AppNotesStore(openDatabase())
  return store
}

export function registerAppNotesHandlers(): void {
  ipcMain.handle('app-note:list', () => notesStore().list())

  ipcMain.handle('app-note:get', (_event, id: string) => {
    const note = notesStore().get(id)
    if (!note) throw new Error(`app note not found: ${id}`)
    return note
  })

  ipcMain.handle('app-note:create', (_event, title?: string) => {
    const note = notesStore().create(title)
    logger.info('app-note created', { id: note.id })
    return note
  })

  ipcMain.handle('app-note:update', (_event, id: string, patch: AppNoteUpdate) => {
    const note = notesStore().update(id, patch)
    if (!note) throw new Error(`app note not found: ${id}`)
    return note
  })

  ipcMain.handle('app-note:delete', (_event, id: string) => {
    if (!notesStore().delete(id)) throw new Error(`app note not found: ${id}`)
    logger.info('app-note deleted', { id })
  })
}
