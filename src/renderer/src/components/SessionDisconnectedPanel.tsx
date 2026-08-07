/**
 * Full main-area gate when a claude-code session has no live harness
 * (startup-idle or closed in history). Chat/diff/files/terminal stay unavailable
 * until the user reconnects.
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
        <div className="session-disconnected-title">Session disconnected</div>
        <p className="session-disconnected-body">
          This session is not connected. Reconnect to open chat, diff, files, and terminal.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="session-reconnect-button"
          onClick={onReconnect}
          disabled={connecting}
        >
          {connecting ? 'Connecting…' : 'Reconnect'}
        </button>
      </div>
    </div>
  )
}
