import { ipcMain } from 'electron'
import { openDatabase } from '../db'
import { logger } from '../logger'
import {
  isSupportedBookmarkUrl,
  normalizeBookmarkUrl,
  type AppBookmarkInput,
  type AppBookmarkUpdate
} from '../../shared/app-bookmark-types'
import { AppBookmarksStore } from './store'

let store: AppBookmarksStore | undefined

function bookmarksStore(): AppBookmarksStore {
  if (!store) store = new AppBookmarksStore(openDatabase())
  return store
}

function requireUrl(raw: string): string {
  const url = normalizeBookmarkUrl(raw ?? '')
  if (!isSupportedBookmarkUrl(url)) throw new Error(`unsupported bookmark URL: ${raw}`)
  return url
}

export function registerAppBookmarksHandlers(): void {
  ipcMain.handle('app-bookmark:list', () => bookmarksStore().list())

  ipcMain.handle('app-bookmark:create', (_event, input: AppBookmarkInput) => {
    const bookmark = bookmarksStore().create({
      url: requireUrl(input?.url),
      title: (input?.title ?? '').trim()
    })
    logger.info('app-bookmark created', { id: bookmark.id, url: bookmark.url })
    return bookmark
  })

  ipcMain.handle('app-bookmark:update', (_event, id: string, patch: AppBookmarkUpdate) => {
    const bookmark = bookmarksStore().update(id, {
      ...(patch.url !== undefined ? { url: requireUrl(patch.url) } : {}),
      ...(patch.title !== undefined ? { title: patch.title.trim() } : {})
    })
    if (!bookmark) throw new Error(`app bookmark not found: ${id}`)
    logger.info('app-bookmark updated', { id: bookmark.id, url: bookmark.url })
    return bookmark
  })

  ipcMain.handle('app-bookmark:delete', (_event, id: string) => {
    if (!bookmarksStore().delete(id)) throw new Error(`app bookmark not found: ${id}`)
    logger.info('app-bookmark deleted', { id })
  })
}
