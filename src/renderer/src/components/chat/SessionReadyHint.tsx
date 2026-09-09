/**
 * Empty-transcript hint for a session that is connected but has nothing in it
 * yet (session-ready-hint). The connecting phase is already covered by
 * `SessionDisconnectedPanel`, which gates the whole session until the harness
 * is up — so by the time the chat renders at all, the session can answer. What
 * was missing is any sign of that: a brand-new session dropped the user into a
 * blank pane that reads the same as one that is quietly broken.
 */
export function SessionReadyHint({ workspaceLabel }: { workspaceLabel: string }): JSX.Element {
  return (
    <div className="session-ready-hint" data-testid="session-ready-hint">
      <div className="ready-icon">✨</div>
      <div className="ready-title">Ready to chat</div>
      <div className="ready-sub">
        Connected to <strong>{workspaceLabel}</strong>. Ask anything about the project to get
        started.
      </div>
      <div className="ready-meta">
        <kbd>Enter</kbd> to send · <kbd>⌘K</kbd> for commands
      </div>
    </div>
  )
}
