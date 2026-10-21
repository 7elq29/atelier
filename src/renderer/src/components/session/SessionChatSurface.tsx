import { useEffect } from 'react'
import type { SessionRecord } from '../../../../shared/session-types'
import type { SessionSdkChromeEvent } from '../../../../shared/harness-ui-types'
import type { BackgroundTaskRow } from '../../../../shared/harness-ui-types'
import type { PromptDecision } from '../../../../shared/session-types'
import type { ReviewPaneTarget, ReviewComposerComment } from '../../../../shared/review-pane-types'
import type {
  CreateSessionBookmarkInput,
  SessionBookmark
} from '../../../../shared/session-bookmarks'
import { useSessionMessages, useTranscriptTruncation } from '../../hooks/useSessionMessages'
import ChatTranscript from '../chat/ChatTranscript'
import TrackerRail from '../chat/TrackerRail'
import ResponseReviewPanel from '../chat/ResponseReviewPanel'
import { SessionReadyHint } from '../chat/SessionReadyHint'
import { sessionFileLinkWorkspaceRoot } from '../chat/file-path-links'
import { sessionWorkspaceLabel } from '../../utils/sessionWorkspaceLabel'

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
  bookmarks,
  onToggleBookmark,
  sdkChrome,
  backgroundTasks,
  onRespondToPrompt,
  reviewTarget,
  onReviewMessage,
  onReviewPlan,
  onCloseReview,
  effectiveTheme,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  reviewComments = [],
  busy = false,
  onRetryTurn,
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
  bookmarks: readonly SessionBookmark[]
  onToggleBookmark: (bookmark: CreateSessionBookmarkInput, bookmarked: boolean) => void
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
  effectiveTheme: 'light' | 'dark'
  onAddComment: (text: string) => void
  onUpdateComment: (oldNote: string, newNote: string) => void
  onDeleteComment: (composerNote: string) => void
  reviewComments?: readonly ReviewComposerComment[]
  busy?: boolean
  onRetryTurn?: () => void
}): JSX.Element {
  const messages = useSessionMessages(session.id)
  const truncation = useTranscriptTruncation(session.id)
  const workspaceRoot = sessionFileLinkWorkspaceRoot(session)
  const projectRoot = session.worktreePath ?? session.projectPath

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
    <>
      <div className={`chat-body-row${reviewTarget ? ' response-review-open' : ''}`}>
        <div className="chat-main-col">
          <ChatTranscript
            messages={messages}
            transcriptTruncated={truncation?.transcriptTruncated}
            hiddenTurnCount={truncation?.hiddenTurnCount ?? 0}
            onRespond={(requestId, decision) => onRespondToPrompt(requestId, decision)}
            searchQuery={transcriptSearchOpen ? transcriptSearchQuery : ''}
            activeMatchIndex={activeMatchIndex}
            onMatchCount={onMatchCount}
            onOpenPlanFile={onOpenFileInFiles}
            workspaceRoot={workspaceRoot}
            projectRoot={projectRoot}
            filePathCandidates={filePathCandidates}
            onOpenFileInFiles={onOpenFileInFiles}
            bookmarks={bookmarks}
            onToggleBookmark={onToggleBookmark}
            sdkChrome={sdkChrome}
            onReviewMessage={onReviewMessage}
            onReviewPlan={onReviewPlan}
            reviewTarget={reviewTarget}
            onAddComment={onAddComment}
            onUpdateComment={onUpdateComment}
            onDeleteComment={onDeleteComment}
            reviewComments={reviewComments}
            busy={busy}
            onRetryTurn={onRetryTurn}
            // Past the session connecting gate — but Minion SETUP still owns the
            // empty pane (Provision/Boot/Connect). "Ready to chat" during SETUP
            // looked like DevPod boot failed while Minion UI was still Connecting.
            emptyState={
              sdkChrome?.status === 'minion_setup' ? null : (
                <SessionReadyHint workspaceLabel={sessionWorkspaceLabel(session)} />
              )
            }
          />
        </div>
        {reviewTarget ? (
          <ResponseReviewPanel
            target={reviewTarget}
            onClose={onCloseReview}
            onAddComment={onAddComment}
            onUpdateComment={onUpdateComment}
            onDeleteComment={onDeleteComment}
            reviewComments={reviewComments}
            workspaceRoot={workspaceRoot}
            projectRoot={projectRoot}
            onOpenFileInFiles={onOpenFileInFiles}
            effectiveTheme={effectiveTheme}
          />
        ) : null}
      </div>
      {!reviewTarget ? (
        <TrackerRail messages={messages} backgroundTasks={backgroundTasks} />
      ) : null}
    </>
  )
}
