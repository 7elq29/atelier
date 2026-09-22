/**
 * A left-edge chip showing an active (non-alert) session when ⌘ is held.
 * Shares the same shape and tooltip pattern as CollapsedAlertChip but uses
 * SessionStatusIndicator for the status glyph.
 */
import { SessionStatusIndicator } from './SessionStatusIndicator'
import type { SessionRecord } from '../../../shared/session-types'

interface CollapsedSessionChipProps {
  session: SessionRecord
  dotStatus: string
  /** 1-based shortcut index shown as ⌘N hint after the session name */
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
      <SessionStatusIndicator dotStatus={dotStatus} />
      <span className="chip-name-label">{label}</span>
      {shortcutNumber != null && (
        <span className="chip-shortcut-label chip-shortcut-label--session">⌘{shortcutNumber}</span>
      )}

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
