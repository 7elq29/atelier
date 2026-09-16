import { ipcMain } from 'electron'
import { join, relative, resolve } from 'node:path'
import { openDatabase } from '../db'
import { logger } from '../logger'
import type { AppNoteUpdate } from '../../shared/app-note-types'
import { loadConfig, saveConfig } from '../config'
import { AppNoteFileStore } from './file-store'
import { AppNotesStore } from './store'

let store: AppNotesStore | undefined

function notesStore(): AppNotesStore {
  if (!store) store = new AppNotesStore(openDatabase())
  return store
}

function fileStore(): AppNoteFileStore {
  const { root: configuredRoot, appNotesFolder } = loadConfig().vault
  const root = process.env.ATELIER_TEST_VAULT_ROOT || process.env.ATELIER_VAULT_ROOT || configuredRoot
  if (!root.trim()) throw new Error('no Obsidian vault configured for Atelier notes')
  const notesRoot = resolve(root, appNotesFolder || 'Atelier')
  const vaultRoot = resolve(root)
  if (relative(vaultRoot, notesRoot).startsWith('..')) {
    throw new Error('Atelier notes folder must be inside the configured Obsidian vault')
  }
  return new AppNoteFileStore(notesRoot)
}

function migrateLegacyNotes(target: AppNoteFileStore): void {
  if (loadConfig().vault.appNotesMigrated) return
  const existingIds = new Set(target.list().map((note) => note.id))
  for (const note of notesStore().list()) {
    if (existingIds.has(note.id)) continue
    target.import(note)
  }
  const config = loadConfig()
  saveConfig({ vault: { ...config.vault, appNotesMigrated: true } })
}

export function registerAppNotesHandlers(): void {
  ipcMain.handle('app-note:list', () => {
    const target = fileStore()
    migrateLegacyNotes(target)
    return target.list()
  })

  ipcMain.handle('app-note:get', (_event, id: string) => {
    const note = fileStore().get(id)
    if (!note) throw new Error(`app note not found: ${id}`)
    return note
  })

  ipcMain.handle('app-note:create', (_event, title?: string) => {
    const note = fileStore().create(title)
    logger.info('app-note created', { id: note.id })
    return note
  })

  ipcMain.handle('app-note:update', (_event, id: string, patch: AppNoteUpdate) => {
    const note = fileStore().update(id, patch)
    if (!note) throw new Error(`app note not found: ${id}`)
    logger.info('app-note updated', { id, fields: Object.keys(patch) })
    return note
  })

  ipcMain.handle('app-note:delete', (_event, id: string, permanently = false) => {
    if (!fileStore().delete(id, permanently)) throw new Error(`app note not found: ${id}`)
    logger.info('app-note deleted', { id, permanently })
  })
}
