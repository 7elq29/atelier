import { useEffect } from 'react'
import type { SessionRecord } from '../../../../shared/session-types'
import type { SessionSdkChromeEvent } from '../../../../shared/harness-ui-types'
import type { BackgroundTaskRow } from '../../../../shared/harness-ui-types'
import type { PromptDecision } from '../../../../shared/session-types'
import type { ReviewPaneTarget } from '../../../../shared/review-pane-types'
import { useSessionMessages } from '../../hooks/useSessionMessages'
import ChatTranscript from '../chat/ChatTranscript'
import TrackerRail from '../chat/TrackerRail'
import ResponseReviewPanel from '../chat/ResponseReviewPanel'
import { sessionFileLinkWorkspaceRoot } from '../chat/file-path-links'

/** Chat transcript + tracker rail — isolated from App so stream deltas skip workspace panels. */
export function SessionChatSurface({
  session,
  pendingJumpMessageId,
  onJumpHandled,
  transcriptSearchOpen,
  transcriptSearchQuery,
  activeMatchIndex,
  onMatchCount,
  onOpenFileInFiles,
  filePathCandidates,
  sdkChrome,
  backgroundTasks,
  onRespondToPrompt,
  reviewTarget,
  onReviewMessage,
  onReviewPlan,
  onCloseReview,
  onAddComment,
  onUpdateComment
}: {
  session: SessionRecord
  pendingJumpMessageId: number | null
  onJumpHandled: () => void
  transcriptSearchOpen: boolean
  transcriptSearchQuery: string
  activeMatchIndex: number
  onMatchCount: (count: number) => void
  onOpenFileInFiles: (path: string) => void
  filePathCandidates?: readonly string[]
  sdkChrome: SessionSdkChromeEvent | null
  backgroundTasks: BackgroundTaskRow[]
  onRespondToPrompt: (requestId: string, decision: PromptDecision) => void
  reviewTarget: ReviewPaneTarget | null
  onReviewMessage: (message: { id: number; content: string }) => void
  onReviewPlan: (
    message: { id: number },
    planMarkdown: string,
    previousPlanMarkdown: string | undefined
  ) => void
  onCloseReview: () => void
  onAddComment: (text: string) => void
  onUpdateComment: (oldNote: string, newNote: string) => void
}): JSX.Element {
  const messages = useSessionMessages(session.id)
  const workspaceRoot = sessionFileLinkWorkspaceRoot(session)

  useEffect(() => {
    if (pendingJumpMessageId == null) return
    const el = document.querySelector<HTMLElement>(
      `[data-testid="transcript-message"][data-message-id="${pendingJumpMessageId}"]`
    )
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.classList.add('msg-jump-highlight')
    const timer = setTimeout(() => el.classList.remove('msg-jump-highlight'), 1600)
    onJumpHandled()
    return () => clearTimeout(timer)
  }, [pendingJumpMessageId, messages.length, onJumpHandled])

  return (
    <div className={`chat-body-row${reviewTarget ? ' response-review-open' : ''}`}>
      <div className="chat-main-col">
        <ChatTranscript
          messages={messages}
          onRespond={(requestId, decision) => onRespondToPrompt(requestId, decision)}
          searchQuery={transcriptSearchOpen ? transcriptSearchQuery : ''}
          activeMatchIndex={activeMatchIndex}
          onMatchCount={onMatchCount}
          onOpenPlanFile={onOpenFileInFiles}
          workspaceRoot={workspaceRoot}
          projectRoot={session.projectPath}
          filePathCandidates={filePathCandidates}
          onOpenFileInFiles={onOpenFileInFiles}
          sdkChrome={sdkChrome}
          backgroundTasks={backgroundTasks}
          onReviewMessage={onReviewMessage}
          onReviewPlan={onReviewPlan}
          reviewTarget={reviewTarget}
        />
      </div>
      <TrackerRail messages={messages} backgroundTasks={backgroundTasks} />
      {reviewTarget ? (
        <ResponseReviewPanel
          target={reviewTarget}
          onClose={onCloseReview}
          onAddComment={onAddComment}
          onUpdateComment={onUpdateComment}
          workspaceRoot={workspaceRoot}
          projectRoot={session.projectPath}
          onOpenFileInFiles={onOpenFileInFiles}
        />
      ) : null}
    </div>
  )
}
