/**
 * Full main-area gate when a claude-code or cortana session has no live harness
 * (startup-idle, closed in history, or reconnect in flight). Chat/diff/files/terminal
 * stay unavailable until connected.
 */
export default function SessionDisconnectedPanel({
  onReconnect,
  connecting,
  connectStatusLabel
}: {
  onReconnect: () => void
  connecting?: boolean
  /** Current essential preload step (SSH, files, terminal, git probe). */
  connectStatusLabel?: string | null
}): JSX.Element {
  return (
    <div className="empty-main session-disconnected-panel" data-testid="session-disconnected-panel">
      <div className="session-disconnected-card">
        {connecting ? (
          <>
            <div className="session-disconnected-title" data-testid="session-connecting-state">
              Connecting…
            </div>
            <p className="session-disconnected-body">
              Preparing chat, diff, files, and terminal for this session. You can switch to other
              sessions or use the rest of the app while this finishes.
            </p>
            <div className="session-connecting-status" aria-live="polite" data-testid="session-connecting-step">
              <span className="spinner" aria-hidden />
              <span>{connectStatusLabel ?? 'Loading workspace…'}</span>
            </div>
          </>
        ) : (
          <>
            <div className="session-disconnected-title">Session disconnected</div>
            <p className="session-disconnected-body">
              This session is not connected. Reconnect to open chat, diff, files, and terminal.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="session-reconnect-button"
              onClick={onReconnect}
            >
              Reconnect
            </button>
          </>
        )}
      </div>
    </div>
  )
}
