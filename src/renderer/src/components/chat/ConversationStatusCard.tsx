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
