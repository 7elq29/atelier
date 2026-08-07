import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PlanProposedContent } from '../../../../shared/chat-content'
import type { PromptDecision } from '../../../../shared/session-types'
import { createMarkdownComponents } from './MarkdownMessage'

/**
 * Plan card (05-interactive-prompts) — dedicated card for the SDK's
 * `ExitPlanMode` tool call, with Accept/Reject/Keep-planning actions that
 * resolve the REAL SDK-side plan approval: accepting calls
 * `query.setPermissionMode('default')` inside the harness (verified live —
 * `canUseTool` allowing the tool call alone does not exit plan mode),
 * rejecting/keep-planning deny the tool call with feedback text so Claude
 * stays in planning.
 *
 * Markup/classes copied verbatim from mocks/index.html's `.plan-card` block
 * (lines ~810-824): `.plan-head`, `.plan-body`, `.plan-actions` with
 * `.btn-allow`="Accept plan"/`.btn-deny`="Reject"/`.btn-keep-planning`, and
 * `.plan-resolved-note`.
 */
export default function PlanProposedCard({
  content,
  onRespond,
  onOpenPlanFile,
  workspaceRoot,
  projectRoot
}: {
  content: PlanProposedContent
  onRespond: (decision: PromptDecision) => void
  /** Opens `planFilePath` in the Files tab (07-secondary-panels). */
  onOpenPlanFile?: (planFilePath: string) => void
  workspaceRoot?: string
  projectRoot?: string
}): JSX.Element {
  const resolved = content.status !== 'pending'
  const planMarkdownComponents = createMarkdownComponents({
    workspaceRoot,
    projectRoot,
    onOpenFileInFiles: onOpenPlanFile
  })

  return (
    <div className={`plan-card${resolved ? ' resolved' : ''}`} data-testid="plan-card" data-status={content.status}>
      <div className="plan-head">
        <span className="plan-head-title">
          <span aria-hidden="true">▤</span> Proposed plan
        </span>
        {content.planFilePath && onOpenPlanFile && (
          <button
            type="button"
            className="btn btn-sm plan-open-in-files"
            data-testid="plan-open-in-files"
            onClick={() => onOpenPlanFile(content.planFilePath!)}
          >
            Open in Files
          </button>
        )}
      </div>
      <div className="plan-body" data-testid="plan-body">
        <div className="md-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={planMarkdownComponents}>
            {content.plan}
          </ReactMarkdown>
        </div>
      </div>
      <div className="plan-actions" data-testid="plan-actions">
        <button
          type="button"
          className="btn btn-sm btn-allow"
          data-testid="plan-accept"
          onClick={() => onRespond({ kind: 'plan', decision: 'accept' })}
        >
          Accept plan
        </button>
        <button
          type="button"
          className="btn btn-sm btn-deny"
          data-testid="plan-reject"
          onClick={() => onRespond({ kind: 'plan', decision: 'reject' })}
        >
          Reject
        </button>
        <button
          type="button"
          className="btn btn-sm btn-keep-planning"
          data-testid="plan-keep-planning"
          onClick={() => onRespond({ kind: 'plan', decision: 'keep_planning' })}
        >
          Keep planning
        </button>
      </div>
      <div className="plan-resolved-note" data-testid="plan-resolved-note">
        {content.status === 'accepted' && 'Plan accepted — Claude is proceeding.'}
        {content.status === 'rejected' && 'Plan rejected.'}
        {content.status === 'keep_planning' && 'Asked Claude to keep planning.'}
        {content.status === 'expired' && 'This request expired — the turn ended before you could respond.'}
      </div>
    </div>
  )
}
