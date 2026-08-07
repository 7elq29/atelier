import { useEffect, useState } from 'react'
import type { MessageRecord, SessionGroupRecord, SessionRecord, SessionStatus } from '../../../shared/session-types'
import { parseStructuredContent } from '../../../shared/chat-content'
import SpendStatusChip from './SpendStatusChip'

interface SidebarProps {
  collapsed: boolean
  onToggleCollapse: () => void
  activeSessions: SessionRecord[]
  historySessions: SessionRecord[]
  activeSessionId: string | null
  onSelectSession: (session: SessionRecord) => void
  onOpenPalette: () => void
  onOpenSettings: () => void
  onNewSession: () => void
  onRename: (sessionId: string, name: string) => void
  onTogglePin: (sessionId: string, pinned: boolean) => void
  onClose: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onFork: (sessionId: string) => void
  onRestart: (sessionId: string) => void

  // ── 06-session-organization ──────────────────────────────────────────
  groups: SessionGroupRecord[]
  statuses: Record<string, SessionStatus>
  staleSessionIds: Set<string>
  messagesBySession: Record<string, MessageRecord[]>
  onSetColor: (sessionId: string, color: string) => void
  onSetNotes: (sessionId: string, notes: string) => void
  onAddTag: (sessionId: string, tag: string) => void
  onRemoveTag: (sessionId: string, tag: string) => void
  onReorderSessions: (groupId: string | null | undefined, orderedIds: string[]) => void
  onCreateGroup: (name: string) => void
  onRenameGroup: (groupId: string, name: string) => void
  onSetGroupCollapsed: (groupId: string, collapsed: boolean) => void
  onDeleteGroup: (groupId: string) => void
  onReorderGroups: (orderedIds: string[]) => void
  worktreeProgressBySession: Record<string, number>
}

const SESSION_COLORS = ['--sc-blue', '--sc-green', '--sc-purple', '--sc-amber', '--sc-rose', '--sc-cyan', '--sc-indigo', '--sc-teal']

/** Quick filter chip ids, matching mocks/index.html's filter-row exactly ("All" / "Waiting" / "Needs attention"). */
type QuickFilter = 'all' | 'waiting' | 'attention'

function colorVar(session: SessionRecord): string {
  if (session.color && SESSION_COLORS.includes(session.color)) return `var(${session.color})`
  // Deterministic fallback so the same session always gets the same dot
  // color across renders/relaunches, without persisting one up front.
  const idx = Math.abs(hashCode(session.id)) % SESSION_COLORS.length
  return `var(${SESSION_COLORS[idx]})`
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i)
  return h
}

/**
 * 06-session-organization concurrent status: a session's DISPLAY status
 * folds SessionManager's live 'working'/'waiting'/'idle' (see
 * shared/session-types.ts's SessionStatus doc comment) together with two
 * things the manager doesn't track: terminal-mode sessions (no harness at
 * all) and closed sessions both display as 'disconnected'.
 */
function displayStatus(session: SessionRecord, closed: boolean, statuses: Record<string, SessionStatus>): SessionStatus {
  if (closed || session.mode === 'terminal') return 'disconnected'
  return statuses[session.id] ?? 'idle'
}

/** Derives the CSS class suffix for the session indicator dot.
 *  When status is 'waiting', distinguishes input-wait (purple) from
 *  blocked-wait (orange) by inspecting the last assistant message. */
function dotStatusClass(status: SessionStatus, messages: MessageRecord[] | undefined): string {
  if (status !== 'waiting') return status
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'user') break
      if (m.role === 'assistant') {
        const parsed = parseStructuredContent(m.content)
        if (parsed && (parsed.kind === 'permission_request' || parsed.kind === 'ask_user_question' || parsed.kind === 'plan_proposed')) {
          return 'waiting-blocked'
        }
        break
      }
    }
  }
  return 'waiting-input'
}

/**
 * "Needs attention" (06-session-organization) = status is 'waiting' (the
 * agent finished a turn and is waiting on the user's next instruction) OR
 * the session's most recent message is an error (a harness failure
 * surfaced as a `system` "Error: ..." message, or a tool call that ended
 * with status 'error') — documented in Features/06-session-organization/progress.md.
 */
function isErrorMessage(m: MessageRecord): boolean {
  if (m.role === 'system' && m.content.startsWith('Error:')) return true
  if (m.role === 'assistant') {
    try {
      const parsed = JSON.parse(m.content) as { kind?: string; status?: string }
      if (parsed && parsed.kind === 'tool_call' && parsed.status === 'error') return true
    } catch {
      /* not JSON content — ordinary assistant text, not an error */
    }
  }
  return false
}

function needsAttention(status: SessionStatus, messages: MessageRecord[] | undefined): boolean {
  if (status === 'waiting') return true
  const last = messages && messages.length > 0 ? messages[messages.length - 1] : undefined
  return !!last && isErrorMessage(last)
}

/** Subsequence fuzzy match (case-insensitive) — matches if every character of `query` appears in `text`, in order. */
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++
  }
  return qi === q.length
}

function searchableText(session: SessionRecord): string {
  return [session.name, ...session.tags, session.notes ?? ''].join(' ')
}

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
function SessionDetailPopover({
  session,
  onAddTag,
  onRemoveTag,
  onSetNotes,
  onSetColor,
  onClose
}: {
  session: SessionRecord
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
  onSetNotes: (notes: string) => void
  onSetColor: (color: string) => void
  onClose: () => void
}): JSX.Element {
  const [tagDraft, setTagDraft] = useState('')
  const [notesDraft, setNotesDraft] = useState(session.notes ?? '')

  function commitTag(): void {
    const trimmed = tagDraft.trim()
    if (trimmed) onAddTag(trimmed)
    setTagDraft('')
  }

  return (
    <div className="session-detail-popup" data-testid="session-detail-popover" onClick={(e) => e.stopPropagation()}>
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
}

function SessionRow({
  session,
  active,
  closed,
  status,
  dotStatus,
  draggable,
  onSelect,
  onRename,
  onTogglePin,
  onClose,
  onDelete,
  onFork,
  onRestart,
  onAddTag,
  onRemoveTag,
  onSetNotes,
  onSetColor,
  onDragStart,
  onDragOver,
  onDrop,
  worktreeProgress
}: {
  session: SessionRecord
  active: boolean
  closed: boolean
  status: SessionStatus
  dotStatus: string
  draggable: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onTogglePin: () => void
  onClose: () => void
  onDelete: () => void
  onFork: () => void
  onRestart: () => void
  onAddTag: (tag: string) => void
  onRemoveTag: (tag: string) => void
  onSetNotes: (notes: string) => void
  onSetColor: (color: string) => void
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  worktreeProgress?: number
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(session.name)
  const [menuOpen, setMenuOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)

  // Outside-click closes the row menu / detail popover (their own onClick
  // already stopPropagation()s, so this only fires for genuine outside
  // clicks — see SessionDetailPopover's/session-menu-popup's onClick).
  useEffect(() => {
    if (!menuOpen && !detailOpen) return
    function handleOutsideClick(): void {
      setMenuOpen(false)
      setDetailOpen(false)
    }
    document.addEventListener('click', handleOutsideClick)
    return () => document.removeEventListener('click', handleOutsideClick)
  }, [menuOpen, detailOpen])

  function commitRename(): void {
    setEditing(false)
    const trimmed = draftName.trim()
    if (trimmed && trimmed !== session.name) onRename(trimmed)
    else setDraftName(session.name)
  }

  return (
    <div
      className={'session-row' + (active ? ' active' : '') + (closed ? ' closed' : '')}
      data-testid="session-row"
      data-session-id={session.id}
      data-active={active}
      data-pinned={session.pinned}
      data-status={status}
      draggable={draggable && status !== 'creating-worktree'}
      tabIndex={-1}
      onClick={status === 'creating-worktree' ? undefined : onSelect}
      onContextMenu={(e) => {
        if (status === 'creating-worktree') return
        e.preventDefault()
        e.stopPropagation()
        setMenuOpen(true)
        setDetailOpen(false)
      }}
      onDragStart={status === 'creating-worktree' ? undefined : onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <span className="session-indicator" title={`Status: ${status}`}>
        <span className={'color-core status-' + dotStatus} data-testid="session-dot" />
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
            <span style={{ color: 'var(--warning)' }}>Needs approval</span>
          ) : (
            <span>{session.hostname ?? session.projectPath.split('/').filter(Boolean).pop()}</span>
          )}
          {closed && <span className="row-tag">closed</span>}
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
      </div>
      {closed && (
        <button
          className="resume-btn hide-on-collapse"
          data-testid="resume-button"
          onClick={(e) => {
            e.stopPropagation()
            onSelect()
          }}
        >
          Resume
        </button>
      )}
      {!closed && session.pinned && <span className="pin-icon hide-on-collapse">📌</span>}
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
      {menuOpen && (
        <div className="session-menu-popup" data-testid="session-menu" onClick={(e) => e.stopPropagation()}>
          <div
            className="smi"
            data-testid="menu-rename"
            onClick={() => {
              setMenuOpen(false)
              setEditing(true)
            }}
          >
            Rename
          </div>
          {!closed && (
            <div
              className="smi"
              data-testid="menu-pin"
              onClick={() => {
                setMenuOpen(false)
                onTogglePin()
              }}
            >
              {session.pinned ? 'Unpin' : 'Pin'}
            </div>
          )}
          <div
            className="smi"
            data-testid="menu-details"
            onClick={() => {
              setMenuOpen(false)
              setDetailOpen(true)
            }}
          >
            Tags / Notes / Color…
          </div>
          <div
            className="smi"
            data-testid="menu-fork"
            onClick={() => {
              setMenuOpen(false)
              onFork()
            }}
          >
            Fork / Duplicate
          </div>
          <div
            className="smi"
            data-testid="menu-restart"
            onClick={() => {
              setMenuOpen(false)
              onRestart()
            }}
          >
            Restart
          </div>
          <div className="sm-sep" />
          {!closed && (
            <div
              className="smi"
              data-testid="menu-close"
              onClick={() => {
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
            onClick={() => {
              setMenuOpen(false)
              onDelete()
            }}
          >
            Delete
          </div>
        </div>
      )}
      {detailOpen && (
        <SessionDetailPopover
          session={session}
          onAddTag={onAddTag}
          onRemoveTag={onRemoveTag}
          onSetNotes={onSetNotes}
          onSetColor={onSetColor}
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
  onToggleCollapse,
  activeSessions,
  historySessions,
  activeSessionId,
  onSelectSession,
  onOpenPalette,
  onOpenSettings,
  onNewSession,
  onRename,
  onTogglePin,
  onClose,
  onDelete,
  onFork,
  onRestart,
  groups,
  statuses,
  staleSessionIds,
  messagesBySession,
  onSetColor,
  onSetNotes,
  onAddTag,
  onRemoveTag,
  onReorderSessions,
  onCreateGroup,
  onRenameGroup,
  onSetGroupCollapsed,
  onDeleteGroup,
  onReorderGroups,
  worktreeProgressBySession
}: SidebarProps): JSX.Element {
  const [searchQuery, setSearchQuery] = useState('')
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all')
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [newGroupName, setNewGroupName] = useState('')
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null)
  const [groupMenuOpenId, setGroupMenuOpenId] = useState<string | null>(null)
  const [dragSessionId, setDragSessionId] = useState<string | null>(null)
  const [dragGroupId, setDragGroupId] = useState<string | null>(null)

  useEffect(() => {
    if (!groupMenuOpenId) return
    function handleOutsideClick(): void {
      setGroupMenuOpenId(null)
    }
    document.addEventListener('click', handleOutsideClick)
    return () => document.removeEventListener('click', handleOutsideClick)
  }, [groupMenuOpenId])

  const bySearch = activeSessions.filter((s) => fuzzyMatch(searchQuery, searchableText(s)))
  const byFilter = bySearch.filter((s) => {
    if (quickFilter === 'all') return true
    const status = displayStatus(s, false, statuses)
    if (quickFilter === 'waiting') return status === 'waiting'
    return needsAttention(status, messagesBySession[s.id])
  })
  const filteredHistory = historySessions.filter((s) => fuzzyMatch(searchQuery, searchableText(s)))

  const { pinned, byGroup, ungrouped } = groupSessions(byFilter, groups)

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

  function row(session: SessionRecord, closed: boolean, sectionGroupId: string | null | undefined, sectionIds: string[]): JSX.Element {
    const dragHandlers = closed
      ? { onDragStart: () => undefined, onDragOver: () => undefined, onDrop: () => undefined }
      : makeDragHandlers(sectionGroupId, sectionIds, session.id)
    return (
      <SessionRow
        key={session.id}
        session={session}
        active={session.id === activeSessionId}
        closed={closed}
        status={displayStatus(session, closed, statuses)}
        dotStatus={staleSessionIds.has(session.id) ? 'stale' : dotStatusClass(displayStatus(session, closed, statuses), messagesBySession[session.id])}
        draggable={!closed}
        onSelect={() => onSelectSession(session)}
        onRename={(name) => onRename(session.id, name)}
        onTogglePin={() => onTogglePin(session.id, !session.pinned)}
        onClose={() => onClose(session.id)}
        onDelete={() => onDelete(session.id)}
        onFork={() => onFork(session.id)}
        onRestart={() => onRestart(session.id)}
        onAddTag={(tag) => onAddTag(session.id, tag)}
        onRemoveTag={(tag) => onRemoveTag(session.id, tag)}
        onSetNotes={(notes) => onSetNotes(session.id, notes)}
        onSetColor={(color) => onSetColor(session.id, color)}
        worktreeProgress={worktreeProgressBySession[session.id]}
        {...dragHandlers}
      />
    )
  }

  const groupList = Array.from(byGroup.entries())

  return (
    <div className={'sidebar' + (collapsed ? ' collapsed' : '')} data-testid="sidebar">
      <div className="sidebar-top">
        <div className="app-mark" />
        <div className="app-name hide-on-collapse">Atelier</div>
      </div>
      <div className="sidebar-search-row hide-on-collapse">
        <input
          className="sidebar-search"
          data-testid="sidebar-search-input"
          placeholder="Search sessions…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className="filter-row hide-on-collapse" data-testid="filter-row">
        <button
          className={'filter-chip' + (quickFilter === 'all' ? ' active' : '')}
          data-testid="filter-all"
          onClick={() => setQuickFilter('all')}
        >
          All
        </button>
        <button
          className={'filter-chip' + (quickFilter === 'waiting' ? ' active' : '')}
          data-testid="filter-waiting"
          onClick={() => setQuickFilter('waiting')}
        >
          Waiting
        </button>
        <button
          className={'filter-chip' + (quickFilter === 'attention' ? ' active' : '')}
          data-testid="filter-attention"
          onClick={() => setQuickFilter('attention')}
        >
          Needs attention
        </button>
      </div>
      <button className="sidebar-search hide-on-collapse" data-testid="open-palette-button" onClick={onOpenPalette} style={{ margin: '0 16px 10px', width: 'calc(100% - 32px)' }}>
        <span>Command palette…</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="new-session-btn hide-on-collapse">
        <button
          className="btn btn-primary"
          style={{ width: '100%', justifyContent: 'center' }}
          data-testid="new-session-button"
          onClick={onNewSession}
        >
          + New Session
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

      <div className="session-list" data-testid="session-list">
        {activeSessions.length === 0 && historySessions.length === 0 && (
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
                  <div className="session-menu-popup" data-testid="group-menu" onClick={(e) => e.stopPropagation()}>
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
                  </div>
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

        <div className="group-header" data-testid="group-header-history" style={{ marginTop: 8 }}>
          <span className="chev">▾</span>
          <span className="hide-on-collapse">History (closed)</span>
          <span className="count hide-on-collapse" data-testid="history-count">
            {filteredHistory.length}
          </span>
        </div>
        <div className="group-body" data-group="history">
          {filteredHistory.length === 0 && (
            <div className="history-empty-hint hide-on-collapse">
              Closed sessions land here — click Resume to reopen with full context restored.
            </div>
          )}
          {filteredHistory.map((s) => row(s, true, undefined, []))}
        </div>
      </div>

      <div className="hide-on-collapse">
        <SpendStatusChip />
      </div>
      <div className="sidebar-bottom">
        <div className="user-avatar" />
        <button
          className="btn btn-icon btn-sm"
          title="Toggle sidebar collapse"
          data-testid="sidebar-collapse-toggle"
          onClick={onToggleCollapse}
          style={{ marginLeft: 'auto' }}
        >
          {collapsed ? '⇥' : '⇤'}
        </button>
        <button
          className="btn btn-icon btn-sm"
          title="Settings"
          data-testid="open-settings-button"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
      </div>
    </div>
  )
}
