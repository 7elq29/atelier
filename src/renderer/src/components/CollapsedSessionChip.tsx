/**
 * A left-edge chip showing an active (non-alert) session when the sidebar is
 * collapsed and ⌘ is held. Shares the same shape and tooltip pattern as
 * CollapsedAlertChip but uses the session's color dot instead of a warning icon.
 */
import type { SessionRecord } from '../../../shared/session-types'

interface CollapsedSessionChipProps {
  session: SessionRecord
  /** 'working' = agent is active, anything else = idle/disconnected */
  dotStatus: string
  /** 1-based shortcut index shown as ⌘N label (replaces the dot when provided) */
  shortcutNumber?: number
  onClick: () => void
}

export default function CollapsedSessionChip({ session, dotStatus, shortcutNumber, onClick }: CollapsedSessionChipProps): JSX.Element {
  const label = session.name || session.projectPath.split('/').filter(Boolean).pop() || 'Session'
  const isWorking = dotStatus === 'working'
  const dotColor = session.color ?? 'var(--text-tertiary)'
  const statusLabel = isWorking ? 'Working…' : 'Idle'

  return (
    <div
      className={`collapsed-alert-chip collapsed-alert-chip--session${isWorking ? '' : ' collapsed-alert-chip--session-idle'}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`${label}: ${statusLabel}`}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      data-testid={`collapsed-session-chip-${session.id}`}
    >
      {shortcutNumber != null ? (
        <span className="chip-shortcut-label chip-shortcut-label--session">⌘{shortcutNumber}</span>
      ) : (
        <span
          className={`chip-session-dot${isWorking ? ' chip-session-dot--working' : ''}`}
          style={{ background: dotColor }}
        />
      )}
      <span className="chip-name-label">{label}</span>

      <div className="chip-tooltip" role="tooltip">
        <div className="chip-tooltip-name">{label}</div>
        <div className="chip-tooltip-status chip-tooltip-status--session">
          <span className="chip-tooltip-dot" style={{ background: dotColor }} />
          {statusLabel}
        </div>
        <div className="chip-tooltip-hint">Click to open</div>
      </div>
    </div>
  )
}
