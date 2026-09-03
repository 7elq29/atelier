export type SessionBookmarkKind = 'file' | 'link'

export interface SessionBookmark {
  id: string
  sessionId: string
  kind: SessionBookmarkKind
  target: string
  label: string
  createdAt: string
}

export interface CreateSessionBookmarkInput {
  kind: SessionBookmarkKind
  target: string
  label: string
}

export interface SessionBookmarksUpdatedEvent {
  sessionId: string
  bookmarks: SessionBookmark[]
}

export function normalizeSessionBookmarkTarget(
  kind: SessionBookmarkKind,
  target: string
): string {
  const trimmed = target.trim()
  if (kind === 'link') {
    try {
      return new URL(trimmed).href
    } catch {
      return trimmed
    }
  }
  return trimmed.replace(/\\/g, '/')
}
