/**
 * A small tab-shaped chip pinned to the left edge of the app when the sidebar
 * is hidden and a session needs attention. Clicking it re-expands the sidebar
 * and navigates to the session.
 */
import type { SessionRecord } from '../../../shared/session-types'

interface CollapsedAlertChipProps {
  session: SessionRecord
  /** 'blocked' = needs approval (permission/question/plan), 'ready' = agent done, waiting for next message */
  kind: 'blocked' | 'ready'
  /** 1-based shortcut index shown after the session name */
  shortcutNumber?: number
  /** When true, chip expands to show the session name inline (⌘-held mode) */
  cmdHeld?: boolean
  onClick: () => void
}

export default function CollapsedAlertChip({ session, kind, shortcutNumber, cmdHeld, onClick }: CollapsedAlertChipProps): JSX.Element {
  const label = session.name || session.projectPath.split('/').filter(Boolean).pop() || 'Session'
  const statusLabel = kind === 'blocked' ? 'Needs approval' : 'Agent ready'

  return (
    <div
      className={`collapsed-alert-chip collapsed-alert-chip--${kind}${cmdHeld ? ' cmd-held' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${statusLabel}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      data-testid={`collapsed-alert-chip-${session.id}`}
    >
      {/* Compact (non-cmd-held): ⌘N replaces the icon. Expanded (cmd-held): icon + name + ⌘N */}
      {!cmdHeld && shortcutNumber != null ? (
        <span className="chip-shortcut-label">⌘{shortcutNumber}</span>
      ) : kind === 'blocked' ? (
        <svg className="chip-icon" viewBox="0 0 16 16" fill="none"
          stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="8" cy="8" r="6.2"/>
          <line x1="8" y1="5.5" x2="8" y2="8.5"/>
          <circle cx="8" cy="10.5" r="0.5" fill="currentColor" stroke="none"/>
        </svg>
      ) : (
        <span className="chip-dot" />
      )}

      {/* Session name — always in DOM, visible only when cmdHeld via CSS transition */}
      <span className="chip-name-label">{label}</span>
      {cmdHeld && shortcutNumber != null && (
        <span className="chip-shortcut-label">⌘{shortcutNumber}</span>
      )}

      {/* Tooltip — appears on hover via CSS */}
      <div className="chip-tooltip" role="tooltip">
        <div className="chip-tooltip-name">{label}</div>
        <div className="chip-tooltip-status">
          <span className="chip-tooltip-dot" />
          {statusLabel}
        </div>
        <div className="chip-tooltip-hint">{shortcutNumber != null ? `⌘${shortcutNumber} · Click to open` : 'Click to open'}</div>
      </div>
    </div>
  )
}
