/**
 * Full main-area gate when a claude-code session has no live harness
 * (startup-idle, closed in history, or reconnect in flight). Chat/diff/files/terminal
 * stay unavailable until connected.
 */
export default function SessionDisconnectedPanel({
  onReconnect,
  connecting
}: {
  onReconnect: () => void
  connecting?: boolean
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
              Loading diff and workspace panels for this session. Chat, diff, files, and terminal will
              open when ready — switch to another session after this finishes.
            </p>
            <div className="session-connecting-status" aria-live="polite">
              <span className="spinner" aria-hidden />
              <span>Loading diff…</span>
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
