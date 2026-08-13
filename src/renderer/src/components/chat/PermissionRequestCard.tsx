import { useState } from 'react'
import type { PermissionRequestContent } from '../../../../shared/chat-content'
import type { PromptDecision } from '../../../../shared/session-types'
import ResolvedPromptFold from './ResolvedPromptFold'
import { permissionCommandText, permissionFoldSummary } from './resolved-prompt-fold'

/**
 * Permission/approval card (05-interactive-prompts) — a real in-chat
 * Allow/Deny prompt sourced from the SDK's `canUseTool` callback, surfaced
 * BEFORE the tool runs (not inferred after the fact from a tool_result).
 */
export default function PermissionRequestCard({
  content,
  onRespond,
  embedded = false
}: {
  content: PermissionRequestContent
  onRespond: (decision: PromptDecision) => void
  embedded?: boolean
}): JSX.Element {
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const [open, setOpen] = useState(false)
  const resolved = content.status !== 'pending'
  const command = permissionCommandText(content)

  const resolvedBody = (
    <div className="perm-card resolved open" data-testid="permission-card" data-status={content.status}>
      <div className="perm-head">
        <span aria-hidden="true">⚠</span> Permission required
      </div>
      <div className="perm-body">
        <div>{content.title ?? content.description ?? `Claude wants to use ${content.toolName}`}</div>
        <div className="perm-cmd" data-testid="perm-cmd">
          {command}
        </div>
        <div className={`perm-resolved ${content.status}`} data-testid="perm-resolved">
          {content.status === 'expired'
            ? 'This request expired — the turn ended before you could respond.'
            : content.status === 'allowed'
              ? content.alwaysAllowed
                ? `Allowed — will always allow ${content.suggestedPattern ?? 'this pattern'} for the rest of this session`
                : 'Allowed'
              : 'Denied'}
        </div>
      </div>
    </div>
  )

  if (resolved) {
    if (embedded) return resolvedBody
    return (
      <ResolvedPromptFold
        testId="permission-card"
        summaryTestId="perm-resolved-summary"
        summary={permissionFoldSummary(content, command)}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        status={content.status}
      >
        {resolvedBody}
      </ResolvedPromptFold>
    )
  }

  return (
    <div className="perm-card" data-testid="permission-card" data-status={content.status}>
      <div className="perm-head">
        <span aria-hidden="true">⚠</span> Permission required
      </div>
      <div className="perm-body">
        <div>{content.title ?? content.description ?? `Claude wants to use ${content.toolName}`}</div>
        <div className="perm-cmd" data-testid="perm-cmd">
          {command}
        </div>
        <div className="perm-actions" data-testid="perm-actions">
          <button
            className="btn btn-allow"
            data-testid="perm-allow"
            onClick={() => onRespond({ kind: 'permission', decision: 'allow', alwaysAllow })}
          >
            Allow
          </button>
          <button
            className="btn btn-deny"
            data-testid="perm-deny"
            onClick={() => onRespond({ kind: 'permission', decision: 'deny' })}
          >
            Deny
          </button>
          {content.suggestedPattern ? (
            <label className="perm-always" data-testid="perm-always-allow-label">
              <input
                type="checkbox"
                data-testid="perm-always-allow"
                checked={alwaysAllow}
                onChange={(e) => setAlwaysAllow(e.target.checked)}
              />
              Always allow {content.suggestedPattern} for this session
            </label>
          ) : null}
        </div>
      </div>
    </div>
  )
}
