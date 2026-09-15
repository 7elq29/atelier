import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { SessionChangesCapItem } from '../../../../shared/session-changes-cap'
import type { SessionBookmark } from '../../../../shared/session-bookmarks'
import { isClaudePlanPath } from '../../../../shared/claude-plan-path'
import ChatBookmarkContextMenu, { type ChatBookmarkMenuState } from './ChatBookmarkContextMenu'

function basenamePath(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

function ChatChangesFileRow({
  path,
  additions,
  deletions,
  opensInFilesTab,
  bookmarked,
  onOpen
}: {
  path: string
  additions: number
  deletions: number
  opensInFilesTab: boolean
  bookmarked: boolean
  onOpen: (path: string, opensInFilesTab: boolean) => void
}): JSX.Element {
  const isPlan = isClaudePlanPath(path)
  return (
    <div
      className={`chat-changes-file${isPlan ? ' chat-changes-file-plan' : ''}`}
      role="button"
      tabIndex={0}
      data-testid="chat-changes-file"
      data-path={path}
      data-opens-in-files-tab={opensInFilesTab ? 'true' : 'false'}
      data-is-plan={isPlan ? 'true' : 'false'}
      data-bookmarked={bookmarked ? 'true' : 'false'}
      onClick={() => onOpen(path, opensInFilesTab)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(path, opensInFilesTab)
        }
      }}
    >
      <span className="fname">{basenamePath(path)}</span>
      {isPlan ? (
        <span className="chat-changes-plan-tag" data-testid="chat-changes-plan-tag">
          Plan
        </span>
      ) : null}
      {bookmarked ? <BookmarkTag /> : null}
      <span className="chat-changes-stats">
        {additions > 0 && <span className="chat-changes-add">+{additions}</span>}
        {deletions > 0 && <span className="chat-changes-del">−{deletions}</span>}
      </span>
    </div>
  )
}

function BookmarkTag(): JSX.Element {
  return (
    <span className="chat-changes-bookmark-tag" data-testid="chat-changes-bookmark-tag">
      Bookmark
    </span>
  )
}

function bookmarkMatchesPath(bookmarkTarget: string, workspaceRoot: string, path: string): boolean {
  const normalize = (value: string): string =>
    value.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = normalize(bookmarkTarget)
  const capPath = normalize(path)
  if (target === capPath) return true
  const relative = capPath.replace(/^\/+/, '')
  return target === relative || target === `${normalize(workspaceRoot)}/${relative}`
}

function BookmarkRow({
  bookmark,
  onOpen,
  onContextMenu
}: {
  bookmark: SessionBookmark
  onOpen: (bookmark: SessionBookmark) => void
  onContextMenu: (event: MouseEvent, bookmark: SessionBookmark) => void
}): JSX.Element {
  let label = bookmark.label
  if (!label && bookmark.kind === 'link') {
    try {
      label = new URL(bookmark.target).host
    } catch {
      label = bookmark.target
    }
  }
  if (bookmark.kind === 'file') label = basenamePath(bookmark.target)

  return (
    <div
      className="chat-changes-file chat-bookmark-row"
      role="button"
      tabIndex={0}
      data-testid="chat-bookmark-row"
      data-bookmark-kind={bookmark.kind}
      data-target={bookmark.target}
      title={bookmark.target}
      onClick={() => onOpen(bookmark)}
      onContextMenu={(event) => onContextMenu(event, bookmark)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen(bookmark)
        }
      }}
    >
      <span className="fname">{label || bookmark.target}</span>
      <BookmarkTag />
    </div>
  )
}

export default function ChatUncommittedChanges({
  items,
  bookmarks,
  workspaceRoot,
  onOpenFile,
  onOpenBookmark,
  onRemoveBookmark
}: {
  items: SessionChangesCapItem[] | null | undefined
  bookmarks: readonly SessionBookmark[]
  workspaceRoot: string
  onOpenFile: (path: string, opensInFilesTab: boolean) => void
  onOpenBookmark: (bookmark: SessionBookmark) => void
  onRemoveBookmark: (bookmark: SessionBookmark) => void
}): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const [openList, setOpenList] = useState<'bookmarks' | 'changes' | null>(null)
  const [bookmarkMenu, setBookmarkMenu] = useState<ChatBookmarkMenuState | null>(null)

  const rows = items ?? []
  const changedBookmarks = new Set(
    bookmarks
      .filter((bookmark) => bookmark.kind === 'file')
      .flatMap((bookmark) =>
        rows
          .filter((row) => bookmarkMatchesPath(bookmark.target, workspaceRoot, row.path))
          .map((row) => row.path)
      )
  )
  const standaloneBookmarks = bookmarks.filter(
    (bookmark) =>
      bookmark.kind === 'link' ||
      !rows.some((row) => bookmarkMatchesPath(bookmark.target, workspaceRoot, row.path))
  )

  useEffect(() => {
    if (!openList) return
    const closeOnOutsideClick = (event: globalThis.MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenList(null)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenList(null)
    }
    document.addEventListener('mousedown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [openList])

  useEffect(() => {
    if (openList === 'bookmarks' && standaloneBookmarks.length === 0) setOpenList(null)
    if (openList === 'changes' && rows.length === 0) setOpenList(null)
  }, [openList, rows.length, standaloneBookmarks.length])

  if (rows.length === 0 && standaloneBookmarks.length === 0) return null

  const activeRows = openList === 'bookmarks' ? standaloneBookmarks.length : rows.length
  const activeTitle =
    openList === 'bookmarks'
      ? `${activeRows} bookmark${activeRows === 1 ? '' : 's'}`
      : `${activeRows} change${activeRows === 1 ? '' : 's'}`

  return (
    <div className="composer-context-actions" data-testid="composer-context-actions" ref={rootRef}>
      {standaloneBookmarks.length > 0 && (
        <button
          type="button"
          className={`composer-context-action${openList === 'bookmarks' ? ' active' : ''}`}
          data-testid="composer-bookmarks-button"
          title={`${standaloneBookmarks.length} bookmark${standaloneBookmarks.length === 1 ? '' : 's'}`}
          aria-label={`${standaloneBookmarks.length} bookmark${standaloneBookmarks.length === 1 ? '' : 's'}`}
          aria-expanded={openList === 'bookmarks'}
          onClick={() => setOpenList((current) => (current === 'bookmarks' ? null : 'bookmarks'))}
        >
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
            <path d="M6 3h12v18l-6-4-6 4V3z" />
          </svg>
          <span className="composer-context-count" data-testid="composer-context-count">
            {standaloneBookmarks.length}
          </span>
        </button>
      )}
      {rows.length > 0 && (
        <button
          type="button"
          className={`composer-context-action${openList === 'changes' ? ' active' : ''}`}
          data-testid="composer-changes-button"
          title={`${rows.length} change${rows.length === 1 ? '' : 's'}`}
          aria-label={`${rows.length} change${rows.length === 1 ? '' : 's'}`}
          aria-expanded={openList === 'changes'}
          onClick={() => setOpenList((current) => (current === 'changes' ? null : 'changes'))}
        >
          <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
            <path d="M4 7h16M4 12h16M4 17h10" />
            <circle cx="18" cy="17" r="2" />
          </svg>
          <span className="composer-context-count" data-testid="composer-context-count">
            {rows.length}
          </span>
        </button>
      )}
      {openList && (
        <div
          className="chat-changes-popover"
          data-testid="chat-uncommitted-changes"
          data-list-kind={openList}
        >
          <div className="chat-changes-popover-title">{activeTitle}</div>
          <div data-testid={openList === 'bookmarks' ? 'chat-changes-bookmarks' : 'chat-changes-files'}>
            {openList === 'bookmarks'
              ? standaloneBookmarks.map((bookmark) => (
                  <BookmarkRow
                    key={`bookmark:${bookmark.kind}:${bookmark.target}`}
                    bookmark={bookmark}
                    onOpen={(selected) => {
                      setOpenList(null)
                      onOpenBookmark(selected)
                    }}
                    onContextMenu={(event, selectedBookmark) => {
                      event.preventDefault()
                      event.stopPropagation()
                      setBookmarkMenu({
                        x: event.clientX,
                        y: event.clientY,
                        bookmark: selectedBookmark
                      })
                    }}
                  />
                ))
              : rows.map((row) => (
                  <ChatChangesFileRow
                    key={`file:${row.path}`}
                    path={row.path}
                    additions={row.additions}
                    deletions={row.deletions}
                    opensInFilesTab={row.opensInFilesTab}
                    bookmarked={changedBookmarks.has(row.path)}
                    onOpen={(path, opensInFilesTab) => {
                      setOpenList(null)
                      onOpenFile(path, opensInFilesTab)
                    }}
                  />
                ))}
          </div>
        </div>
      )}
      {bookmarkMenu ? (
        <ChatBookmarkContextMenu
          state={bookmarkMenu}
          bookmarked
          onToggle={(bookmark) => {
            const selected = bookmarks.find(
              (item) => item.kind === bookmark.kind && item.target === bookmark.target
            )
            if (selected) onRemoveBookmark(selected)
          }}
          onClose={() => setBookmarkMenu(null)}
        />
      ) : null}
    </div>
  )
}
