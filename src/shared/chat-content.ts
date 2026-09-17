/**
 * Structured message content (03-chat-surface-core). `MessageRecord.content`
 * is a plain string for ordinary user/assistant text; for tool calls, todo
 * snapshots, and compaction banners it is instead a JSON-encoded object
 * tagged with a `kind` discriminant, defined here so both the main process
 * (which produces it in SessionManager) and the renderer (which parses it in
 * the transcript/tracker-rail components) share one definition.
 */

export type ToolCallStatus = 'running' | 'completed' | 'error' | 'interrupted' | 'denied'

export interface ToolCallContent {
  kind: 'tool_call'
  toolUseId: string
  name: string
  input: unknown
  status: ToolCallStatus
  output?: unknown
  /** Id of the enclosing Task tool_use when this call was made by a spawned subagent; null for top-level calls. */
  parentToolUseId: string | null
  /** From SDK `tool_progress` heartbeats while status is `running`. */
  elapsedTimeSeconds?: number
  /** Accumulated `input_json_delta` partial JSON while the tool block is still streaming. */
  inputStreamJson?: string
}

export type ThinkingBlockStatus = 'running' | 'completed'

export interface ThinkingBlockContent {
  kind: 'thinking_block'
  status: ThinkingBlockStatus
  /** Visible thinking text when the API streams it; often empty under redacted thinking. */
  text?: string
  estimatedTokens?: number
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

export interface LocalCommandOutputContent {
  kind: 'local_command_output'
  text: string
}

export type TranscriptNoticeLevel = 'warning' | 'danger'

export interface TranscriptNoticeContent {
  kind: 'transcript_notice'
  level: TranscriptNoticeLevel
  label: string
  text: string
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

export type PermissionRequestStatus = 'pending' | 'allowed' | 'denied' | 'expired'

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

export type AskUserQuestionStatus = 'pending' | 'answered' | 'cancelled' | 'expired'

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

export type PlanStatus = 'pending' | 'accepted' | 'rejected' | 'keep_planning' | 'expired'

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

/** Multi-file attachment (images, PDFs, text files). Used for new messages; legacy single-image messages use ImageAttachmentContent. */
export interface FilesAttachmentContent {
  kind: 'files_attachment'
  files: Array<{ mimeType: string; data: string; name?: string }>
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
  | FilesAttachmentContent
  | ThinkingBlockContent
  | LocalCommandOutputContent
  | TranscriptNoticeContent

const STRUCTURED_KINDS = new Set<string>([
  'tool_call',
  'thinking_block',
  'todo_update',
  'compaction',
  'permission_request',
  'ask_user_question',
  'plan_proposed',
  'image_attachment',
  'files_attachment',
  'local_command_output',
  'transcript_notice',
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

/**
 * The plain, human-readable text a message contributes to search
 * (10b-enrichment-full-text-search) — used both by the main-process SQLite
 * FTS5 index (`SessionStore.searchMessages`) and the renderer's in-conversation
 * highlighter (`ChatTranscript`'s "Find in conversation" bar), so the two
 * features always agree on exactly what's searchable: plain user/assistant
 * text only. Excludes `system` rows and every `StructuredContent` kind (tool
 * calls, todo/compaction banners, permission/question/plan cards) since none
 * of those carry prose worth indexing — reuses `parseStructuredContent`
 * rather than re-deriving that classification. Returns null when there's
 * nothing searchable.
 */
export function extractSearchableText(role: string, content: string): string | null {
  if (role !== 'user' && role !== 'assistant') return null
  const parsed = parseStructuredContent(content)
  if (parsed?.kind === 'image_attachment' || parsed?.kind === 'files_attachment') {
    const caption = parsed.text?.trim()
    return caption ? caption : null
  }
  if (parsed !== null) return null
  return content.trim().length > 0 ? content : null
}

/**
 * Markers `SessionStore.searchMessages`' FTS5 `snippet()` call wraps each
 * matched term in, so the renderer (CommandPalette) can turn a plain-text
 * snippet back into `<mark>` spans without either side re-deriving where the
 * matches are. Unicode Private Use Area code points — can never collide with
 * real typed/indexed text. Shared here (not in main-only `store.ts`) because
 * both the main process (writer) and renderer (reader) need the same values.
 */
export const FTS_SNIPPET_START = String.fromCharCode(0xe000)
export const FTS_SNIPPET_END = String.fromCharCode(0xe001)
