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
    // Approved: Features/UI-Design/mocks/minion-setup-card-options.html option C
    // (segmented bar; amber cue — not sage accent chips).
    const steps = chrome.setupSteps ?? []
    return (
      <div
        className="conversation-status-card conversation-status-card--minion-setup"
        data-testid="conversation-status-card"
        data-status-kind="minion-setup"
      >
        <div className="conversation-status-head">
          <span className="tool-badge other">SETUP</span>
          <span className="conversation-status-title">{chrome.title ?? 'Setting up environment…'}</span>
          <span className="spinner" />
        </div>
        {steps.length > 0 ? (
          <div className="minion-setup-steps" data-testid="minion-setup-steps">
            <div
              className="minion-setup-bar"
              style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}
              aria-hidden="true"
            >
              {steps.map((step) => (
                <span
                  key={`seg-${step.id}`}
                  className={`minion-setup-seg minion-setup-seg--${step.state}`}
                />
              ))}
            </div>
            <div
              className="minion-setup-labels"
              style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}
            >
              {steps.map((step, i) => (
                <span
                  key={step.id}
                  className={`minion-setup-step minion-setup-step--${step.state}`}
                  data-step={step.id}
                  data-state={step.state}
                  style={
                    i === 0
                      ? undefined
                      : i === steps.length - 1
                        ? { textAlign: 'right' }
                        : { textAlign: 'center' }
                  }
                >
                  {step.label}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="conversation-status-progress" aria-hidden="true">
            <span />
          </div>
        )}
        <div className="conversation-status-detail">
          {chrome.detail ?? 'DevPod is coming up — this can take a minute.'}
        </div>
      </div>
    )
  }

  // minion_working renders above the composer (Composer.tsx), not in the transcript.

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
