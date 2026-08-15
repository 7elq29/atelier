import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { PlanProposedContent } from '../../../../shared/chat-content'
import type { PromptDecision } from '../../../../shared/session-types'
import { createMarkdownComponents } from './MarkdownMessage'
import ReviewPaneIconButton from './ReviewPaneIconButton'
import ResolvedPromptFold from './ResolvedPromptFold'
import TranscriptInlineComments from './TranscriptInlineComments'
import type { ReviewComposerComment } from '../../../../shared/review-pane-types'
import { planFoldSummary } from './resolved-prompt-fold'

/**
 * Plan card (05-interactive-prompts) — dedicated card for the SDK's
 * ExitPlanMode tool call. Resolved cards merge into the tool-sequence summary
 * when embedded in an activity run; standalone cards keep their own fold row.
 */
export default function PlanProposedCard({
  content,
  onRespond,
  onOpenPlanFile,
  onReviewPlan,
  reviewActive,
  messageId,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  reviewComments = [],
  workspaceRoot,
  projectRoot,
  filePathCandidates,
  embedded = false
}: {
  content: PlanProposedContent
  onRespond: (decision: PromptDecision) => void
  onOpenPlanFile?: (planFilePath: string) => void
  onReviewPlan?: () => void
  reviewActive?: boolean
  messageId: number
  onAddComment?: (note: string) => void
  onUpdateComment?: (oldNote: string, newNote: string) => void
  onDeleteComment?: (composerNote: string) => void
  reviewComments?: readonly ReviewComposerComment[]
  workspaceRoot?: string
  projectRoot?: string
  filePathCandidates?: readonly string[]
  embedded?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const resolved = content.status !== 'pending'
  const planMarkdownComponents = createMarkdownComponents({
    workspaceRoot,
    projectRoot,
    filePathCandidates,
    onOpenFileInFiles: onOpenPlanFile
  })

  const planMarkdown = (
    <div className="md-body">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={planMarkdownComponents}>
        {content.plan}
      </ReactMarkdown>
    </div>
  )

  const planBody = (
    <>
      <div className="plan-body" data-testid="plan-body">
        {onAddComment ? (
          <TranscriptInlineComments
            messageId={messageId}
            sourceContent={content.plan}
            commentPrefix="Re plan"
            onAddComment={onAddComment}
            onUpdateComment={onUpdateComment}
            onDeleteComment={onDeleteComment}
            reviewComments={reviewComments}
          >
            {planMarkdown}
          </TranscriptInlineComments>
        ) : (
          planMarkdown
        )}
      </div>
      <div className="plan-resolved-note" data-testid="plan-resolved-note">
        {content.status === 'accepted' && 'Plan accepted — Claude is proceeding.'}
        {content.status === 'rejected' && 'Plan rejected.'}
        {content.status === 'keep_planning' && 'Asked Claude to keep planning.'}
        {content.status === 'expired' && 'This request expired — the turn ended before you could respond.'}
      </div>
    </>
  )

  const resolvedBody = (
    <div
      className={`plan-card resolved open${reviewActive ? ' response-review-selected' : ''}`}
      data-testid="plan-card"
      data-status={content.status}
    >
      <div className="plan-head">
        <span className="plan-head-title">
          <span aria-hidden="true">▤</span> Proposed plan
        </span>
        {onReviewPlan ? (
          <ReviewPaneIconButton
            title="Review plan"
            testId="plan-review-button"
            active={reviewActive}
            onClick={onReviewPlan}
          />
        ) : null}
      </div>
      {planBody}
    </div>
  )

  if (resolved) {
    if (embedded) return resolvedBody
    return (
      <ResolvedPromptFold
        testId="plan-card"
        summaryTestId="plan-resolved-summary"
        summary={planFoldSummary(content)}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        status={content.status}
        headExtra={
          onReviewPlan ? (
            <span className="prompt-fold-head-extra" onClick={(e) => e.stopPropagation()}>
              <ReviewPaneIconButton
                title="Review plan"
                testId="plan-review-button"
                active={reviewActive}
                onClick={onReviewPlan}
              />
            </span>
          ) : null
        }
      >
        {resolvedBody}
      </ResolvedPromptFold>
    )
  }

  return (
    <div
      className={`plan-card${reviewActive ? ' response-review-selected' : ''}`}
      data-testid="plan-card"
      data-status={content.status}
    >
      <div className="plan-head">
        <span className="plan-head-title">
          <span aria-hidden="true">▤</span> Proposed plan
        </span>
        {onReviewPlan ? (
          <ReviewPaneIconButton
            title="Review plan"
            testId="plan-review-button"
            active={reviewActive}
            onClick={onReviewPlan}
          />
        ) : null}
      </div>
      {planBody}
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
    </div>
  )
}
