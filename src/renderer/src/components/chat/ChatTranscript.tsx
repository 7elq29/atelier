import { Fragment } from 'react'
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
 */
export default function ChatTranscript({
  messages,
  onRespond
}: {
  messages: MessageRecord[]
  /** Resolves a permission/AskUserQuestion/plan card by requestId (05-interactive-prompts). */
  onRespond: (requestId: string, decision: PromptDecision) => void
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

  return (
    <div className="transcript" data-testid="transcript">
      {topRows.map(({ message, tool }) => {
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
          nodes.push(
            <div className="msg-wrap msg-wrap-user" key={message.id}>
              <MessageActions text={message.content} />
              <div className="msg-user" data-testid="transcript-message" data-role="user">
                {message.content}
              </div>
            </div>
          )
        } else if (parsed?.kind === 'compaction') {
          nodes.push(
            <div className="compaction-banner" data-testid="compaction-banner" key={message.id}>
              — context compacted ({formatTokens(parsed.preTokens)}
              {parsed.postTokens != null ? ` → ${formatTokens(parsed.postTokens)}` : ''} tokens) —
            </div>
          )
        } else if (parsed?.kind === 'permission_request') {
          nodes.push(
            <div data-testid="transcript-message" data-role={message.role} key={message.id}>
              <PermissionRequestCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
            </div>
          )
        } else if (parsed?.kind === 'ask_user_question') {
          nodes.push(
            <div data-testid="transcript-message" data-role={message.role} key={message.id}>
              <AskUserQuestionCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
            </div>
          )
        } else if (parsed?.kind === 'plan_proposed') {
          nodes.push(
            <div data-testid="transcript-message" data-role={message.role} key={message.id}>
              <PlanProposedCard content={parsed} onRespond={(decision) => onRespond(parsed.requestId, decision)} />
            </div>
          )
        } else if (tool) {
          const children = childrenByParent.get(tool.toolUseId)
          nodes.push(
            <div className="msg-wrap" data-testid="transcript-message" data-role={message.role} key={message.id}>
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
                  <div data-testid="transcript-message" data-role="assistant" key={child.message.id}>
                    <ToolCallCard content={child.tool!} />
                  </div>
                ))}
              </div>
            )
          }
        } else if (message.role === 'system') {
          nodes.push(
            <div className="msg-system" data-testid="transcript-message" data-role="system" key={message.id}>
              {message.content}
            </div>
          )
        } else {
          nodes.push(
            <div className="msg-wrap" key={message.id}>
              <MessageActions text={message.content} speakable />
              <div className="msg-assistant" data-testid="transcript-message" data-role={message.role}>
                <Linkify text={message.content} />
              </div>
            </div>
          )
        }

        lastTimestamp = message.createdAt
        return <Fragment key={`row-${message.id}`}>{nodes}</Fragment>
      })}
    </div>
  )
}
