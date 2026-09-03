import { useCallback, useEffect, useState } from 'react'
import type {
  CreateSessionBookmarkInput,
  SessionBookmark,
  SessionBookmarkKind
} from '../../../shared/session-bookmarks'

export function useSessionBookmarks(): {
  bookmarksBySession: Record<string, SessionBookmark[]>
  hydrate: (sessionId: string) => Promise<void>
  add: (sessionId: string, input: CreateSessionBookmarkInput) => Promise<void>
  remove: (sessionId: string, kind: SessionBookmarkKind, target: string) => Promise<void>
  evict: (sessionId: string) => void
} {
  const [bookmarksBySession, setBookmarksBySession] = useState<Record<string, SessionBookmark[]>>({})

  const hydrate = useCallback(async (sessionId: string) => {
    const bookmarks = await window.atelier.listSessionBookmarks(sessionId)
    setBookmarksBySession((prev) => ({ ...prev, [sessionId]: bookmarks }))
  }, [])

  const add = useCallback(async (sessionId: string, input: CreateSessionBookmarkInput) => {
    const bookmarks = await window.atelier.addSessionBookmark(sessionId, input)
    setBookmarksBySession((prev) => ({ ...prev, [sessionId]: bookmarks }))
  }, [])

  const remove = useCallback(
    async (sessionId: string, kind: SessionBookmarkKind, target: string) => {
      const bookmarks = await window.atelier.removeSessionBookmark(sessionId, kind, target)
      setBookmarksBySession((prev) => ({ ...prev, [sessionId]: bookmarks }))
    },
    []
  )

  const evict = useCallback((sessionId: string) => {
    setBookmarksBySession((prev) => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [])

  useEffect(
    () =>
      window.atelier.onSessionBookmarksUpdated(({ sessionId, bookmarks }) => {
        setBookmarksBySession((prev) => ({ ...prev, [sessionId]: bookmarks }))
      }),
    []
  )

  return { bookmarksBySession, hydrate, add, remove, evict }
}
