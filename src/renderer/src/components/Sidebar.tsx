export interface PlaceholderSession {
  id: string
  name: string
}

interface SidebarProps {
  collapsed: boolean
  onToggleCollapse: () => void
  sessions: PlaceholderSession[]
  activeSessionId: string | null
  onSelectSession: (id: string) => void
  onOpenPalette: () => void
  onOpenSettings: () => void
}

/**
 * Sidebar shell + collapsed-rail mechanism. The session list itself is just
 * a placeholder (real sessions land with 02-session-lifecycle /
 * 03-chat-surface-core) — this proves the collapse toggle and the
 * select/focus mechanism the command palette also drives.
 */
export default function Sidebar({
  collapsed,
  onToggleCollapse,
  sessions,
  activeSessionId,
  onSelectSession,
  onOpenPalette,
  onOpenSettings
}: SidebarProps): JSX.Element {
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
      <div className="session-list" data-testid="session-list">
        {sessions.length === 0 && (
          <div className="history-empty-hint hide-on-collapse">No sessions yet — create one to get started.</div>
        )}
        {sessions.map((session) => (
          // TODO: real session rows (status dots, groups, drag-reorder, context menu)
          // land with 02-session-lifecycle / 03-chat-surface-core — this placeholder
          // row exists purely to prove selection + keyboard-driven focus works.
          <div
            key={session.id}
            className={'session-row' + (session.id === activeSessionId ? ' active' : '')}
            data-testid="session-row"
            data-session-id={session.id}
            data-active={session.id === activeSessionId}
            tabIndex={-1}
            onClick={() => onSelectSession(session.id)}
          >
            <span className="session-indicator">
              <span className="color-core" style={{ background: 'var(--sc-green)' }} />
            </span>
            <div className="session-main hide-on-collapse">
              <div className="session-name">{session.name}</div>
            </div>
          </div>
        ))}
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
