import { Fragment, useDeferredValue, useEffect, useLayoutEffect, useRef } from 'react'
import type { MessageRecord } from '../../../../shared/session-types'
import type { PromptDecision } from '../../../../shared/session-types'
import { parseStructuredContent, type ToolCallContent, type ThinkingBlockContent, type TranscriptNoticeContent, type LocalCommandOutputContent } from '../../../../shared/chat-content'
import ToolCallCard, { toolHeadline } from './ToolCallCard'
import { isToolAwaitingUserApproval } from './interactive-prompt-status'
import ThinkingBlockInline from './ThinkingBlockInline'
import ToolCallSequence, { type SidecarSequenceEntry, type ToolCallSequenceEntry } from './ToolCallSequence'
import AskUserQuestionCard from './AskUserQuestionCard'
import PermissionRequestCard from './PermissionRequestCard'
import PlanProposedCard from './PlanProposedCard'
import { promptFoldSummary } from './resolved-prompt-fold'
import MarkdownMessage from './MarkdownMessage'
import Linkify from '../panels/Linkify'
import MessageActions from './MessageActions'
import TranscriptInlineComments from './TranscriptInlineComments'
import ConversationStatusCard from './ConversationStatusCard'
import BackgroundTasksConversationCard from './BackgroundTasksConversationCard'
import type { BackgroundTaskRow, SessionSdkChromeEvent } from '../../../../shared/harness-ui-types'
import type { ReviewPaneTarget, ReviewComposerComment } from '../../../../shared/review-pane-types'
import type {
  CreateSessionBookmarkInput,
  SessionBookmark
} from '../../../../shared/session-bookmarks'
import { CHAT_TRANSCRIPT_MAX_TURNS } from '../../../../shared/chat-transcript-window'

/** Above this size, skip ReactMarkdown — a 10k+ token reply can freeze the UI for seconds. */
const LARGE_ASSISTANT_TEXT_CHARS = 48_000

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return `${minutes}m ${seconds}s`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return `${hours}h ${mins}m`
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function taskLabel(tool: ToolCallContent): string {
  return toolHeadline('Task', tool.input)
}

/**
 * Splits `text` on every case-insensitive occurrence of `query`, rendering
 * each match as a real `<mark class="search-hit">` (10b-enrichment-full-text-
 * search) — same class the mock's `mark.search-hit` CSS targets — with a
 * sequential `data-match-index` (via `counter`, shared and mutated across the
 * whole transcript render so indices are in document order) so the search
 * bar can navigate to a specific occurrence via a plain
 * `querySelector('[data-match-index="N"]')` + `scrollIntoView()`, no manual
 * DOM/Range surgery (which would fight React's own reconciliation of this
 * same subtree on the next render — see the mock's `searchTranscript()` for
 * the DOM-Range approach this deliberately avoids).
 */
function highlightMatches(text: string, query: string, counter: { current: number }, activeMatchIndex: number): React.ReactNode {
  if (!query) return text
  const lower = text.toLowerCase()
  const needle = query.toLowerCase()
  const nodes: React.ReactNode[] = []
  let cursor = 0
  let idx = lower.indexOf(needle, cursor)
  let key = 0
  while (idx !== -1) {
    if (idx > cursor) nodes.push(<Fragment key={`t-${key++}`}>{text.slice(cursor, idx)}</Fragment>)
    const matchIndex = counter.current++
    nodes.push(
      <mark
        key={`m-${key++}`}
        className={matchIndex === activeMatchIndex ? 'search-hit active' : 'search-hit'}
        data-testid="search-hit"
        data-match-index={matchIndex}
      >
        {text.slice(idx, idx + query.length)}
      </mark>
    )
    cursor = idx + query.length
    idx = lower.indexOf(needle, cursor)
  }
  if (cursor < text.length) nodes.push(<Fragment key={`t-${key++}`}>{text.slice(cursor)}</Fragment>)
  return nodes
}

interface TopRow {
  message: MessageRecord
  tool?: ToolCallContent
  thinking?: ThinkingBlockContent
}

/**
 * Chat transcript (03-chat-surface-core): streaming assistant text (plain
 * messages, patched live over `session:streamDelta` upstream in
 * useSessions), turn grouping + elapsed-time dividers, tool-call cards, and
 * subagent nesting (tool calls whose `parentToolUseId` matches an earlier
 * top-level Task call render inside a `.subagent-wrap` right after it,
 * instead of flattened into the top-level list) — plus the compaction
 * banner. Markup/classes match mocks/index.html's `.transcript`/
 * `.turn-divider`/`.msg-user`/`.msg-assistant`/`.compaction-banner`/
 * `.subagent-wrap` exactly.
 *
 * `searchQuery`/`activeMatchIndex`/`onMatchCount` (10b-enrichment-full-text-
 * search) drive the in-conversation "Find in conversation" bar: when
 * `searchQuery` is non-empty, every plain user/assistant text message (same
 * `extractSearchableText` classification the FTS5 index uses — never raw
 * tool-call JSON) is rendered through `highlightMatches` instead of
 * Markdown/plain text, and the total match count is reported back via
 * `onMatchCount` after each render so the topbar's "N matches" chip and the
 * up/down navigation clamp stay in sync with what's actually on screen.
 *
 * Plain assistant text (12-markdown-message-rendering — the final `else`
 * branch below, reached only when `parseStructuredContent` returns falsy)
 * renders through `MarkdownMessage` when no transcript search is active.
 * Plain user text uses `Linkify` for http(s) URLs (opens externally via
 * `shell.openExternal`). When a search query IS active, this intentionally
 * keeps showing the plain `highlightMatches(...)` text instead of Markdown/
 * Linkify — merging search highlighting into rendered nodes is out of scope,
 * an accepted limitation, not a bug. Scope is otherwise unchanged: structured
 * cards (`ToolCallCard`, `PlanProposedCard`, `AskUserQuestionCard`,
 * `PermissionRequestCard`, todo updates, image attachments) are never
 * Markdown-rendered.
 */
export default function ChatTranscript({
  messages,
  onRespond,
  onOpenPlanFile,
  workspaceRoot,
  projectRoot,
  filePathCandidates,
  onOpenFileInFiles,
  bookmarks = [],
  onToggleBookmark,
  searchQuery,
  activeMatchIndex = -1,
  onMatchCount,
  sdkChrome,
  backgroundTasks = [],
  onReviewMessage,
  onReviewPlan,
  reviewTarget = null,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  reviewComments = [],
  transcriptTruncated = false,
  hiddenTurnCount = 0,
  busy = false,
  emptyState = null,
}: {
  messages: MessageRecord[]
  /** Resolves a permission/AskUserQuestion/plan card by requestId (05-interactive-prompts). */
  onRespond: (requestId: string, decision: PromptDecision) => void
  /** Opens a plan file on disk in the Files tab (plan card header). */
  onOpenPlanFile?: (planFilePath: string) => void
  workspaceRoot?: string
  projectRoot?: string
  filePathCandidates?: readonly string[]
  /** Opens a resolved absolute path in the Files tab (assistant markdown file links). */
  onOpenFileInFiles?: (absolutePath: string) => void
  bookmarks?: readonly SessionBookmark[]
  onToggleBookmark?: (bookmark: CreateSessionBookmarkInput, bookmarked: boolean) => void
  /** Non-empty while the "Find in conversation" bar is active and has typed text. */
  searchQuery?: string
  /** Which match (in document order) is the current navigation target; -1 means none highlighted as active. */
  activeMatchIndex?: number
  /** Fired after every render with the total number of matches found across the transcript. */
  onMatchCount?: (count: number) => void
  /** Live SDK status chrome (compacting / requesting / compact failed). */
  sdkChrome?: SessionSdkChromeEvent | null
  /** SDK background monitors / jobs / shell (merged task_* state). */
  backgroundTasks?: BackgroundTaskRow[]
  /** Opens the selected assistant response in the review split pane. */
  onReviewMessage?: (message: MessageRecord) => void
  /** Opens a proposed plan in the review split pane. */
  onReviewPlan?: (message: MessageRecord, planMarkdown: string, previousPlanMarkdown?: string) => void
  /** Active review pane target (highlights source row/card). */
  reviewTarget?: ReviewPaneTarget | null
  onAddComment?: (note: string) => void
  onUpdateComment?: (oldNote: string, newNote: string) => void
  onDeleteComment?: (composerNote: string) => void
  reviewComments?: readonly ReviewComposerComment[]
  transcriptTruncated?: boolean
  hiddenTurnCount?: number
  /** While a turn is in flight, render the tail assistant message as plain text (skip Markdown). */
  busy?: boolean
  /** Shown in place of the (blank) transcript when the session has no messages yet. */
  emptyState?: JSX.Element | null
}): JSX.Element {
  function findPreviousPlanMarkdown(currentMessageId: number): string | undefined {
    const idx = messages.findIndex((m) => m.id === currentMessageId)
    if (idx <= 0) return undefined
    for (let i = idx - 1; i >= 0; i--) {
      const parsed = parseStructuredContent(messages[i].content)
      if (parsed?.kind === 'plan_proposed') return parsed.plan
    }
    return undefined
  }

  const childrenByParent = new Map<string, TopRow[]>()
  const topRows: TopRow[] = []

  for (const m of messages) {
    const parsed = parseStructuredContent(m.content)
    if (parsed?.kind === 'todo_update') continue // rendered only in the tracker rail, not the transcript
    if (parsed?.kind === 'thinking_block') {
      topRows.push({ message: m, thinking: parsed })
      continue
    }
    if (parsed?.kind === 'tool_call' && parsed.parentToolUseId) {
      const list = childrenByParent.get(parsed.parentToolUseId) ?? []
      list.push({ message: m, tool: parsed })
      childrenByParent.set(parsed.parentToolUseId, list)
      continue
    }
    topRows.push({ message: m, tool: parsed?.kind === 'tool_call' ? parsed : undefined })
  }

  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null
  // Defer switching streaming plain-text → Markdown until after turn-end state settles.
  const busyDeferred = useDeferredValue(busy)
  const streamingTailId =
    busyDeferred &&
    lastMessage?.role === 'assistant' &&
    !parseStructuredContent(lastMessage.content)
      ? lastMessage.id
      : null

  /**
   * Renders one tool-call row's full markup — its `transcript-message`
   * wrapper + `MessageActions` + `ToolCallCard`, plus (if it spawned a
   * subagent) the nested `.subagent-wrap` right after it, whose own
   * children go through the same `ToolCallSequence` aggregation
   * (14-tool-call-sequence-collapse). This is exactly what every tool-call
   * message rendered as before this feature; now it's handed to
   * `ToolCallSequence` as a callback so grouping decides *when* (immediately,
   * or only once an aggregate row is expanded) to call it, not *what* it
   * renders.
   */
  function renderToolRow(message: MessageRecord, tool: ToolCallContent): JSX.Element {
    const children = childrenByParent.get(tool.toolUseId)
    return (
      <Fragment key={message.id}>
        <div className="msg-wrap" data-testid="transcript-message" data-role={message.role} data-message-id={message.id}>
          <MessageActions text={`${tool.name}: ${toolHeadline(tool.name, tool.input)}`} />
          <ToolCallCard
            content={tool}
            awaitingUserApproval={isToolAwaitingUserApproval(tool.toolUseId, messages)}
          />
        </div>
        {children && children.length > 0 && (
          <div
            className="subagent-wrap"
            data-testid="subagent-wrap"
            data-parent-tool-use-id={tool.toolUseId}
            key={`subagent-${message.id}`}
          >
            <div className="subagent-label">
              {tool.status === 'running' && <span className="spinner" />}
              <span>Task: {taskLabel(tool)}</span>
            </div>
            <ToolCallSequence
              entries={children.map((child) => ({
                key: String(child.message.id),
                tool: child.tool!,
                render: () => (
                  <div
                    data-testid="transcript-message"
                    data-role="assistant"
                    data-message-id={child.message.id}
                    key={child.message.id}
                  >
                    <ToolCallCard
                      content={child.tool!}
                      awaitingUserApproval={isToolAwaitingUserApproval(child.tool!.toolUseId, messages)}
                    />
                  </div>
                )
              }))}
            />
          </div>
        )}
      </Fragment>
    )
  }

  // Group consecutive top-level tool/thinking rows into sequences
  // (14-tool-call-sequence-collapse): a run of adjacent tool-call and
  // thinking-block rows (any non-activity row — user/assistant text/etc. —
  // breaks a run) is handed to `ToolCallSequence`, which decides whether
  // it renders as standalone card(s) or collapses finished steps into one
  // aggregate. Thinking blocks interleaved between tool calls stay in the
  // same run so past reasoning steps fold with the tools they surround.
  //
  // A permission/AskUserQuestion/plan-proposed card (05-interactive-prompts)
  // can land *between* two tool calls of what is otherwise one contiguous
  // sequence (e.g. Read, then an Edit call that needs approval, then Bash) —
  // it isn't itself a tool call, but it shouldn't fracture the sequence into
  // two separate aggregates either. Such cards are pulled out as "sidecars"
  // (kept in their original relative order) and rendered right after the
  // run's own ToolCallSequence, instead of breaking the run.
  type RenderUnit = TopRow | { activityRun: TopRow[]; sidecars: TopRow[] }
  const renderUnits: RenderUnit[] = []
  let currentRun: TopRow[] = []
  let currentSidecars: TopRow[] = []
  const isActivityRow = (row: TopRow): boolean => Boolean(row.tool || row.thinking)
  const isSidecarRow = (row: TopRow): boolean => {
    const kind = parseStructuredContent(row.message.content)?.kind
    return kind === 'permission_request' || kind === 'ask_user_question' || kind === 'plan_proposed'
  }
  for (const row of topRows) {
    if (isActivityRow(row)) {
      currentRun.push(row)
      continue
    }
    if (currentRun.length > 0 && isSidecarRow(row)) {
      currentSidecars.push(row)
      continue
    }
    if (currentRun.length > 0) {
      renderUnits.push({ activityRun: currentRun, sidecars: currentSidecars })
      currentRun = []
      currentSidecars = []
    }
    renderUnits.push(row)
  }
  if (currentRun.length > 0) renderUnits.push({ activityRun: currentRun, sidecars: currentSidecars })

  // Permission/plan/question cards can arrive *after* the tool/thinking rows they
  // gate (canUseTool runs after the tool_use announcement is already persisted).
  // A non-sidecar row in between — commonly a streamed assistant-text chunk —
  // flushes the activity run first, leaving the resolved cards as orphan top-level
  // rows that render as full cards below the collapsed summary. Reattach those
  // orphan sidecars to the nearest adjacent activity run so they fold into the
  // same summary line.
  function mergeOrphanSidecars(units: RenderUnit[]): RenderUnit[] {
    const out: RenderUnit[] = []
    let pendingSidecarRows: TopRow[] = []

    function attachPendingSidecarsToPreviousActivityRun(): void {
      if (pendingSidecarRows.length === 0) return
      for (let i = out.length - 1; i >= 0; i--) {
        const unit = out[i]!
        if ('activityRun' in unit) {
          unit.sidecars.push(...pendingSidecarRows)
          pendingSidecarRows = []
          return
        }
      }
      for (const row of pendingSidecarRows) out.push(row)
      pendingSidecarRows = []
    }

    for (const unit of units) {
      if (!('activityRun' in unit)) {
        if (isSidecarRow(unit)) {
          pendingSidecarRows.push(unit)
          continue
        }
        attachPendingSidecarsToPreviousActivityRun()
        out.push(unit)
        continue
      }

      unit.sidecars = [...pendingSidecarRows, ...unit.sidecars]
      pendingSidecarRows = []
      out.push(unit)
    }

    attachPendingSidecarsToPreviousActivityRun()
    return out
  }

  const mergedRenderUnits = mergeOrphanSidecars(renderUnits)

  let lastTimestamp: string | null = null
  let sawFirstUser = false
  const matchCounter = { current: 0 }
  const query = searchQuery ?? ''

  /**
   * Renders a permission/AskUserQuestion/plan-proposed card outside its
   * normal top-level row position — used for "sidecars" pulled out of a
   * tool-call run above (14-tool-call-sequence-collapse) so a mid-sequence
   * approval prompt doesn't fracture the run into two aggregates. Returns
   * null for any other message kind (defensive; callers only pass rows
   * `isSidecarRow` already accepted).
   */
  function renderSidecar(message: MessageRecord, embedded = false): JSX.Element | null {
    const parsed = parseStructuredContent(message.content)
    if (parsed?.kind === 'permission_request') {
      return (
        <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <PermissionRequestCard
            content={parsed}
            embedded={embedded}
            onRespond={(decision) => onRespond(parsed.requestId, decision)}
          />
        </div>
      )
    }
    if (parsed?.kind === 'ask_user_question') {
      return (
        <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <AskUserQuestionCard
            content={parsed}
            embedded={embedded}
            onRespond={(decision) => onRespond(parsed.requestId, decision)}
          />
        </div>
      )
    }
    if (parsed?.kind === 'plan_proposed') {
      return (
        <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <PlanProposedCard
            content={parsed}
            embedded={embedded}
            onRespond={(decision) => onRespond(parsed.requestId, decision)}
            onOpenPlanFile={onOpenPlanFile}
            onReviewPlan={
              onReviewPlan
                ? () => onReviewPlan(message, parsed.plan, findPreviousPlanMarkdown(message.id))
                : undefined
            }
            reviewActive={
              reviewTarget?.kind === 'plan' && reviewTarget.sourceId === message.id
            }
            messageId={message.id}
            onAddComment={onAddComment}
            onUpdateComment={onUpdateComment}
            onDeleteComment={onDeleteComment}
            reviewComments={reviewComments}
            workspaceRoot={workspaceRoot}
            projectRoot={projectRoot}
            filePathCandidates={filePathCandidates}
            bookmarks={bookmarks}
            onToggleBookmark={onToggleBookmark}
          />
        </div>
      )
    }
    return null
  }

  function isPromptSidecarContent(
    parsed: ReturnType<typeof parseStructuredContent>
  ): parsed is Extract<
    NonNullable<ReturnType<typeof parseStructuredContent>>,
    { kind: 'permission_request' | 'ask_user_question' | 'plan_proposed' }
  > {
    return (
      parsed?.kind === 'permission_request' ||
      parsed?.kind === 'ask_user_question' ||
      parsed?.kind === 'plan_proposed'
    )
  }

  function sidecarSequenceEntry(row: TopRow): SidecarSequenceEntry | null {
    const parsed = parseStructuredContent(row.message.content)
    if (!isPromptSidecarContent(parsed)) return null
    const foldSummary = promptFoldSummary(parsed)
    if (!foldSummary) return null
    return {
      key: String(row.message.id),
      foldSummary,
      render: () => renderSidecar(row.message, true)!
    }
  }

  /** Resolved interactive prompt as a lone collapsed summary row (no adjacent activity run). */
  function renderFoldedPromptRow(message: MessageRecord): JSX.Element | null {
    const entry = sidecarSequenceEntry({ message })
    if (!entry) return null
    return <ToolCallSequence key={message.id} entries={[]} sidecars={[entry]} />
  }

  function renderActivityEntry(row: TopRow): ToolCallSequenceEntry {
    if (row.thinking) {
      return {
        key: String(row.message.id),
        thinking: row.thinking,
        render: () => (
          <div
            className="msg-wrap"
            data-testid="transcript-message"
            data-role={row.message.role}
            data-message-id={row.message.id}
            key={row.message.id}
          >
            <ThinkingBlockInline content={row.thinking!} />
          </div>
        )
      }
    }
    return {
      key: String(row.message.id),
      tool: row.tool!,
      render: () => renderToolRow(row.message, row.tool!)
    }
  }

  const rows = mergedRenderUnits.map((unit) => {
    if ('activityRun' in unit) {
      const run = unit.activityRun
      lastTimestamp = run[run.length - 1].message.createdAt
      const mergedSidecars = unit.sidecars
        .map((row) => sidecarSequenceEntry(row))
        .filter((entry): entry is SidecarSequenceEntry => entry !== null)
      const pendingSidecars = unit.sidecars.filter((row) => {
        const parsed = parseStructuredContent(row.message.content)
        return isPromptSidecarContent(parsed) && parsed.status === 'pending'
      })
      return (
        <Fragment key={`seq-${run[0].message.id}`}>
          {pendingSidecars.map((row) => renderSidecar(row.message))}
          <ToolCallSequence entries={run.map(renderActivityEntry)} sidecars={mergedSidecars} />
        </Fragment>
      )
    }

    const { message, thinking } = unit
    const parsed = parseStructuredContent(message.content)
    const nodes: JSX.Element[] = []

    if (message.role === 'user') {
      if (sawFirstUser && lastTimestamp) {
        const elapsedMs = new Date(message.createdAt).getTime() - new Date(lastTimestamp).getTime()
        nodes.push(
          <div className="turn-divider" data-testid="turn-divider" key={`divider-${message.id}`}>
            {formatElapsed(elapsedMs)}
          </div>
        )
      }
      sawFirstUser = true
      if (parsed?.kind === 'image_attachment') {
        nodes.push(
          <div className="msg-wrap msg-wrap-user" key={message.id}>
            <MessageActions text={parsed.text ?? ''} />
            <div className="msg-user" data-testid="transcript-message" data-role="user" data-message-id={message.id}>
              <div className="attach-row" data-testid="transcript-attach-row">
                <div className="attach-thumb" data-testid="transcript-attach-thumb">
                  <img src={`data:${parsed.mimeType};base64,${parsed.data}`} alt="Attached" />
                </div>
              </div>
              {parsed.text &&
                (query ? (
                  highlightMatches(parsed.text, query, matchCounter, activeMatchIndex)
                ) : (
                  <Linkify text={parsed.text} />
                ))}
            </div>
          </div>
        )
      } else {
        nodes.push(
          <div className="msg-wrap msg-wrap-user" key={message.id}>
            <MessageActions text={message.content} />
            <div className="msg-user" data-testid="transcript-message" data-role="user" data-message-id={message.id}>
              {query ? highlightMatches(message.content, query, matchCounter, activeMatchIndex) : <Linkify text={message.content} />}
            </div>
          </div>
        )
      }
    } else if (parsed?.kind === 'compaction') {
      nodes.push(
        <div className="compaction-banner" data-testid="compaction-banner" key={message.id}>
          — context compacted ({formatTokens(parsed.preTokens)}
          {parsed.postTokens != null ? ` → ${formatTokens(parsed.postTokens)}` : ''} tokens) —
        </div>
      )
    } else if (thinking) {
      // Standalone thinking between user/assistant messages — inline while
      // streaming, folded summary row once complete.
      if (thinking.status === 'running') {
        nodes.push(
          <div className="msg-wrap" key={message.id} data-testid="transcript-message" data-role={message.role} data-message-id={message.id}>
            <ThinkingBlockInline content={thinking} />
          </div>
        )
      } else {
        nodes.push(
          <div className="msg-wrap" key={message.id} data-testid="transcript-message" data-role={message.role} data-message-id={message.id}>
            <ThinkingBlockInline content={thinking} />
          </div>
        )
      }
    } else if (parsed?.kind === 'permission_request') {
      if (parsed.status === 'pending') {
        nodes.push(
          <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
            <PermissionRequestCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
          </div>
        )
      } else {
        const folded = renderFoldedPromptRow(message)
        if (folded) nodes.push(folded)
      }
    } else if (parsed?.kind === 'ask_user_question') {
      if (parsed.status === 'pending') {
        nodes.push(
          <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
            <AskUserQuestionCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
          </div>
        )
      } else {
        const folded = renderFoldedPromptRow(message)
        if (folded) nodes.push(folded)
      }
    } else if (parsed?.kind === 'plan_proposed') {
      if (parsed.status === 'pending') {
        nodes.push(
          <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
            <PlanProposedCard
              content={parsed}
              onRespond={(decision) => onRespond(parsed.requestId, decision)}
              onOpenPlanFile={onOpenPlanFile}
              onReviewPlan={
                onReviewPlan
                  ? () => onReviewPlan(message, parsed.plan, findPreviousPlanMarkdown(message.id))
                  : undefined
              }
              reviewActive={
                reviewTarget?.kind === 'plan' && reviewTarget.sourceId === message.id
              }
              messageId={message.id}
              onAddComment={onAddComment}
              onUpdateComment={onUpdateComment}
              onDeleteComment={onDeleteComment}
              reviewComments={reviewComments}
              workspaceRoot={workspaceRoot}
              projectRoot={projectRoot}
              filePathCandidates={filePathCandidates}
              bookmarks={bookmarks}
              onToggleBookmark={onToggleBookmark}
            />
          </div>
        )
      } else {
        const folded = renderFoldedPromptRow(message)
        if (folded) nodes.push(folded)
      }
    } else if (parsed?.kind === 'transcript_notice') {
      const notice = parsed as TranscriptNoticeContent
      nodes.push(
        <div
          className={`transcript-notice ${notice.level}`}
          data-testid="transcript-notice"
          data-notice-level={notice.level}
          key={message.id}
        >
          <span className="transcript-notice-label">{notice.label}</span>
          <span>{notice.text}</span>
        </div>
      )
    } else if (parsed?.kind === 'local_command_output') {
      const cmd = parsed as LocalCommandOutputContent
      nodes.push(
        <div className="msg-wrap" key={message.id} data-testid="transcript-message" data-role={message.role} data-message-id={message.id}>
          <pre className="local-cmd-output" data-testid="local-cmd-output">
            {cmd.text}
          </pre>
        </div>
      )
    } else if (message.role === 'system') {
      nodes.push(
        <div className="msg-system" data-testid="transcript-message" data-role="system" data-message-id={message.id} key={message.id}>
          {message.content}
        </div>
      )
    } else {
      nodes.push(
        <div
          className={`msg-wrap${
            reviewTarget?.kind === 'response' && reviewTarget.sourceId === message.id
              ? ' response-review-selected'
              : ''
          }`}
          key={message.id}
        >
          <MessageActions
            text={message.content}
            speakable
            onReview={onReviewMessage ? () => onReviewMessage(message) : undefined}
            reviewActive={
              reviewTarget?.kind === 'response' && reviewTarget.sourceId === message.id
            }
          />
          <div className="msg-assistant" data-testid="transcript-message" data-role={message.role} data-message-id={message.id}>
            {query ? (
              highlightMatches(message.content, query, matchCounter, activeMatchIndex)
            ) : message.id === streamingTailId || message.content.length > LARGE_ASSISTANT_TEXT_CHARS ? (
              message.content
            ) : onAddComment ? (
              <TranscriptInlineComments
                messageId={message.id}
                sourceContent={message.content}
                commentPrefix="Re response"
                onAddComment={onAddComment}
                onUpdateComment={onUpdateComment}
                onDeleteComment={onDeleteComment}
                reviewComments={reviewComments}
              >
                <MarkdownMessage
                  content={message.content}
                  workspaceRoot={workspaceRoot}
                  projectRoot={projectRoot}
                  filePathCandidates={filePathCandidates}
                  onOpenFileInFiles={onOpenFileInFiles}
                  bookmarks={bookmarks}
                  onToggleBookmark={onToggleBookmark}
                />
              </TranscriptInlineComments>
            ) : (
              <MarkdownMessage
                content={message.content}
                workspaceRoot={workspaceRoot}
                projectRoot={projectRoot}
                filePathCandidates={filePathCandidates}
                onOpenFileInFiles={onOpenFileInFiles}
                bookmarks={bookmarks}
                onToggleBookmark={onToggleBookmark}
              />
            )}
          </div>
        </div>
      )
    }

    lastTimestamp = message.createdAt
    return <Fragment key={`row-${message.id}`}>{nodes}</Fragment>
  })

  const totalMatches = matchCounter.current
  const onMatchCountRef = useRef(onMatchCount)
  onMatchCountRef.current = onMatchCount
  useEffect(() => {
    onMatchCountRef.current?.(totalMatches)
  }, [totalMatches, query])

  // Real DOM `scrollIntoView` against the actual rendered `<mark>` for the
  // current navigation target (10b-enrichment-full-text-search) — not a
  // mocked/simulated scroll.
  useEffect(() => {
    if (!query || activeMatchIndex < 0) return
    const el = document.querySelector<HTMLElement>(`.transcript mark.search-hit[data-match-index="${activeMatchIndex}"]`)
    el?.scrollIntoView({ block: 'center' })
  }, [query, activeMatchIndex, totalMatches])

  // Auto-scroll-to-bottom (standard chat-UI pattern): the transcript follows
  // new content — including streamed deltas patched into the last message's
  // content, which change `messages`' identity via useSessions' immutable
  // setState — as long as the user was already at (or very near) the
  // bottom. If they've scrolled up to read history, we never yank the view
  // out from under them; `isNearBottomRef` is kept current by the scroll
  // listener below on every real scroll event (including the programmatic
  // ones this effect itself performs), so it always reflects the position
  // as of just before the latest render.
  //
  // 15-conversation-scrollbar-outer-edge: `.transcript` itself no longer
  // scrolls — `.chat-body-row` (rendered by App.tsx, an ancestor of this
  // component, not a descendant) is the single scrolling container now, so
  // its native scrollbar sits at the outer-right edge past the Tracker
  // Rail. `.chat-body-row` isn't reachable via a prop/ref passed down from
  // App.tsx without threading a ref through `App.tsx` -> `ChatTranscript`,
  // so instead we keep `containerRef` on `.transcript` (still a valid,
  // stable DOM node) and resolve the actual scroll container via
  // `closest('.chat-body-row')` at the moment we need it. This keeps the
  // scroll logic self-contained in this component and robust to any further
  // DOM nesting changes between `.transcript` and `.chat-body-row`.
  const containerRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const NEAR_BOTTOM_THRESHOLD_PX = 48

  function getScrollContainer(): HTMLElement | null {
    const transcript = containerRef.current
    if (!transcript) return null
    // When the review split is open, `.chat-body-row` stops scrolling so the
    // right pane stays pinned; transcript scroll moves to `.chat-main-col`.
    if (reviewTarget) {
      return transcript.closest<HTMLElement>('.chat-main-col') ?? transcript.closest<HTMLElement>('.chat-body-row')
    }
    return transcript.closest<HTMLElement>('.chat-body-row')
  }

  function scrollToBottomIfPinned(): void {
    const el = getScrollContainer()
    if (!el || !isNearBottomRef.current) return
    el.scrollTop = el.scrollHeight
  }

  useLayoutEffect(() => {
    scrollToBottomIfPinned()
  }, [messages, reviewTarget])

  // When the composer grows after submit (turn-status row, queued strip,
  // changes card), `.chat-body-row` shrinks but scrollTop is unchanged —
  // the last user message ends up clipped behind the taller composer.
  useEffect(() => {
    const transcript = containerRef.current
    if (!transcript) return
    const composer =
      transcript.closest('.chat-tab-wrap')?.querySelector('.composer-cache') ??
      transcript.closest('[data-main-content]')?.querySelector('.composer-cache')
    if (!composer) return
    const observer = new ResizeObserver(() => {
      scrollToBottomIfPinned()
    })
    observer.observe(composer)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewTarget])

  function handleScroll(): void {
    const el = getScrollContainer()
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop
    isNearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_THRESHOLD_PX
  }

  // `.transcript` no longer scrolls, so a React `onScroll` prop on it would
  // never fire — the scroll events happen on `.chat-body-row` instead.
  // Attach a real listener to that ancestor directly.
  useEffect(() => {
    const el = getScrollContainer()
    if (!el) return
    el.addEventListener('scroll', handleScroll)
    return () => el.removeEventListener('scroll', handleScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewTarget])

  return (
    <div className="transcript" data-testid="transcript" ref={containerRef}>
      {transcriptTruncated && hiddenTurnCount > 0 ? (
        <div
          className="compaction-banner"
          data-testid="transcript-history-truncated"
          style={{ margin: '12px auto' }}
        >
          Showing last {CHAT_TRANSCRIPT_MAX_TURNS} conversations — {hiddenTurnCount} earlier hidden
        </div>
      ) : null}
      {emptyState && messages.length === 0 ? emptyState : rows}
      <BackgroundTasksConversationCard tasks={backgroundTasks} />
      {sdkChrome && (sdkChrome.status === 'compacting' || sdkChrome.compactFailed) && (
        <ConversationStatusCard chrome={sdkChrome} />
      )}
    </div>
  )
}
