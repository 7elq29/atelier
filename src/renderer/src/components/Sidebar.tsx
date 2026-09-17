import { forwardRef, useEffect, useRef, useState } from 'react'
import './sidebar-utility.css'
import { SessionMenuPopup } from './SessionMenuPopup'
import { SessionStatusIndicator } from './SessionStatusIndicator'
import type { SessionGroupRecord, SessionRecord, SessionStatus } from '../../../shared/session-types'
import type { AppNoteRecord } from '../../../shared/app-note-types'
import { APP_NOTE_DRAG_MIME } from '../../../shared/app-note-attach'
import {
  APP_BOOKMARK_DRAG_MIME,
  bookmarkLabel,
  isSupportedBookmarkUrl,
  normalizeBookmarkUrl,
  type AppBookmarkDragPayload,
  type AppBookmarkInput,
  type AppBookmarkRecord,
  type AppBookmarkUpdate
} from '../../../shared/app-bookmark-types'
import { BookmarkEditModal } from './BookmarkEditModal'
import type { SessionPromptDot } from '../stores/session-prompt-dot-store'
import SpendStatusChip from './SpendStatusChip'
import { handleEmacsTextareaKeyDown } from '../palette-input-keys'
import { useSessionPromptDotsMap } from '../hooks/useSessionMessages'

interface SidebarProps {
  collapsed: boolean
  activeSessions: SessionRecord[]
  historySessions: SessionRecord[]
  activeSessionId: string | null
  onSelectSession: (session: SessionRecord) => void
  onOpenSettings: () => void
  onNewSession: () => void
  onRename: (sessionId: string, name: string) => void
  onTogglePin: (sessionId: string, pinned: boolean) => void
  onClose: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onFork: (sessionId: string) => void
  onRestart: (sessionId: string) => void
  onReconnectSession: (sessionId: string) => void

  // ── 06-session-organization ──────────────────────────────────────────
  groups: SessionGroupRecord[]
  statuses: Record<string, SessionStatus>
  staleSessionIds: Set<string>
  onSetColor: (sessionId: string, color: string) => void
  onSetNotes: (sessionId: string, notes: string) => void
  onSetProjectPath: (sessionId: string, projectPath: string) => void
  onAddTag: (sessionId: string, tag: string) => void
  onRemoveTag: (sessionId: string, tag: string) => void
  onReorderSessions: (groupId: string | null | undefined, orderedIds: string[]) => void
  onCreateGroup: (name: string) => void
  onRenameGroup: (groupId: string, name: string) => void
  onSetGroupCollapsed: (groupId: string, collapsed: boolean) => void
  onDeleteGroup: (groupId: string) => void
  onReorderGroups: (orderedIds: string[]) => void
  worktreeProgressBySession: Record<string, number>

  onOpenLocalTerminal: () => void
  terminalShellHostBySessionId: Record<string, string | null>
  appNotes: AppNoteRecord[]
  activeAppNoteId: string | null
  activeDailyNote: boolean
  weeklyPlanFileExists: boolean
  activeWeeklyPlan: boolean
  onSelectWeeklyPlanRow: () => void
  onStartWeeklyPlan: () => void
  onSelectAppNote: (noteId: string) => void
  onSelectDailyNote: () => void
  dailyNotesPanelOpen: boolean
  onToggleDailyNotesPanel: () => void
  onCreateAppNote: () => void
  onRenameAppNote: (noteId: string, title: string) => void
  onDeleteAppNote: (noteId: string) => void

  // ── sidebar-bookmarks ────────────────────────────────────────────────
  bookmarks: AppBookmarkRecord[]
  onCreateBookmark: (input: AppBookmarkInput) => void
  onUpdateBookmark: (bookmarkId: string, patch: AppBookmarkUpdate) => void
  onDeleteBookmark: (bookmarkId: string) => void
  onOpenBookmark: (url: string) => void

  /** IDs of non-active sessions that just transitioned to waiting-input and
   *  have not yet been dismissed by the user opening that session.
   *  Managed by the parent (App.tsx) so the collapsed-rail alert chips and the
   *  sidebar corner-dot use the same source of truth. */
  waitingInputAlertIds: Set<string>
  onClearWaitingInputAlert: (sessionId: string) => void
}

const SESSION_COLORS = ['--sc-blue', '--sc-green', '--sc-purple', '--sc-amber', '--sc-rose', '--sc-cyan', '--sc-indigo', '--sc-teal']

/** Stable identity glyph for terminal sessions; agent rows continue to show live status. */
function TerminalSessionIcon(): JSX.Element {
  return (
    <svg
      className="terminal-session-icon"
      data-testid="terminal-session-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  )
}

/**
 * 06-session-organization concurrent status: a session's DISPLAY status
 * folds SessionManager's live 'working'/'waiting'/'idle' (see
 * shared/session-types.ts's SessionStatus doc comment) together with two
 * things the manager doesn't track: terminal-mode sessions (no harness at
 * all) and closed claude-code sessions (same disconnected gate as startup-idle).
 */
function displayStatus(session: SessionRecord, closed: boolean, statuses: Record<string, SessionStatus>): SessionStatus {
  if (session.deletedAt) return 'cleaning-up'
  if (closed && session.mode === 'claude-code') return 'startup-idle'
  if (closed || session.mode === 'terminal') return 'disconnected'
  return statuses[session.id] ?? 'idle'
}

/** Harness is connected and between turns — not still reconnecting or offline. */
export function sessionLiveWaitingForInput(
  session: SessionRecord,
  closed: boolean,
  statuses: Record<string, SessionStatus>
): boolean {
  if (closed || session.mode !== 'claude-code') return false
  return displayStatus(session, closed, statuses) === 'waiting'
}

function sessionMetaLabel(session: SessionRecord, shellRemoteHost: string | null | undefined, dotStatus: string): string {
  if (session.mode === 'terminal') {
    if (session.hostname) return session.hostname
    return shellRemoteHost ?? 'Local'
  }
  if (dotStatus === 'waiting-blocked') return 'Needs approval'
  return session.hostname ?? session.projectPath.split('/').filter(Boolean).pop() ?? ''
}

/** Derives the CSS class suffix for the session indicator dot.
 *  When status is 'waiting', distinguishes input-wait (purple) from
 *  blocked-wait (orange) by inspecting the last assistant message.
 *  While a turn is still `working`, pending permission/question/plan cards
 *  also map to blocked-wait — the harness stays busy in canUseTool. */
function dotStatusClass(status: SessionStatus, promptDot: SessionPromptDot): string {
  if (promptDot) return promptDot
  if (status !== 'waiting') return status
  return 'waiting-input'
}

export function sessionDotStatus(
  session: SessionRecord,
  closed: boolean,
  statuses: Record<string, SessionStatus>,
  staleSessionIds: Set<string>,
  promptDot: SessionPromptDot
): string {
  return session.deletedAt
    ? 'cleaning-up'
    : staleSessionIds.has(session.id)
    ? 'stale'
    : dotStatusClass(displayStatus(session, closed, statuses), promptDot)
}

/**
 * "Needs attention" (06-session-organization) = status is 'waiting' (the
 * agent finished a turn and is waiting on the user's next instruction) OR
 * the session's most recent message is an error (a harness failure
 * surfaced as a `system` "Error: ..." message, or a tool call that ended
 * with status 'error') — documented in Features/06-session-organization/progress.md.
 */
function groupSessions(
  sessions: SessionRecord[],
  groups: SessionGroupRecord[]
): { pinned: SessionRecord[]; byGroup: Map<string, SessionRecord[]>; ungrouped: SessionRecord[] } {
  const pinned = sessions.filter((s) => s.pinned)
  const rest = sessions.filter((s) => !s.pinned)
  const byGroup = new Map<string, SessionRecord[]>()
  for (const g of groups) byGroup.set(g.id, [])
  const ungrouped: SessionRecord[] = []
  for (const s of rest) {
    if (s.groupId && byGroup.has(s.groupId)) byGroup.get(s.groupId)!.push(s)
    else ungrouped.push(s)
  }
  return { pinned, byGroup, ungrouped }
}

/** Detail popover (06-session-organization): tags, notes, and color — all in one place, anchored under the row's menu button. */
type SessionDetailPopoverProps = {
  session: SessionRecord
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
  onSetNotes: (notes: string) => void
  onSetColor: (color: string) => void
  onSetProjectPath: (projectPath: string) => void
  onClose: () => void
}

const SessionDetailPopover = forwardRef<HTMLDivElement, SessionDetailPopoverProps>(function SessionDetailPopover(
  {
    session,
    onAddTag,
    onRemoveTag,
    onSetNotes,
    onSetColor,
    onSetProjectPath,
    onClose
  },
  ref
): JSX.Element {
  const [tagDraft, setTagDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState(session.notes ?? '')
  const [pathDraft, setPathDraft] = useState(session.projectPath)

  useEffect(() => {
    setPathDraft(session.projectPath)
  }, [session.projectPath])

  function commitTag(): void {
    const trimmed = tagDraft.trim()
    if (trimmed) onAddTag(trimmed)
    setTagDraft('')
  }

  return (
    <div
      ref={ref}
      className="session-detail-popup"
      data-testid="session-detail-popover"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="sdp-section">
        <div className="sdp-label">Project path</div>
        <input
          className="input project-path-input"
          data-testid="session-project-path"
          spellCheck={false}
          value={pathDraft}
          onChange={(e) => setPathDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onSetProjectPath(pathDraft.trim())
              onClose()
            }
          }}
        />
        <button
          className="btn btn-sm btn-primary"
          data-testid="apply-project-path-button"
          style={{ marginTop: 6 }}
          disabled={!pathDraft.trim() || pathDraft.trim() === session.projectPath}
          onClick={() => {
            onSetProjectPath(pathDraft.trim())
            onClose()
          }}
        >
          Apply
        </button>
      </div>

      <div className="sdp-section">
        <div className="sdp-label">Color</div>
        <div className="sdp-colors">
          {SESSION_COLORS.map((c) => (
            <button
              key={c}
              className={'sdp-swatch' + (session.color === c ? ' selected' : '')}
              data-testid={`color-swatch-${c.replace('--sc-', '')}`}
              style={{ background: `var(${c})` }}
              title={c}
              onClick={() => onSetColor(c)}
            />
          ))}
        </div>
      </div>

      <div className="sdp-section">
        <div className="sdp-label">Tags</div>
        <div className="sdp-tags">
          {session.tags.map((tag) => (
            <span className="row-tag sdp-tag" key={tag} data-testid="tag-pill">
              {tag}
              <button
                className="sdp-tag-remove"
                data-testid={`remove-tag-${tag}`}
                onClick={() => onRemoveTag(tag)}
                aria-label={`Remove tag ${tag}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <input
          className="input sdp-tag-input"
          data-testid="tag-input"
          placeholder="Add a tag…"
          value={tagDraft}
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitTag()
            }
          }}
        />
      </div>

      <div className="sdp-section">
        <div className="sdp-label">Notes</div>
        <textarea
          className="input sdp-notes"
          data-testid="notes-textarea"
          rows={3}
          value={notesDraft}
          onChange={(e) => setNotesDraft(e.target.value)}
          onKeyDown={(e) => {
            handleEmacsTextareaKeyDown(e, notesDraft, setNotesDraft)
          }}
        />
        <button
          className="btn btn-sm btn-primary"
          data-testid="save-notes-button"
          style={{ marginTop: 6 }}
          onClick={() => {
            onSetNotes(notesDraft)
            onClose()
          }}
        >
          Save
        </button>
      </div>
    </div>
  )
})

function AppNoteRow({
  note,
  active,
  onSelect,
  onRename,
  onDelete
}: {
  note: AppNoteRecord
  active: boolean
  onSelect: () => void
  onRename: (title: string) => void
  onDelete: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(note.title)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLDivElement>(null)
  const displayTitle = note.title.trim() || 'Untitled note'

  useEffect(() => {
    setDraftTitle(note.title)
  }, [note.title])

  useEffect(() => {
    if (!menuOpen) return
    function handleOutsidePointer(e: MouseEvent): void {
      if (menuRef.current?.contains(e.target as Node)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleOutsidePointer)
    return () => document.removeEventListener('mousedown', handleOutsidePointer)
  }, [menuOpen])

  function commitRename(): void {
    setEditing(false)
    const trimmed = draftTitle.trim()
    if (trimmed !== note.title) onRename(trimmed)
    else setDraftTitle(note.title)
  }

  return (
    <div
      ref={menuAnchorRef}
      className={`session-row app-note-row${active ? ' active' : ''}`}
      data-testid="app-note-row"
      data-hint-note-row=""
      data-note-id={note.id}
      data-active={active ? 'true' : 'false'}
      draggable={!editing}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onDragStart={(e) => {
        if (editing) return
        e.dataTransfer.setData(APP_NOTE_DRAG_MIME, JSON.stringify({ id: note.id, title: displayTitle }))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen(true)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className="session-indicator" aria-hidden="true">
        <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
          <path d="M6 2h8l4 4v16H6z" />
          <path d="M14 2v4h4" />
        </svg>
      </span>
      <div className="session-main hide-on-collapse">
        {editing ? (
          <input
            className="session-name-input"
            autoFocus
            value={draftTitle}
            data-testid="app-note-rename-input"
            onChange={(e) => setDraftTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') {
                setDraftTitle(note.title)
                setEditing(false)
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="session-name" data-testid="app-note-title">
            {displayTitle}
          </div>
        )}
      </div>
      <button
        className="row-menu-btn hide-on-collapse"
        data-testid="app-note-menu-button"
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpen((v) => !v)
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <SessionMenuPopup
          anchorRef={menuAnchorRef}
          menuRef={menuRef}
          testId="app-note-menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="smi"
            data-testid="app-note-menu-rename"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
              setEditing(true)
            }}
          >
            Rename
          </div>
          <div className="sm-sep" />
          <div
            className="smi danger"
            data-testid="app-note-menu-delete"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenuOpen(false)
              onDelete()
            }}
          >
            Delete
          </div>
        </SessionMenuPopup>
      )}
    </div>
  )
}

function BookmarkRow({
  bookmark,
  onOpen,
  onEdit,
  onDelete
}: {
  bookmark: AppBookmarkRecord
  onOpen: () => void
  onEdit: () => void
  onDelete: () => void
}): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    function handleOutsidePointer(e: MouseEvent): void {
      if (menuRef.current?.contains(e.target as Node)) return
      setMenuOpen(false)
    }
    document.addEventListener('mousedown', handleOutsidePointer)
    return () => document.removeEventListener('mousedown', handleOutsidePointer)
  }, [menuOpen])

  return (
    <div
      ref={menuAnchorRef}
      className="session-row bookmark-row"
      data-testid="bookmark-row"
      data-bookmark-id={bookmark.id}
      title={bookmark.url}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen(true)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <span className="session-indicator" aria-hidden="true">
        <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
          <path d="M10 14a4.5 4.5 0 0 0 6 .4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.6 1.5" />
          <path d="M14 10a4.5 4.5 0 0 0-6-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.5-1.5" />
        </svg>
      </span>
      <div className="session-main hide-on-collapse">
        <div className="session-name" data-testid="bookmark-label">
          {bookmarkLabel(bookmark)}
        </div>
      </div>
      <button
        className="row-menu-btn hide-on-collapse"
        data-testid="bookmark-menu-button"
        title="Bookmark actions"
        onClick={(e) => {
          e.stopPropagation()
          setMenuOpen((v) => !v)
        }}
      >
        ⋯
      </button>
      {menuOpen && (
        <SessionMenuPopup
          anchorRef={menuAnchorRef}
          menuRef={menuRef}
          testId="bookmark-menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="smi"
            data-testid="bookmark-menu-edit"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
              onEdit()
            }}
          >
            Edit
          </div>
          <div className="sm-sep" />
          <div
            className="smi danger"
            data-testid="bookmark-menu-remove"
            onMouseDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setMenuOpen(false)
              onDelete()
            }}
          >
            Remove
          </div>
        </SessionMenuPopup>
      )}
    </div>
  )
}

/** Pulls a droppable URL + title out of a chat link drag (or any external link drag). */
function readBookmarkDrop(dataTransfer: DataTransfer): AppBookmarkDragPayload | null {
  const raw = dataTransfer.getData(APP_BOOKMARK_DRAG_MIME)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as AppBookmarkDragPayload
      if (parsed?.url) return { url: parsed.url, title: parsed.title ?? '' }
    } catch {
      // fall through to the plain-text forms below
    }
  }
  const uriList = dataTransfer
    .getData('text/uri-list')
    .split('\n')
    .find((line) => line && !line.startsWith('#'))
  const url = normalizeBookmarkUrl(uriList || dataTransfer.getData('text/plain'))
  return url ? { url, title: '' } : null
}

function SessionRow({
  session,
  active,
  closed,
  status,
  dotStatus,
  showWaitingInputAlert,
  draggable,
  onSelect,
  onRename,
  onTogglePin,
  onClose,
  onDelete,
  onFork,
  onRestart,
  onReconnect,
  onAddTag,
  onRemoveTag,
  onSetNotes,
  onSetColor,
  onSetProjectPath,
  onDragStart,
  onDragOver,
  onDrop,
  worktreeProgress,
  shellRemoteHost
}: {
  session: SessionRecord
  active: boolean
  closed: boolean
  status: SessionStatus
  dotStatus: string
  showWaitingInputAlert: boolean
  draggable: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onTogglePin: () => void
  onClose: () => void
  onDelete: () => void
  onFork: () => void
  onRestart: () => void
  onReconnect: () => void
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
  onSetNotes: (notes: string) => void
  onSetColor: (color: string) => void
  onSetProjectPath: (projectPath: string) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  worktreeProgress?: number
  shellRemoteHost?: string | null
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(session.name)
  const [menuOpen, setMenuOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuAnchorRef = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  // Outside-click closes the row menu / detail popover. Must check
  // event.target with refs — React's stopPropagation does not suppress
  // native document listeners registered here.
  useEffect(() => {
    if (!menuOpen && !detailOpen) return
    function handleOutsideClick(e: MouseEvent): void {
      const target = e.target as Node
      if (menuOpen && menuRef.current?.contains(target)) return
      if (detailOpen && detailRef.current?.contains(target)) return
      setMenuOpen(false)
      setDetailOpen(false)
    }
    document.addEventListener('click', handleOutsideClick)
    return () => document.removeEventListener('click', handleOutsideClick)
  }, [menuOpen, detailOpen])

  function commitRename(): void {
    setEditing(false)
    const trimmed = draftName.trim()
    if (trimmed) onRename(trimmed)
    else setDraftName(session.name)
  }

  const isTerminal = session.mode === 'terminal'
  const cleaningUp = status === 'cleaning-up'
  const interactionDisabled = cleaningUp || status === 'creating-worktree'

  return (
    <div
      ref={menuAnchorRef}
      className={'session-row' + (active ? ' active' : '') + (closed ? ' closed' : '')}
      data-testid="session-row"
      data-hint-session-row=""
      data-session-id={session.id}
      data-mode={session.mode}
      data-active={active}
      data-pinned={session.pinned}
      data-status={status}
      draggable={draggable && !interactionDisabled}
      tabIndex={-1}
      onClick={interactionDisabled ? undefined : onSelect}
      onContextMenu={(e) => {
        if (interactionDisabled) return
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen(true)
        setDetailOpen(false)
      }}
      onDragStart={interactionDisabled ? undefined : onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {showWaitingInputAlert && (
        <span className="session-waiting-input-alert" data-testid="session-waiting-input-alert" aria-hidden />
      )}
      <span
        className="session-indicator"
        title={
          isTerminal
            ? 'Terminal'
            : `Status: ${status}${status === 'creating-worktree' && worktreeProgress !== undefined ? ` · ${worktreeProgress}%` : ''}`
        }
      >
        {isTerminal ? <TerminalSessionIcon /> : <SessionStatusIndicator dotStatus={dotStatus} />}
      </span>
      <div className="session-main hide-on-collapse">
        {editing ? (
          <input
            className="session-name-input"
            autoFocus
            value={draftName}
            data-testid="session-rename-input"
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') {
                setDraftName(session.name)
                setEditing(false)
              }
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="session-name" data-testid="session-name">
            {session.name}
          </div>
        )}
        <div className="session-meta">
          {dotStatus === 'waiting-blocked' ? (
            <span data-testid="session-meta-host" style={{ color: 'var(--warning)' }}>
              {sessionMetaLabel(session, shellRemoteHost, dotStatus)}
            </span>
          ) : (
            <span data-testid="session-meta-host">{sessionMetaLabel(session, shellRemoteHost, dotStatus)}</span>
          )}
          {session.tags.map((tag) => (
            <span className="row-tag" key={tag} data-testid="tag-pill">
              {tag}
            </span>
          ))}
        </div>
        {status === 'creating-worktree' && (
          <div className="session-creating-label" data-testid="session-creating-label">
            Setting up worktree…{worktreeProgress !== undefined ? ` (${worktreeProgress}%)` : ''}
          </div>
        )}
        {cleaningUp && (
          <div className="session-creating-label" data-testid="session-cleanup-label">
            Cleaning up session…
          </div>
        )}
      </div>
      {status === 'creating-worktree' && (
        <div className="session-worktree-progress" data-testid="session-worktree-progress" aria-hidden={worktreeProgress === undefined}>
          <div
            className="session-worktree-progress-fill"
            style={{ width: `${worktreeProgress ?? 0}%` }}
          />
        </div>
      )}
      {!cleaningUp && !closed && session.pinned && <span className="pin-icon hide-on-collapse">📌</span>}
      {!cleaningUp && closed && !isTerminal && (
        <button
          type="button"
          className="resume-btn hide-on-collapse"
          data-testid="resume-button"
          title="Reconnect session"
          onClick={(e) => {
            e.stopPropagation()
            onReconnect()
          }}
        >
          Reconnect
        </button>
      )}
      {!cleaningUp && (
        <button
          className="row-menu-btn hide-on-collapse"
          data-testid="session-menu-button"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen((v) => !v)
            setDetailOpen(false)
          }}
        >
          ⋯
        </button>
      )}
      {menuOpen && (
        <SessionMenuPopup
          anchorRef={menuAnchorRef}
          menuRef={menuRef}
          testId="session-menu"
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="smi"
            data-testid="menu-rename"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
              setEditing(true)
            }}
          >
            Rename
          </div>
          {!closed && !isTerminal && (
            <div
              className="smi"
              data-testid="menu-pin"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                onTogglePin()
              }}
            >
              {session.pinned ? 'Unpin' : 'Pin'}
            </div>
          )}
          {!isTerminal && (
            <div
              className="smi"
              data-testid="menu-details"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                setDetailOpen(true)
              }}
            >
              Tags / Notes / Color…
            </div>
          )}
          {!isTerminal && (
            <div
              className="smi"
              data-testid="menu-fork"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                onFork()
              }}
            >
              Fork / Duplicate
            </div>
          )}
          {!isTerminal && (
            <div
              className="smi"
              data-testid="menu-restart"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                onRestart()
              }}
            >
              Restart
            </div>
          )}
          <div className="sm-sep" />
          {!closed && (
            <div
              className="smi"
              data-testid="menu-close"
              onClick={(e) => {
                e.stopPropagation()
                setMenuOpen(false)
                onClose()
              }}
            >
              Close
            </div>
          )}
          <div
            className="smi danger"
            data-testid="menu-delete"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen(false)
              onDelete()
            }}
          >
            Delete
          </div>
        </SessionMenuPopup>
      )}
      {detailOpen && !isTerminal && (
        <SessionDetailPopover
          ref={detailRef}
          session={session}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          onSetNotes={onSetNotes}
          onSetColor={onSetColor}
          onSetProjectPath={onSetProjectPath}
          onClose={() => setDetailOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * Real session sidebar (02-session-lifecycle), extended with session
 * organization (06-session-organization): tags/notes/color detail popover,
 * search + quick filters, named/collapsible/reorderable groups, manual
 * drag-drop ordering, and live per-session status badges.
 */
export default function Sidebar({
  collapsed,
  activeSessions,
  historySessions,
  activeSessionId,
  onSelectSession,
  onOpenSettings,
  onNewSession,
  onRename,
  onTogglePin,
  onClose,
  onDelete,
  onFork,
  onRestart,
  onReconnectSession,
  groups,
  statuses,
  staleSessionIds,
  onSetColor,
  onSetNotes,
  onSetProjectPath,
  onAddTag,
  onRemoveTag,
  onReorderSessions,
  onCreateGroup,
  onRenameGroup,
  onSetGroupCollapsed,
  onDeleteGroup,
  onReorderGroups,
  worktreeProgressBySession,
  onOpenLocalTerminal,
  terminalShellHostBySessionId,
  appNotes,
  activeAppNoteId,
  activeDailyNote,
  weeklyPlanFileExists,
  activeWeeklyPlan,
  onSelectWeeklyPlanRow,
  onStartWeeklyPlan,
  onSelectAppNote,
  onSelectDailyNote,
  dailyNotesPanelOpen,
  onToggleDailyNotesPanel,
  onCreateAppNote,
  onRenameAppNote,
  onDeleteAppNote,
  bookmarks,
  onCreateBookmark,
  onUpdateBookmark,
  onDeleteBookmark,
  onOpenBookmark,
  waitingInputAlertIds,
  onClearWaitingInputAlert
}: SidebarProps): JSX.Element {
  const promptDotsBySession = useSessionPromptDotsMap()
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  // null = dialog closed; { bookmark: null } = adding; { bookmark } = editing.
  const [bookmarkDialog, setBookmarkDialog] = useState<{ bookmark: AppBookmarkRecord | null } | null>(null)
  const [bookmarkDropReady, setBookmarkDropReady] = useState(false)
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [groupMenuOpenId, setGroupMenuOpenId] = useState<string | null>(null)
  const groupMenuAnchorRef = useRef<HTMLButtonElement>(null)
  const groupMenuRef = useRef<HTMLDivElement>(null)
  const [dragSessionId, setDragSessionId] = useState<string | null>(null)
  const [dragGroupId, setDragGroupId] = useState<string | null>(null)
  const [agentClosedCollapsed, setAgentClosedCollapsed] = useState(() => {
    try {
      return localStorage.getItem('atelier.sidebar.agentClosedCollapsed') === '1'
    } catch {
      return false
    }
  })
  const [terminalClosedCollapsed, setTerminalClosedCollapsed] = useState(() => {
    try {
      return localStorage.getItem('atelier.sidebar.terminalClosedCollapsed') === '1'
    } catch {
      return false
    }
  })
  // waitingInputAlertIds and its tracking logic live in App.tsx (lifted up so
  // the collapsed-sidebar alert chips share the same source of truth).

  useEffect(() => {
    try {
      localStorage.setItem('atelier.sidebar.agentClosedCollapsed', agentClosedCollapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [agentClosedCollapsed])

  useEffect(() => {
    try {
      localStorage.setItem('atelier.sidebar.terminalClosedCollapsed', terminalClosedCollapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [terminalClosedCollapsed])

  useEffect(() => {
    if (!groupMenuOpenId) return
    function handleOutsideClick(e: MouseEvent): void {
      if (groupMenuRef.current?.contains(e.target as Node)) return
      if (groupMenuAnchorRef.current?.contains(e.target as Node)) return
      setGroupMenuOpenId(null)
    }
    document.addEventListener('click', handleOutsideClick)
    return () => document.removeEventListener('click', handleOutsideClick)
  }, [groupMenuOpenId])

  const agentActive = activeSessions.filter((s) => s.mode !== 'terminal')
  const terminalActive = activeSessions.filter((s) => s.mode === 'terminal')
  const agentHistory = historySessions.filter((s) => s.mode !== 'terminal')
  const terminalHistory = historySessions.filter((s) => s.mode === 'terminal')

  const { pinned, byGroup, ungrouped } = groupSessions(agentActive, groups)

  function makeDragHandlers(sectionGroupId: string | null | undefined, sectionIds: string[], sessionId: string): {
    onDragStart: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  } {
    return {
      onDragStart: (e) => {
        e.dataTransfer.setData('text/plain', sessionId)
        e.dataTransfer.effectAllowed = 'move'
        setDragSessionId(sessionId)
      },
      onDragOver: (e) => {
        if (dragSessionId) e.preventDefault()
      },
      onDrop: (e) => {
        e.preventDefault()
        e.stopPropagation()
        const draggedId = dragSessionId ?? e.dataTransfer.getData('text/plain')
        if (!draggedId || draggedId === sessionId) return
        const withoutDragged = sectionIds.filter((id) => id !== draggedId)
        const targetIndex = withoutDragged.indexOf(sessionId)
        const nextOrder = [...withoutDragged]
        nextOrder.splice(targetIndex === -1 ? nextOrder.length : targetIndex, 0, draggedId)
        onReorderSessions(sectionGroupId, nextOrder)
        setDragSessionId(null)
      }
    }
  }

  function sectionDropZone(sectionGroupId: string | null | undefined, sectionIds: string[]): {
    onDragOver: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  } {
    return {
      onDragOver: (e) => {
        if (dragSessionId) e.preventDefault()
      },
      onDrop: (e) => {
        e.preventDefault()
        const draggedId = dragSessionId ?? e.dataTransfer.getData('text/plain')
        if (!draggedId) return
        const withoutDragged = sectionIds.filter((id) => id !== draggedId)
        onReorderSessions(sectionGroupId, [...withoutDragged, draggedId])
        setDragSessionId(null)
      }
    }
  }

  // A note surface (daily note, weekly plan, or an app note) takes over the
  // main pane, so the session it replaced must not keep the selected
  // background — otherwise two rows look focused at once.
  const noteSurfaceActive = activeAppNoteId != null || activeDailyNote || activeWeeklyPlan

  function row(session: SessionRecord, closed: boolean, sectionGroupId: string | null | undefined, sectionIds: string[]): JSX.Element {
    const dragHandlers = closed
      ? { onDragStart: () => undefined, onDragOver: () => undefined, onDrop: () => undefined }
      : makeDragHandlers(sectionGroupId, sectionIds, session.id)
    return (
      <SessionRow
        key={session.id}
        session={session}
        active={session.id === activeSessionId && !noteSurfaceActive}
        closed={closed}
        status={displayStatus(session, closed, statuses)}
        dotStatus={sessionDotStatus(session, closed, statuses, staleSessionIds, promptDotsBySession[session.id] ?? null)}
        showWaitingInputAlert={
          !closed &&
          waitingInputAlertIds.has(session.id) &&
          session.id !== activeSessionId &&
          sessionLiveWaitingForInput(session, closed, statuses)
        }
        draggable={!closed}
        onSelect={() => {
          onClearWaitingInputAlert(session.id)
          onSelectSession(session)
        }}
        onRename={(name) => onRename(session.id, name)}
        onTogglePin={() => onTogglePin(session.id, !session.pinned)}
        onClose={() => onClose(session.id)}
        onDelete={() => onDelete(session.id)}
        onFork={() => onFork(session.id)}
        onRestart={() => onRestart(session.id)}
        onReconnect={() => onReconnectSession(session.id)}
        onAddTag={(tag) => onAddTag(session.id, tag)}
        onRemoveTag={(tag) => onRemoveTag(session.id, tag)}
        onSetNotes={(notes) => onSetNotes(session.id, notes)}
        onSetColor={(color) => onSetColor(session.id, color)}
        onSetProjectPath={(projectPath) => onSetProjectPath(session.id, projectPath)}
        worktreeProgress={worktreeProgressBySession[session.id]}
        shellRemoteHost={terminalShellHostBySessionId[session.id]}
        {...dragHandlers}
      />
    )
  }

  const groupList = Array.from(byGroup.entries())

  return (
    <div className={'sidebar' + (collapsed ? ' collapsed' : '')} data-testid="sidebar">
      <div className="sidebar-top-row" data-testid="sidebar-top-row">
        <div className="sidebar-utility-row" data-testid="sidebar-utility-row">
        <button
          className="sidebar-utility-button"
          title="Settings"
          data-testid="open-settings-button"
          onClick={onOpenSettings}
        >
          <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V20a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H4.4a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 6.05 7.4a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 4.49V4a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87 1.7 1.7 0 0 0 1.56 1.04h.09a2 2 0 1 1 0 4H21a1.7 1.7 0 0 0-1.6 1.04z" />
          </svg>
        </button>
        </div>
        <div className="new-group-row hide-on-collapse">
          {newGroupOpen ? (
            <input
              className="input"
              autoFocus
              data-testid="new-group-input"
              placeholder="Group name…"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onBlur={() => {
                const trimmed = newGroupName.trim()
                if (trimmed) onCreateGroup(trimmed)
                setNewGroupName('')
                setNewGroupOpen(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const trimmed = newGroupName.trim()
                  if (trimmed) onCreateGroup(trimmed)
                  setNewGroupName('')
                  setNewGroupOpen(false)
                }
                if (e.key === 'Escape') {
                  setNewGroupName('')
                  setNewGroupOpen(false)
                }
              }}
            />
          ) : (
            <button className="btn btn-ghost btn-sm" data-testid="new-group-button" onClick={() => setNewGroupOpen(true)}>
              + New Group
            </button>
          )}
        </div>
      </div>

      <div className="sidebar-lists-stack hide-on-collapse">
        <div className="sidebar-list-pane sidebar-list-pane--sessions">
          <div className="sidebar-section-head">
            <div className="sidebar-pane-label">Sessions</div>
            <button
              type="button"
              className="sidebar-action-icon primary"
              title="New Session"
              data-testid="new-session-button"
              onClick={onNewSession}
            >
              <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <div className="session-list session-list--natural" data-testid="session-list">
        {agentActive.length === 0 && agentHistory.length === 0 && (
          <div className="history-empty-hint hide-on-collapse">No sessions yet — create one to get started.</div>
        )}

        {pinned.length > 0 && (
          <>
            <div className="group-header" data-testid="group-header-pinned">
              <span className="chev">▾</span>
              <span className="hide-on-collapse">📌 Pinned</span>
              <span className="count hide-on-collapse">{pinned.length}</span>
            </div>
            <div className="group-body" data-group="pinned" {...sectionDropZone(undefined, pinned.map((s) => s.id))}>
              {pinned.map((s) => row(s, false, undefined, pinned.map((x) => x.id)))}
            </div>
          </>
        )}

        {groupList.map(([groupId, sessions]) => {
          const group = groups.find((g) => g.id === groupId)
          if (!group) return null
          return (
            <div
              key={groupId}
              draggable
              onDragStart={() => setDragGroupId(groupId)}
              onDragOver={(e) => {
                if (dragGroupId) e.preventDefault()
              }}
              onDrop={(e) => {
                e.preventDefault()
                if (!dragGroupId || dragGroupId === groupId) return
                const ids = groups.map((g) => g.id)
                const without = ids.filter((id) => id !== dragGroupId)
                const targetIndex = without.indexOf(groupId)
                without.splice(targetIndex, 0, dragGroupId)
                onReorderGroups(without)
                setDragGroupId(null)
              }}
            >
              <div
                className={'group-header' + (group.collapsed ? ' collapsed' : '')}
                data-testid={`group-header-${groupId}`}
                style={{ marginTop: 8 }}
                onClick={() => onSetGroupCollapsed(groupId, !group.collapsed)}
              >
                <span className="chev">▾</span>
                {renamingGroupId === groupId ? (
                  <input
                    className="session-name-input hide-on-collapse"
                    autoFocus
                    defaultValue={group.name}
                    data-testid="group-rename-input"
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => {
                      const trimmed = e.target.value.trim()
                      if (trimmed && trimmed !== group.name) onRenameGroup(groupId, trimmed)
                      setRenamingGroupId(null)
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setRenamingGroupId(null)
                    }}
                  />
                ) : (
                  <span className="hide-on-collapse">{group.name}</span>
                )}
                <span className="count hide-on-collapse">{sessions.length}</span>
                <button
                  ref={groupMenuOpenId === groupId ? groupMenuAnchorRef : undefined}
                  className="row-menu-btn hide-on-collapse"
                  data-testid={`group-menu-button-${groupId}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    setGroupMenuOpenId((v) => (v === groupId ? null : groupId))
                  }}
                >
                  ⋯
                </button>
                {groupMenuOpenId === groupId && (
                  <SessionMenuPopup
                    anchorRef={groupMenuAnchorRef}
                    menuRef={groupMenuRef}
                    testId="group-menu"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div
                      className="smi"
                      data-testid="group-menu-rename"
                      onClick={() => {
                        setGroupMenuOpenId(null)
                        setRenamingGroupId(groupId)
                      }}
                    >
                      Rename
                    </div>
                    <div
                      className="smi danger"
                      data-testid="group-menu-delete"
                      onClick={() => {
                        setGroupMenuOpenId(null)
                        onDeleteGroup(groupId)
                      }}
                    >
                      Delete
                    </div>
                  </SessionMenuPopup>
                )}
              </div>
              {!group.collapsed && (
                <div
                  className="group-body"
                  data-group={groupId}
                  {...sectionDropZone(groupId, sessions.map((s) => s.id))}
                >
                  {sessions.map((s) => row(s, false, groupId, sessions.map((x) => x.id)))}
                </div>
              )}
            </div>
          )
        })}

        {ungrouped.length > 0 && (
          <>
            {(pinned.length > 0 || groupList.length > 0) && (
              <div className="group-header" data-testid="group-header-ungrouped" style={{ marginTop: 8 }}>
                <span className="chev">▾</span>
                <span className="hide-on-collapse">Ungrouped</span>
                <span className="count hide-on-collapse">{ungrouped.length}</span>
              </div>
            )}
            <div
              className="group-body"
              data-group="ungrouped"
              {...sectionDropZone(null, ungrouped.map((s) => s.id))}
            >
              {ungrouped.map((s) => row(s, false, null, ungrouped.map((x) => x.id)))}
            </div>
          </>
        )}

        <div
          className={'group-header' + (agentClosedCollapsed ? ' collapsed' : '')}
          data-testid="group-header-history"
          style={{ marginTop: 8 }}
          onClick={() => setAgentClosedCollapsed((v) => !v)}
        >
          <span className="chev">▾</span>
          <span className="sidebar-pane-label hide-on-collapse">Closed</span>
          <span className="count hide-on-collapse" data-testid="history-count">
            {agentHistory.length}
          </span>
        </div>
        {!agentClosedCollapsed && (
          <div className="group-body" data-group="history">
            {agentHistory.length === 0 && (
              <div className="history-empty-hint hide-on-collapse">
                Closed sessions land here — select one and click Reconnect to restore chat and tools.
              </div>
            )}
            {agentHistory.map((s) => row(s, true, undefined, []))}
          </div>
        )}
          </div>
        </div>

        <div className="sidebar-section-hsep" aria-hidden="true" />

        <div className="sidebar-list-pane sidebar-list-pane--terminals">
          <div className="sidebar-section-head">
            <div className="sidebar-pane-label">Terminals</div>
            <button
              type="button"
              className="sidebar-action-icon"
              title="Open local terminal"
              data-testid="open-local-terminal-button"
              onClick={onOpenLocalTerminal}
            >
              <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
            </button>
          </div>
          <div className="session-list session-list--natural" data-testid="terminal-list">
            {terminalActive.length === 0 && terminalHistory.length === 0 && (
              <div className="history-empty-hint">Open a local terminal with the icon above.</div>
            )}
            <div className="group-body" data-group="terminals">
              {terminalActive.map((s) => row(s, false, null, terminalActive.map((x) => x.id)))}
            </div>
            {terminalHistory.length > 0 && (
              <>
                <div
                  className={'group-header' + (terminalClosedCollapsed ? ' collapsed' : '')}
                  data-testid="group-header-terminal-closed"
                  style={{ marginTop: 8 }}
                  onClick={() => setTerminalClosedCollapsed((v) => !v)}
                >
                  <span className="chev">▾</span>
                  <span className="sidebar-pane-label">Closed</span>
                  <span className="count">{terminalHistory.length}</span>
                </div>
                {!terminalClosedCollapsed && (
                  <div className="group-body" data-group="terminal-history">
                    {terminalHistory.map((s) => row(s, true, undefined, []))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="sidebar-section-hsep" aria-hidden="true" />

        <div className="sidebar-list-pane sidebar-list-pane--notes">
          <div className="sidebar-section-head">
            <div className="sidebar-pane-label">Notes</div>
            <button
              type="button"
              className="sidebar-action-icon primary"
              title="New note"
              data-testid="new-app-note-button"
              onClick={onCreateAppNote}
            >
              <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <div className="session-list session-list--natural" data-testid="app-notes-list">
            <div
              className={`session-row app-note-row app-note-row--daily hide-on-collapse${activeDailyNote ? ' active' : ''}`}
              data-testid="daily-note-row"
              data-hint-note-row=""
              data-active={activeDailyNote ? 'true' : 'false'}
              role="button"
              tabIndex={0}
              onClick={onSelectDailyNote}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectDailyNote()
                }
              }}
            >
              <span className="session-indicator" aria-hidden="true">
                <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
              </span>
              <div className="session-main">
                <div className="session-name">Daily note</div>
              </div>
            </div>
            <div
              className={`session-row app-note-row app-note-row--weekly hide-on-collapse${activeWeeklyPlan ? ' active' : ''}`}
              data-testid="weekly-plan-row"
              data-hint-note-row=""
              role="button"
              tabIndex={0}
              onClick={onSelectWeeklyPlanRow}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectWeeklyPlanRow()
                }
              }}
            >
              <span className="session-indicator" aria-hidden="true">
                <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-tertiary)' }}>
                  <rect x="3" y="4" width="18" height="18" rx="2" />
                  <line x1="16" y1="2" x2="16" y2="6" />
                  <line x1="8" y1="2" x2="8" y2="6" />
                  <line x1="3" y1="10" x2="21" y2="10" />
                </svg>
              </span>
              <div className="session-main">
                <div className="session-name">Weekly plan</div>
              </div>
              {!weeklyPlanFileExists ? (
                <button
                  type="button"
                  className="row-menu-btn hide-on-collapse weekly-plan-create-btn"
                  data-testid="weekly-plan-create-button"
                  title="Start weekly review & plan"
                  onClick={(e) => {
                    e.stopPropagation()
                    onStartWeeklyPlan()
                  }}
                >
                  +
                </button>
              ) : null}
            </div>
            {appNotes.length === 0 && (
              <div className="history-empty-hint">Create a note with the icon above.</div>
            )}
            {appNotes.map((note) => (
              <AppNoteRow
                key={note.id}
                note={note}
                active={activeAppNoteId === note.id}
                onSelect={() => onSelectAppNote(note.id)}
                onRename={(title) => onRenameAppNote(note.id, title)}
                onDelete={() => onDeleteAppNote(note.id)}
              />
            ))}
          </div>
        </div>

        <div className="sidebar-section-hsep" aria-hidden="true" />

        <div
          className={`sidebar-list-pane sidebar-list-pane--bookmarks${bookmarkDropReady ? ' drop-ready' : ''}`}
          data-testid="sidebar-bookmarks"
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setBookmarkDropReady(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setBookmarkDropReady(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setBookmarkDropReady(false)
            const dropped = readBookmarkDrop(e.dataTransfer)
            if (!dropped || !isSupportedBookmarkUrl(dropped.url)) return
            onCreateBookmark({ url: dropped.url, title: dropped.title })
          }}
        >
          <div className="sidebar-section-head">
            <div className="sidebar-pane-label">Bookmarks</div>
            <button
              type="button"
              className="sidebar-action-icon primary"
              title="Add bookmark"
              data-testid="new-bookmark-button"
              onClick={() => setBookmarkDialog({ bookmark: null })}
            >
              <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
          <div className="session-list session-list--natural" data-testid="bookmarks-list">
            {bookmarks.length === 0 && (
              <div className="history-empty-hint">Links live here — use + above, or drop one from chat.</div>
            )}
            {bookmarks.map((bookmark) => (
              <BookmarkRow
                key={bookmark.id}
                bookmark={bookmark}
                onOpen={() => onOpenBookmark(bookmark.url)}
                onEdit={() => setBookmarkDialog({ bookmark })}
                onDelete={() => onDeleteBookmark(bookmark.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {bookmarkDialog && (
        <BookmarkEditModal
          bookmark={bookmarkDialog.bookmark}
          onClose={() => setBookmarkDialog(null)}
          onSave={({ url, title }) => {
            const editing = bookmarkDialog.bookmark
            if (editing) onUpdateBookmark(editing.id, { url, title })
            else onCreateBookmark({ url, title })
            setBookmarkDialog(null)
          }}
        />
      )}

      <div className="hide-on-collapse">
        <SpendStatusChip />
      </div>
    </div>
  )
}
