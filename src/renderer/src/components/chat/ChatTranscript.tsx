import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import type { MessageRecord } from '../../../../shared/session-types'
import type { PromptDecision } from '../../../../shared/session-types'
import { parseStructuredContent, type ToolCallContent } from '../../../../shared/chat-content'
import ToolCallCard, { toolHeadline } from './ToolCallCard'
import ToolCallSequence from './ToolCallSequence'
import AskUserQuestionCard from './AskUserQuestionCard'
import PermissionRequestCard from './PermissionRequestCard'
import PlanProposedCard from './PlanProposedCard'
import MarkdownMessage from './MarkdownMessage'
import MessageActions from './MessageActions'

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
 * When a search query IS active, this intentionally keeps showing the plain
 * `highlightMatches(...)` text instead of Markdown — merging search
 * highlighting into rendered Markdown nodes is out of scope, an accepted
 * limitation, not a bug. Scope is otherwise unchanged: user messages
 * (`.msg-user`) and every structured-content card (`ToolCallCard`,
 * `PlanProposedCard`, `AskUserQuestionCard`, `PermissionRequestCard`, todo
 * updates, image attachments) are never Markdown-rendered.
 */
export default function ChatTranscript({
  messages,
  onRespond,
  onOpenPlanFile,
  workspaceRoot,
  projectRoot,
  onOpenFileInFiles,
  searchQuery,
  activeMatchIndex = -1,
  onMatchCount
}: {
  messages: MessageRecord[]
  /** Resolves a permission/AskUserQuestion/plan card by requestId (05-interactive-prompts). */
  onRespond: (requestId: string, decision: PromptDecision) => void
  /** Opens a plan file on disk in the Files tab (plan card header). */
  onOpenPlanFile?: (planFilePath: string) => void
  workspaceRoot?: string
  projectRoot?: string
  /** Opens a resolved absolute path in the Files tab (assistant markdown file links). */
  onOpenFileInFiles?: (absolutePath: string) => void
  /** Non-empty while the "Find in conversation" bar is active and has typed text. */
  searchQuery?: string
  /** Which match (in document order) is the current navigation target; -1 means none highlighted as active. */
  activeMatchIndex?: number
  /** Fired after every render with the total number of matches found across the transcript. */
  onMatchCount?: (count: number) => void
}): JSX.Element {
  const childrenByParent = new Map<string, TopRow[]>()
  const topRows: TopRow[] = []

  for (const m of messages) {
    const parsed = parseStructuredContent(m.content)
    if (parsed?.kind === 'todo_update') continue // rendered only in the tracker rail, not the transcript
    if (parsed?.kind === 'tool_call' && parsed.parentToolUseId) {
      const list = childrenByParent.get(parsed.parentToolUseId) ?? []
      list.push({ message: m, tool: parsed })
      childrenByParent.set(parsed.parentToolUseId, list)
      continue
    }
    topRows.push({ message: m, tool: parsed?.kind === 'tool_call' ? parsed : undefined })
  }

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
          <ToolCallCard content={tool} />
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
                    <ToolCallCard content={child.tool!} />
                  </div>
                )
              }))}
            />
          </div>
        )}
      </Fragment>
    )
  }

  // Group consecutive top-level tool-call rows into sequences
  // (14-tool-call-sequence-collapse): a run of adjacent tool-call rows (any
  // non-tool row — user/assistant text/etc. — breaks a run) is handed to
  // `ToolCallSequence`, which decides whether it renders as standalone
  // card(s) or collapses finished calls into one aggregate.
  //
  // A permission/AskUserQuestion/plan-proposed card (05-interactive-prompts)
  // can land *between* two tool calls of what is otherwise one contiguous
  // sequence (e.g. Read, then an Edit call that needs approval, then Bash) —
  // it isn't itself a tool call, but it shouldn't fracture the sequence into
  // two separate aggregates either. Such cards are pulled out as "sidecars"
  // (kept in their original relative order) and rendered right after the
  // run's own ToolCallSequence, instead of breaking the run.
  type RenderUnit = TopRow | { toolRun: TopRow[]; sidecars: TopRow[] }
  const renderUnits: RenderUnit[] = []
  let currentRun: TopRow[] = []
  let currentSidecars: TopRow[] = []
  const isSidecarRow = (row: TopRow): boolean => {
    const kind = parseStructuredContent(row.message.content)?.kind
    return kind === 'permission_request' || kind === 'ask_user_question' || kind === 'plan_proposed'
  }
  for (const row of topRows) {
    if (row.tool) {
      currentRun.push(row)
      continue
    }
    if (currentRun.length > 0 && isSidecarRow(row)) {
      currentSidecars.push(row)
      continue
    }
    if (currentRun.length > 0) {
      renderUnits.push({ toolRun: currentRun, sidecars: currentSidecars })
      currentRun = []
      currentSidecars = []
    }
    renderUnits.push(row)
  }
  if (currentRun.length > 0) renderUnits.push({ toolRun: currentRun, sidecars: currentSidecars })

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
  function renderSidecar(message: MessageRecord): JSX.Element | null {
    const parsed = parseStructuredContent(message.content)
    if (parsed?.kind === 'permission_request') {
      return (
        <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <PermissionRequestCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
        </div>
      )
    }
    if (parsed?.kind === 'ask_user_question') {
      return (
        <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <AskUserQuestionCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
        </div>
      )
    }
    if (parsed?.kind === 'plan_proposed') {
      return (
        <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <PlanProposedCard
            content={parsed}
            onRespond={(decision) => onRespond(parsed.requestId, decision)}
            onOpenPlanFile={onOpenPlanFile}
            workspaceRoot={workspaceRoot}
            projectRoot={projectRoot}
          />
        </div>
      )
    }
    return null
  }

  const rows = renderUnits.map((unit) => {
    if ('toolRun' in unit) {
      const run = unit.toolRun
      lastTimestamp = run[run.length - 1].message.createdAt
      return (
        <Fragment key={`seq-${run[0].message.id}`}>
          <ToolCallSequence
            entries={run.map((row) => ({
              key: String(row.message.id),
              tool: row.tool!,
              render: () => renderToolRow(row.message, row.tool!)
            }))}
          />
          {unit.sidecars.map((row) => renderSidecar(row.message))}
        </Fragment>
      )
    }

    const { message } = unit
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
              {parsed.text && <div>{query ? highlightMatches(parsed.text, query, matchCounter, activeMatchIndex) : parsed.text}</div>}
            </div>
          </div>
        )
      } else {
        nodes.push(
          <div className="msg-wrap msg-wrap-user" key={message.id}>
            <MessageActions text={message.content} />
            <div className="msg-user" data-testid="transcript-message" data-role="user" data-message-id={message.id}>
              {query ? highlightMatches(message.content, query, matchCounter, activeMatchIndex) : message.content}
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
    } else if (parsed?.kind === 'permission_request') {
      nodes.push(
        <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <PermissionRequestCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
        </div>
      )
    } else if (parsed?.kind === 'ask_user_question') {
      nodes.push(
        <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <AskUserQuestionCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
        </div>
      )
    } else if (parsed?.kind === 'plan_proposed') {
      nodes.push(
        <div data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <PlanProposedCard
            content={parsed}
            onRespond={(decision) => onRespond(parsed.requestId, decision)}
            onOpenPlanFile={onOpenPlanFile}
            workspaceRoot={workspaceRoot}
            projectRoot={projectRoot}
          />
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
        <div className="msg-wrap" key={message.id}>
          <MessageActions text={message.content} speakable />
          <div className="msg-assistant" data-testid="transcript-message" data-role={message.role} data-message-id={message.id}>
            {query ? (
              highlightMatches(message.content, query, matchCounter, activeMatchIndex)
            ) : (
              <MarkdownMessage
                content={message.content}
                workspaceRoot={workspaceRoot}
                projectRoot={projectRoot}
                onOpenFileInFiles={onOpenFileInFiles}
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
    return containerRef.current?.closest<HTMLElement>('.chat-body-row') ?? null
  }

  useLayoutEffect(() => {
    const el = getScrollContainer()
    if (!el) return
    if (isNearBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

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
  }, [])

  return (
    <div className="transcript" data-testid="transcript" ref={containerRef}>
      {rows}
    </div>
  )
}
