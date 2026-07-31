import { Fragment, useEffect, useRef } from 'react'
import type { MessageRecord } from '../../../../shared/session-types'
import type { PromptDecision } from '../../../../shared/session-types'
import { parseStructuredContent, type ToolCallContent } from '../../../../shared/chat-content'
import ToolCallCard, { toolHeadline } from './ToolCallCard'
import AskUserQuestionCard from './AskUserQuestionCard'
import PermissionRequestCard from './PermissionRequestCard'
import PlanProposedCard from './PlanProposedCard'
import Linkify from '../panels/Linkify'
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
 * Linkify/plain text, and the total match count is reported back via
 * `onMatchCount` after each render so the topbar's "N matches" chip and the
 * up/down navigation clamp stay in sync with what's actually on screen.
 */
export default function ChatTranscript({
  messages,
  onRespond,
  searchQuery,
  activeMatchIndex = -1,
  onMatchCount
}: {
  messages: MessageRecord[]
  /** Resolves a permission/AskUserQuestion/plan card by requestId (05-interactive-prompts). */
  onRespond: (requestId: string, decision: PromptDecision) => void
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

  let lastTimestamp: string | null = null
  let sawFirstUser = false
  const matchCounter = { current: 0 }
  const query = searchQuery ?? ''

  const rows = topRows.map(({ message, tool }) => {
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
          <PlanProposedCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
        </div>
      )
    } else if (tool) {
      const children = childrenByParent.get(tool.toolUseId)
      nodes.push(
        <div className="msg-wrap" data-testid="transcript-message" data-role={message.role} data-message-id={message.id} key={message.id}>
          <MessageActions text={`${tool.name}: ${toolHeadline(tool.name, tool.input)}`} />
          <ToolCallCard content={tool} />
        </div>
      )
      if (children && children.length > 0) {
        nodes.push(
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
            {children.map((child) => (
              <div data-testid="transcript-message" data-role="assistant" data-message-id={child.message.id} key={child.message.id}>
                <ToolCallCard content={child.tool!} />
              </div>
            ))}
          </div>
        )
      }
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
            {query ? highlightMatches(message.content, query, matchCounter, activeMatchIndex) : <Linkify text={message.content} />}
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

  return (
    <div className="transcript" data-testid="transcript">
      {rows}
    </div>
  )
}
