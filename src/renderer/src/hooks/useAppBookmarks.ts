import { useCallback, useEffect, useState } from 'react'
import type { AppBookmarkInput, AppBookmarkRecord, AppBookmarkUpdate } from '../../../shared/app-bookmark-types'

export function useAppBookmarks(): {
  bookmarks: AppBookmarkRecord[]
  createBookmark: (input: AppBookmarkInput) => Promise<AppBookmarkRecord>
  updateBookmark: (id: string, patch: AppBookmarkUpdate) => Promise<AppBookmarkRecord>
  deleteBookmark: (id: string) => Promise<void>
} {
  const [bookmarks, setBookmarks] = useState<AppBookmarkRecord[]>([])

  useEffect(() => {
    void window.atelier.listAppBookmarks().then(setBookmarks)
  }, [])

  const createBookmark = useCallback(async (input: AppBookmarkInput) => {
    const bookmark = await window.atelier.createAppBookmark(input)
    // The store returns the existing row for a duplicate URL, so replace by id.
    setBookmarks((prev) =>
      prev.some((b) => b.id === bookmark.id) ? prev.map((b) => (b.id === bookmark.id ? bookmark : b)) : [...prev, bookmark]
    )
    return bookmark
  }, [])

  const updateBookmark = useCallback(async (id: string, patch: AppBookmarkUpdate) => {
    const bookmark = await window.atelier.updateAppBookmark(id, patch)
    setBookmarks((prev) => prev.map((b) => (b.id === id ? bookmark : b)))
    return bookmark
  }, [])

  const deleteBookmark = useCallback(async (id: string) => {
    setBookmarks((prev) => prev.filter((b) => b.id !== id))
    await window.atelier.deleteAppBookmark(id)
  }, [])

  return { bookmarks, createBookmark, updateBookmark, deleteBookmark }
}
