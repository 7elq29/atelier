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

/**
 * Interactive-prompt content kinds (05-interactive-prompts). Each starts
 * life persisted with `status: 'pending'` (see SessionManager.applyEvent's
 * `permission_request`/`ask_user_question`/`plan_proposed` cases) and is
 * updated in place — same "one row, mutated on resolution" pattern as
 * `ToolCallContent` — once the user responds (SessionManager.respondToPrompt).
 */

export interface AskQuestionOption {
  label: string
  description: string
}

export interface AskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: AskQuestionOption[]
}

export type PermissionRequestStatus = 'pending' | 'allowed' | 'denied'

export interface PermissionRequestContent {
  kind: 'permission_request'
  requestId: string
  toolUseId: string
  toolName: string
  input: unknown
  title?: string
  description?: string
  suggestedPattern?: string
  status: PermissionRequestStatus
  /** Set once resolved, if the "always allow" checkbox was checked at resolution time. */
  alwaysAllowed?: boolean
}

export type AskUserQuestionStatus = 'pending' | 'answered'

export interface AskUserQuestionContent {
  kind: 'ask_user_question'
  requestId: string
  toolUseId: string
  questions: AskQuestion[]
  status: AskUserQuestionStatus
  /** question text -> selected label(s) (comma-joined for multiSelect), once answered. */
  answers?: Record<string, string>
  /** Free-text reply typed into the "Other" box instead of picking an option, once answered. */
  freeText?: string
}

export type PlanStatus = 'pending' | 'accepted' | 'rejected' | 'keep_planning'

export interface PlanProposedContent {
  kind: 'plan_proposed'
  requestId: string
  toolUseId: string
  plan: string
  planFilePath?: string
  status: PlanStatus
}

/**
 * A user message that included a dropped/pasted image
 * (10g-enrichment-image-attachment). Persisted as this message's whole
 * `content` (JSON-encoded, same as every other StructuredContent kind) in
 * place of the plain-text string an ordinary user message would have —
 * `text` carries whatever was typed alongside the image, if anything.
 * `data`/`mimeType` are the exact same base64 bytes sent to the SDK as the
 * message's image content block (see ClaudeAgentSdkHarness's `userMessage`),
 * reused here purely for the transcript's thumbnail — small enough (a single
 * dropped/pasted image) that storing it twice (SQLite content column +
 * whatever the harness/SDK does with its own copy) is not a concern.
 */
export interface ImageAttachmentContent {
  kind: 'image_attachment'
  mimeType: string
  data: string
  text?: string
}

export type StructuredContent =
  | ToolCallContent
  | TodoUpdateContent
  | CompactionContent
  | PermissionRequestContent
  | AskUserQuestionContent
  | PlanProposedContent
  | ImageAttachmentContent

const STRUCTURED_KINDS = new Set<string>([
  'tool_call',
  'todo_update',
  'compaction',
  'permission_request',
  'ask_user_question',
  'plan_proposed',
  'image_attachment',
])

/** Best-effort parse: returns null for plain-text message content (the common case). */
export function parseStructuredContent(content: string): StructuredContent | null {
  if (!content || content[0] !== '{') return null
  try {
    const obj: unknown = JSON.parse(content)
    if (obj && typeof obj === 'object' && 'kind' in obj && STRUCTURED_KINDS.has((obj as { kind: unknown }).kind as string)) {
      return obj as StructuredContent
    }
  } catch {
    return null
  }
  return null
}
