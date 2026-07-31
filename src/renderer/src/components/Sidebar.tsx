import { useState } from 'react'
import type { SessionRecord } from '../../../shared/session-types'

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
}

const SESSION_COLORS = ['--sc-blue', '--sc-green', '--sc-purple', '--sc-amber', '--sc-rose', '--sc-cyan', '--sc-indigo', '--sc-teal']

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

function groupSessions(sessions: SessionRecord[]): {
  pinned: SessionRecord[]
  grouped: Map<string, SessionRecord[]>
  ungrouped: SessionRecord[]
} {
  const pinned = sessions.filter((s) => s.pinned)
  const rest = sessions.filter((s) => !s.pinned)
  const grouped = new Map<string, SessionRecord[]>()
  const ungrouped: SessionRecord[] = []
  for (const s of rest) {
    if (s.groupId) {
      const list = grouped.get(s.groupId) ?? []
      list.push(s)
      grouped.set(s.groupId, list)
    } else {
      ungrouped.push(s)
    }
  }
  return { pinned, grouped, ungrouped }
}

function SessionRow({
  session,
  active,
  closed,
  onSelect,
  onRename,
  onTogglePin,
  onClose,
  onDelete,
  onFork,
  onRestart
}: {
  session: SessionRecord
  active: boolean
  closed: boolean
  onSelect: () => void
  onRename: (name: string) => void
  onTogglePin: () => void
  onClose: () => void
  onDelete: () => void
  onFork: () => void
  onRestart: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState(session.name)
  const [menuOpen, setMenuOpen] = useState(false)

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
      tabIndex={-1}
      onClick={onSelect}
    >
      <span className="session-indicator" title="Session color">
        <span className="color-core" data-testid="session-dot" style={{ background: colorVar(session) }} />
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
          <span>{session.hostname ?? session.projectPath.split('/').filter(Boolean).pop()}</span>
          {closed && <span className="row-tag">closed</span>}
        </div>
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
    </div>
  )
}

/**
 * Real session sidebar (02-session-lifecycle), replacing 08's single
 * placeholder row. Pinned section, named groups, History (closed sessions,
 * resumable), New Session button — matches mocks/index.html's structure.
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
  onRestart
}: SidebarProps): JSX.Element {
  const { pinned, grouped, ungrouped } = groupSessions(activeSessions)

  function row(session: SessionRecord, closed: boolean): JSX.Element {
    return (
      <SessionRow
        key={session.id}
        session={session}
        active={session.id === activeSessionId}
        closed={closed}
        onSelect={() => onSelectSession(session)}
        onRename={(name) => onRename(session.id, name)}
        onTogglePin={() => onTogglePin(session.id, !session.pinned)}
        onClose={() => onClose(session.id)}
        onDelete={() => onDelete(session.id)}
        onFork={() => onFork(session.id)}
        onRestart={() => onRestart(session.id)}
      />
    )
  }

  return (
    <div className={'sidebar' + (collapsed ? ' collapsed' : '')} data-testid="sidebar">
      <div className="sidebar-top">
        <div className="app-mark" />
        <div className="app-name hide-on-collapse">Gardenia</div>
      </div>
      <div className="sidebar-search-row hide-on-collapse">
        <button className="sidebar-search" data-testid="open-palette-button" onClick={onOpenPalette}>
          <span>Search sessions…</span>
          <kbd>⌘K</kbd>
        </button>
      </div>
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

      <div className="session-list" data-testid="session-list">
        {activeSessions.length === 0 && historySessions.length === 0 && (
          <div className="history-empty-hint hide-on-collapse">No sessions yet — create one to get started.</div>
        )}

        {pinned.length > 0 && (
          <>
            <div className="group-header" data-testid="group-header-pinned">
              <span className="hide-on-collapse">📌 Pinned</span>
              <span className="count hide-on-collapse">{pinned.length}</span>
            </div>
            <div className="group-body" data-group="pinned">
              {pinned.map((s) => row(s, false))}
            </div>
          </>
        )}

        {Array.from(grouped.entries()).map(([groupId, sessions]) => (
          <div key={groupId}>
            <div className="group-header" data-testid={`group-header-${groupId}`} style={{ marginTop: 8 }}>
              <span className="hide-on-collapse">{groupId}</span>
              <span className="count hide-on-collapse">{sessions.length}</span>
            </div>
            <div className="group-body" data-group={groupId}>
              {sessions.map((s) => row(s, false))}
            </div>
          </div>
        ))}

        {ungrouped.length > 0 && (
          <div
            className="group-body"
            data-group="ungrouped"
            style={{ marginTop: pinned.length || grouped.size ? 8 : 0 }}
          >
            {ungrouped.map((s) => row(s, false))}
          </div>
        )}

        <div className="group-header" data-testid="group-header-history" style={{ marginTop: 8 }}>
          <span className="hide-on-collapse">History (closed)</span>
          <span className="count hide-on-collapse" data-testid="history-count">
            {historySessions.length}
          </span>
        </div>
        <div className="group-body" data-group="history">
          {historySessions.length === 0 && (
            <div className="history-empty-hint hide-on-collapse">
              Closed sessions land here — click Resume to reopen with full context restored.
            </div>
          )}
          {historySessions.map((s) => row(s, true))}
        </div>
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
