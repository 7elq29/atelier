import type { PlanProposedContent } from '../../../../shared/chat-content'
import type { PromptDecision } from '../../../../shared/session-types'

/**
 * Minimal markdown-ish renderer for plan text (the SDK's `ExitPlanMode`
 * `plan` field is free-form markdown — verified live: headings, a numbered
 * list, prose). No markdown dependency in this project yet, so this handles
 * just enough to satisfy spec.md's "arbitrary rendered markdown" requirement
 * for the plan body: `#`/`##` headings, `1. `-numbered lists, and paragraphs.
 */
function renderPlanBody(plan: string): JSX.Element[] {
  const lines = plan.split('\n')
  const blocks: JSX.Element[] = []
  let listItems: string[] = []
  let key = 0

  function flushList(): void {
    if (listItems.length === 0) return
    blocks.push(
      <ol key={`ol-${key++}`}>
        {listItems.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ol>
    )
    listItems = []
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    const numbered = line.match(/^\d+[.)]\s+(.*)$/)
    if (heading) {
      flushList()
      blocks.push(<h4 key={`h-${key++}`}>{heading[2]}</h4>)
    } else if (numbered) {
      listItems.push(numbered[1])
    } else {
      flushList()
      blocks.push(<p key={`p-${key++}`}>{line}</p>)
    }
  }
  flushList()
  return blocks
}

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
  onRespond
}: {
  content: PlanProposedContent
  onRespond: (decision: PromptDecision) => void
}): JSX.Element {
  const resolved = content.status !== 'pending'

  return (
    <div className={`plan-card${resolved ? ' resolved' : ''}`} data-testid="plan-card" data-status={content.status}>
      <div className="plan-head">
        <span aria-hidden="true">▤</span> Proposed plan
      </div>
      <div className="plan-body" data-testid="plan-body">
        {renderPlanBody(content.plan)}
      </div>
      <div className="plan-actions" data-testid="plan-actions">
        <button className="btn btn-allow" data-testid="plan-accept" onClick={() => onRespond({ kind: 'plan', decision: 'accept' })}>
          Accept plan
        </button>
        <button className="btn btn-deny" data-testid="plan-reject" onClick={() => onRespond({ kind: 'plan', decision: 'reject' })}>
          Reject
        </button>
        <button
          className="btn btn-keep-planning"
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
      </div>
    </div>
  )
}
