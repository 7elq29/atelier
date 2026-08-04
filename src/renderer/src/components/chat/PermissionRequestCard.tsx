import { useState } from 'react'
import type { PermissionRequestContent } from '../../../../shared/chat-content'
import type { PromptDecision } from '../../../../shared/session-types'

function commandText(content: PermissionRequestContent): string {
  const input = content.input as Record<string, unknown> | undefined
  if (content.toolName === 'Bash' && typeof input?.command === 'string') return input.command
  if (typeof input?.file_path === 'string') return input.file_path
  return content.toolName
}

/**
 * Permission/approval card (05-interactive-prompts) — a real in-chat
 * Allow/Deny prompt sourced from the SDK's `canUseTool` callback, surfaced
 * BEFORE the tool runs (not inferred after the fact from a tool_result).
 * Checking "always allow" echoes the SDK's own offered `PermissionUpdate`
 * suggestion back with a session-scoped destination, so the SDK's own
 * permission engine — not a client-side re-implementation — skips
 * `canUseTool` for matching future calls this session.
 *
 * Markup/classes copied verbatim from mocks/index.html's `.perm-card` block
 * (lines ~776-790): `.perm-head`, `.perm-body`, `.perm-cmd`, `.perm-actions`
 * with `.btn-allow`/`.btn-deny` + `.perm-remember` checkbox, `.perm-resolved`.
 */
export default function PermissionRequestCard({
  content,
  onRespond
}: {
  content: PermissionRequestContent
  onRespond: (decision: PromptDecision) => void
}): JSX.Element {
  const [alwaysAllow, setAlwaysAllow] = useState(false)
  const resolved = content.status !== 'pending'

  return (
    <div className="perm-card" data-testid="permission-card" data-status={content.status}>
      <div className="perm-head">
        <span aria-hidden="true">⚠</span> Permission required
      </div>
      <div className="perm-body">
        <div>{content.title ?? content.description ?? `Claude wants to use ${content.toolName}`}</div>
        <div className="perm-cmd" data-testid="perm-cmd">
          {commandText(content)}
        </div>
        {!resolved ? (
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
            {content.suggestedPattern && (
              <label className="perm-remember">
                <input
                  type="checkbox"
                  data-testid="perm-always-allow"
                  checked={alwaysAllow}
                  onChange={(e) => setAlwaysAllow(e.target.checked)}
                />
                Always allow <code>{content.suggestedPattern}</code>
              </label>
            )}
          </div>
        ) : (
          <div className={`perm-resolved ${content.status}`} data-testid="perm-resolved">
            {content.status === 'expired'
              ? 'This request expired — the turn ended before you could respond.'
              : content.status === 'allowed'
                ? content.alwaysAllowed
                  ? `Allowed — will always allow ${content.suggestedPattern ?? 'this pattern'} for the rest of this session`
                  : 'Allowed'
                : 'Denied'}
          </div>
        )}
      </div>
    </div>
  )
}
