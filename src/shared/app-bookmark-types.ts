export interface AppBookmarkRecord {
  id: string
  url: string
  title: string
  createdAt: string
  updatedAt: string
  sortOrder: number
}

export interface AppBookmarkInput {
  url: string
  title?: string
}

export type AppBookmarkUpdate = Partial<Pick<AppBookmarkRecord, 'url' | 'title'>>

/** Drag payload written by chat links so the sidebar Bookmarks pane can accept a drop. */
export const APP_BOOKMARK_DRAG_MIME = 'application/x-atelier-bookmark'

export type AppBookmarkDragPayload = {
  url: string
  title: string
}

/** Adds a scheme to bare input (`docs.claude.com` -> `https://docs.claude.com`). */
export function normalizeBookmarkUrl(raw: string): string {
  const value = raw.trim()
  if (!value) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return `https://${value}`
}

export function isSupportedBookmarkUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url)
}

/** Sidebar label: the title when set, otherwise the raw URL (truncated by CSS). */
export function bookmarkLabel(bookmark: Pick<AppBookmarkRecord, 'url' | 'title'>): string {
  return bookmark.title.trim() || bookmark.url
}
