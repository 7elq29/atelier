/**
 * Structured message content (03-chat-surface-core). `MessageRecord.content`
 * is a plain string for ordinary user/assistant text; for tool calls, todo
 * snapshots, and compaction banners it is instead a JSON-encoded object
 * tagged with a `kind` discriminant, defined here so both the main process
 * (which produces it in SessionManager) and the renderer (which parses it in
 * the transcript/tracker-rail components) share one definition.
 */

export type ToolCallStatus = 'running' | 'completed' | 'error'

export interface ToolCallContent {
  kind: 'tool_call'
  toolUseId: string
  name: string
  input: unknown
  status: ToolCallStatus
  output?: unknown
  /** Id of the enclosing Task tool_use when this call was made by a spawned subagent; null for top-level calls. */
  parentToolUseId: string | null
}

export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | string
  activeForm?: string
}

export interface TodoUpdateContent {
  kind: 'todo_update'
  todos: TodoItem[]
}

export interface CompactionContent {
  kind: 'compaction'
  trigger: 'manual' | 'auto'
  preTokens: number
  postTokens?: number
}

export type StructuredContent = ToolCallContent | TodoUpdateContent | CompactionContent

/** Best-effort parse: returns null for plain-text message content (the common case). */
export function parseStructuredContent(content: string): StructuredContent | null {
  if (!content || content[0] !== '{') return null
  try {
    const obj: unknown = JSON.parse(content)
    if (
      obj &&
      typeof obj === 'object' &&
      'kind' in obj &&
      ((obj as { kind: unknown }).kind === 'tool_call' ||
        (obj as { kind: unknown }).kind === 'todo_update' ||
        (obj as { kind: unknown }).kind === 'compaction')
    ) {
      return obj as StructuredContent
    }
  } catch {
    return null
  }
  return null
}
