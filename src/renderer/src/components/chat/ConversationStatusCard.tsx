import type { SessionSdkChromeEvent } from '../../../../shared/harness-ui-types'

/**
 * Ephemeral SDK status row in the transcript (approved mock: `.conversation-status-card`).
 */
export default function ConversationStatusCard({ chrome }: { chrome: SessionSdkChromeEvent }): JSX.Element | null {
  if (chrome.compactFailed) {
    return (
      <div
        className="conversation-status-card conversation-status-card--compacting-failed"
        data-testid="conversation-status-card"
        data-status-kind="compact-failed"
      >
        <div className="conversation-status-head">
          <span className="tool-badge other">COMPACT</span>
          <span className="conversation-status-title">Compaction failed</span>
        </div>
        <div className="conversation-status-detail">
          Context could not be reduced automatically. Try /compact manually or start a fork.
        </div>
        {chrome.compactError && (
          <div className="conversation-status-meta" data-testid="conversation-status-meta">
            compact_error: {chrome.compactError}
          </div>
        )}
      </div>
    )
  }

  if (!chrome.status) return null

  if (chrome.status === 'requesting') {
    return null
  }

  if (chrome.status === 'minion_setup') {
    return (
      <div
        className="conversation-status-card conversation-status-card--requesting"
        data-testid="conversation-status-card"
        data-status-kind="minion-setup"
      >
        <div className="conversation-status-head">
          <span className="tool-badge other">SETUP</span>
          <span className="conversation-status-title">{chrome.title ?? 'Setting up environment…'}</span>
          <span className="spinner" />
        </div>
        {chrome.setupSteps && chrome.setupSteps.length > 0 ? (
          <div className="minion-setup-steps" data-testid="minion-setup-steps">
            {chrome.setupSteps.map((step) => (
              <span
                key={step.id}
                className={`minion-setup-step minion-setup-step--${step.state}`}
                data-step={step.id}
                data-state={step.state}
              >
                {step.label}
                {step.state === 'active' ? ' · IN PROGRESS' : step.state === 'done' ? ' ✓' : ''}
              </span>
            ))}
          </div>
        ) : null}
        <div className="conversation-status-progress conversation-status-progress--accent" aria-hidden="true">
          <span />
        </div>
        <div className="conversation-status-detail">
          {chrome.detail ?? 'DevPod is coming up — this can take a minute.'}
        </div>
      </div>
    )
  }

  if (chrome.status === 'compacting') {
    return (
      <div
        className="conversation-status-card conversation-status-card--compacting"
        data-testid="conversation-status-card"
        data-status-kind="compacting"
      >
        <div className="conversation-status-head">
          <span className="tool-badge other">COMPACT</span>
          <span className="conversation-status-title">Compacting conversation…</span>
          <span className="spinner" />
        </div>
        <div className="conversation-status-progress" aria-hidden="true">
          <span />
        </div>
        <div className="conversation-status-detail">
          Summarizing older messages so the session fits the context window.
        </div>
        {chrome.permissionMode && (
          <div className="conversation-status-meta" data-testid="conversation-status-meta">
            permissionMode: {chrome.permissionMode}
          </div>
        )}
      </div>
    )
  }

  return null
}
