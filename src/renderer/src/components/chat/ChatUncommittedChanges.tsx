import { useState, type ReactNode } from 'react'
import type { SessionChangesCapItem } from '../../../../shared/session-changes-cap'
import type { SessionBookmark } from '../../../../shared/session-bookmarks'
import { isClaudePlanPath } from '../../../../shared/claude-plan-path'

function basenamePath(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

function ChevronDown(): JSX.Element {
  return (
    <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
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
  onOpen
}: {
  bookmark: SessionBookmark
  onOpen: (bookmark: SessionBookmark) => void
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

function ChatChangesSection({
  testId,
  title,
  collapsed,
  onToggle,
  children
}: {
  testId: string
  title: string
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <section
      className={`chat-changes-section${collapsed ? ' collapsed' : ''}`}
      data-testid={testId}
    >
      <div className="chat-changes-head">
        <button
          type="button"
          className="chat-changes-toggle"
          aria-expanded={!collapsed}
          onClick={onToggle}
        >
          <span className="chat-changes-chev">
            <ChevronDown />
          </span>
          <span className="chat-changes-title">{title}</span>
        </button>
      </div>
      {!collapsed && <div className="chat-changes-body">{children}</div>}
    </section>
  )
}

export default function ChatUncommittedChanges({
  items,
  bookmarks,
  workspaceRoot,
  onOpenFile,
  onOpenBookmark
}: {
  items: SessionChangesCapItem[] | null | undefined
  bookmarks: readonly SessionBookmark[]
  workspaceRoot: string
  onOpenFile: (path: string, opensInFilesTab: boolean) => void
  onOpenBookmark: (bookmark: SessionBookmark) => void
}): JSX.Element | null {
  // Held here, not per section, so a list that empties and refills reopens as the user left it.
  const [bookmarksCollapsed, setBookmarksCollapsed] = useState(true)
  const [filesCollapsed, setFilesCollapsed] = useState(true)

  const rows = items ?? []
  if (rows.length === 0 && bookmarks.length === 0) return null

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

  return (
    <div className="chat-changes-card" data-testid="chat-uncommitted-changes">
      {standaloneBookmarks.length > 0 && (
        <ChatChangesSection
          key="bookmarks"
          testId="chat-changes-bookmarks"
          title={`${standaloneBookmarks.length} bookmark${standaloneBookmarks.length === 1 ? '' : 's'}`}
          collapsed={bookmarksCollapsed}
          onToggle={() => setBookmarksCollapsed((c) => !c)}
        >
          {standaloneBookmarks.map((bookmark) => (
            <BookmarkRow
              key={`bookmark:${bookmark.kind}:${bookmark.target}`}
              bookmark={bookmark}
              onOpen={onOpenBookmark}
            />
          ))}
        </ChatChangesSection>
      )}
      {rows.length > 0 && (
        <ChatChangesSection
          key="files"
          testId="chat-changes-files"
          title={`${rows.length} change${rows.length === 1 ? '' : 's'}`}
          collapsed={filesCollapsed}
          onToggle={() => setFilesCollapsed((c) => !c)}
        >
          {rows.map((row) => (
            <ChatChangesFileRow
              key={`file:${row.path}`}
              path={row.path}
              additions={row.additions}
              deletions={row.deletions}
              opensInFilesTab={row.opensInFilesTab}
              bookmarked={changedBookmarks.has(row.path)}
              onOpen={onOpenFile}
            />
          ))}
        </ChatChangesSection>
      )}
    </div>
  )
}
