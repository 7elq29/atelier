/**
 * Transcript export formatting (10c-enrichment-export-conversation): turns a
 * session's stored message list into either a human-readable Markdown
 * transcript or a clean, re-parseable JSON document.
 *
 * Kept dependency-free of Electron/Node so it stays easy to unit-reason about
 * (and re-use from a test) — only `shared/chat-content.ts` +
 * `shared/session-types.ts` are imported, same restriction the IPC handler
 * that calls this module is under.
 */
import { parseStructuredContent, type StructuredContent } from '../../shared/chat-content'
import type { MessageRecord, SessionRecord } from '../../shared/session-types'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * One-line tool headline — same rules as the renderer's
 * `ToolCallCard.tsx#toolHeadline` (command for Bash, file path for
 * Read/Edit/Write, etc). Duplicated rather than imported since that file is a
 * renderer/React component this main-process module must not depend on.
 */
function toolHeadline(name: string, input: unknown): string {
  const obj = asRecord(input)
  switch (name) {
    case 'Bash':
      return typeof obj.command === 'string' ? obj.command : name
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'MultiEdit':
      return typeof obj.file_path === 'string' ? obj.file_path : name
    case 'Grep':
      return typeof obj.pattern === 'string' ? `grep ${obj.pattern}` : name
    case 'Glob':
      return typeof obj.pattern === 'string' ? String(obj.pattern) : name
    case 'Task':
    case 'Agent':
      return typeof obj.description === 'string'
        ? obj.description
        : typeof obj.subagent_type === 'string'
          ? String(obj.subagent_type)
          : 'Task'
    case 'WebFetch':
      return typeof obj.url === 'string' ? obj.url : name
    case 'WebSearch':
      return typeof obj.query === 'string' ? obj.query : name
    default:
      return name
  }
}

function roleLabel(role: MessageRecord['role']): string {
  if (role === 'user') return 'User'
  if (role === 'assistant') return 'Assistant'
  return 'System'
}

/** Renders one structured-content row as a single Markdown block. */
function formatStructuredMarkdown(structured: StructuredContent): string {
  switch (structured.kind) {
    case 'tool_call': {
      const headline = toolHeadline(structured.name, structured.input)
      const statusLabel =
        structured.status === 'error'
          ? 'error'
          : structured.status === 'running'
            ? 'running'
            : structured.status === 'interrupted'
              ? 'interrupted'
              : 'completed'
      return `- \u{1F527} **${structured.name}** — \`${headline}\` (${statusLabel})`
    }
    case 'todo_update': {
      const lines = structured.todos.map(
        (t) => `  - [${t.status === 'completed' ? 'x' : ' '}] ${t.content}`
      )
      return `**Todo list update:**\n${lines.join('\n')}`
    }
    case 'compaction':
      return `> Conversation compacted (${structured.trigger} trigger): ${structured.preTokens} → ${
        structured.postTokens ?? '?'
      } tokens`
    case 'permission_request':
      return `> Permission request for **${structured.toolName}** — ${structured.status}`
    case 'ask_user_question': {
      const answered =
        structured.answers && Object.keys(structured.answers).length > 0
          ? `: ${Object.values(structured.answers).join(', ')}`
          : structured.freeText
            ? `: ${structured.freeText}`
            : ''
      return `> Question asked — ${structured.status}${answered}`
    }
    case 'plan_proposed':
      return `> Plan proposed — ${structured.status}`
    default:
      return ''
  }
}

function formatMessageMarkdown(message: MessageRecord): string {
  const structured = parseStructuredContent(message.content)
  if (!structured) {
    if (!message.content.trim()) return ''
    return `### ${roleLabel(message.role)}\n\n${message.content}\n`
  }
  return `${formatStructuredMarkdown(structured)}\n`
}

/** Full human-readable Markdown transcript for a session. */
export function formatTranscriptMarkdown(session: SessionRecord, messages: MessageRecord[]): string {
  const header = [
    `# ${session.name}`,
    '',
    `_Project: ${session.projectPath}_`,
    `_Created: ${session.createdAt}${session.closedAt ? ` · Closed: ${session.closedAt}` : ''}_`,
    ''
  ].join('\n')

  const body = messages
    .map(formatMessageMarkdown)
    .filter((block) => block.length > 0)
    .join('\n')

  return `${header}\n${body}\n`
}

/** One entry in the exported JSON message list. */
export interface ExportedMessage {
  id: number
  role: MessageRecord['role']
  createdAt: string
  /** Plain string for ordinary text; the parsed structured object (tool call, todo snapshot, etc) otherwise. */
  content: string | StructuredContent
}

export interface ExportedTranscript {
  session: {
    id: string
    name: string
    projectPath: string
    mode: SessionRecord['mode']
    hostname: string | null
    createdAt: string
    closedAt: string | null
  }
  messages: ExportedMessage[]
}

/** Full structured JSON document for a session — clean shape, not a raw DB-row dump. */
export function formatTranscriptJson(session: SessionRecord, messages: MessageRecord[]): ExportedTranscript {
  return {
    session: {
      id: session.id,
      name: session.name,
      projectPath: session.projectPath,
      mode: session.mode,
      hostname: session.hostname,
      createdAt: session.createdAt,
      closedAt: session.closedAt
    },
    messages: messages.map((m) => {
      const structured = parseStructuredContent(m.content)
      return {
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        content: structured ?? m.content
      }
    })
  }
}
