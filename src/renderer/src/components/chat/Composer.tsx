import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import ChatUncommittedChanges from './ChatUncommittedChanges'
import ReviewComposerCommentList from './ReviewComposerCommentList'
import type { DiffSummary } from '../../../../shared/panel-types'
import { buildComposerSendText, type ReviewComposerComment } from '../../../../shared/review-pane-types'
import type { SessionChangesCap } from '../../../../shared/session-changes-cap'
import type { SessionBookmark } from '../../../../shared/session-bookmarks'
import { sessionWorktreeBranch } from '../../../../shared/worktree-path'
import type { FileAttachment, FileAttachmentMimeType, ModelInfo, ModelSelection, ModelValidationResult, PermissionModeValue, SlashCommandInfo } from '../../../../shared/session-types'
import { modelLabelForSelection, resolveModelPickerOptions } from './model-picker-options'
import type { SessionRateLimitEvent, SessionSdkChromeEvent } from '../../../../shared/harness-ui-types'
import { handleEmacsTextareaKeyDown } from '../../palette-input-keys'
import ComposerMarkdownInput, { type ComposerMarkdownInputHandle } from './ComposerMarkdownInput'
import {
  APP_NOTE_DRAG_MIME,
  appNoteAttachRelativePath,
  formatAppNoteFileContent,
  joinToWorkspaceRoot,
  parseAppNoteDragPayload
} from '../../../../shared/app-note-attach'

/** Cap in px for the textarea's auto-grow, per mocks/index.html's `.composer-box textarea { max-height: 160px }`. */
const MAX_TEXTAREA_HEIGHT = 160

/** Pastes longer than this show a one-line summary in the composer; full text is sent on submit. */
const LARGE_PASTE_THRESHOLD = 200

interface LargePasteEntry {
  display: string
  full: string
}

function largePasteDisplayLabel(charCount: number): string {
  return `[copied ${charCount} charactors]`
}

function isExternalClipboardSummary(text: string): boolean {
  return /^\[copied\s+\d+\s+char/i.test(text.trim())
}

function insertTextAtSelection(
  current: string,
  insertion: string,
  selectionStart: number,
  selectionEnd: number
): { next: string; cursor: number } {
  const before = current.slice(0, selectionStart)
  const after = current.slice(selectionEnd)
  const next = before + insertion + after
  return { next, cursor: before.length + insertion.length }
}

function resolveSendText(display: string, largePastes: readonly LargePasteEntry[]): string {
  let result = display
  for (const { display: token, full } of largePastes) {
    result = result.split(token).join(full)
  }
  return result
}

async function resolvePasteText(clipboardData: DataTransfer): Promise<string> {
  const sync = clipboardData.getData('text/plain')
  if (sync && !isExternalClipboardSummary(sync)) return sync
  try {
    const asyncText = await navigator.clipboard.readText()
    if (asyncText && !isExternalClipboardSummary(asyncText)) return asyncText
    if (asyncText) return asyncText
  } catch {
    // Fall back to whatever the paste event provided.
  }
  return sync
}

/** Cap on how many `@file` matches are rendered at once — the underlying file walk is already capped (files.ts's MAX_ENTRIES), this just keeps the popover itself short and scannable. */
const MAX_MENTION_MATCHES = 20

const CONTEXT_BRANCH_ICON = (
  <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 7.2V16.8M6 9.5a6 6 0 0 0 6 6h4"/></svg>
)

const CONTEXT_WORKTREE_ICON = (
  <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20 4C10 4 4 10 4 18v2h2c8 0 14-6 14-16z"/><path d="M9 19c3-5 6-8 11-11"/></svg>
)

/**
 * Icon + label per permission mode (11-composer-mode-indicator), quoted
 * verbatim from mocks/index.html's `composer-mode-row` markup — same glyphs,
 * same copy, same cycle order as `MODE_CYCLE` in `main/sessions/manager.ts`.
 */
const MODE_ICON: Record<PermissionModeValue, JSX.Element> = {
  default: (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <circle cx="6" cy="6" r="3.5" fill="currentColor" />
    </svg>
  ),
  plan: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="2.5" y="2" width="2.25" height="8" rx="0.75" />
      <rect x="7.25" y="2" width="2.25" height="8" rx="0.75" />
    </svg>
  ),
  acceptEdits: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m2 3 3 3-3 3M6 3l3 3-3 3" />
    </svg>
  ),
  auto: (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 1.5 2.75 6.25H6L5 10.5l4.25-5H6z" />
    </svg>
  )
}
const MODE_LABEL: Record<PermissionModeValue, string> = {
  default: 'Default',
  plan: 'Plan mode',
  acceptEdits: 'Accept edits',
  auto: 'Auto'
}

/**
 * Effort options shown in the picker. The full SDK-supported union is
 * `'low' | 'medium' | 'high' | 'xhigh' | 'max'` (verified against `sdk.d.ts`'s
 * `EffortLevel`), but the mock's own picker only ever lists Low/Medium/High
 * — matched here exactly rather than surfacing the two newer, less commonly
 * useful tiers this simple dropdown has no room to explain.
 */
const EFFORT_OPTIONS: { id: NonNullable<ModelSelection['effort']>; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
]

/** Fallback label only reached if `modelSelection` is ever `null`. */
const DEFAULT_LABEL = 'Sonnet 5 · High'

function labelFor(
  selection: ModelSelection | null,
  modelOptions: ReturnType<typeof resolveModelPickerOptions>
): string {
  if (!selection) return DEFAULT_LABEL
  const modelLabel = modelLabelForSelection(selection.model, modelOptions)
  const effortLabel = EFFORT_OPTIONS.find((e) => e.id === selection.effort)?.label ?? EFFORT_OPTIONS[2].label
  return `${modelLabel} · ${effortLabel}`
}

/**
 * "Model · Effort ▾" picker (10f-enrichment-model-effort-picker), styled and
 * structured to match mocks/index.html's `togglePicker()`/`.picker-pop`/
 * `.picker-item`/`.label-caps` exactly. Selecting an option calls
 * `onChange` with a FULL `ModelSelection` (both fields always populated
 * together, defaulting the untouched field to the first/last option) — the
 * change only affects the NEXT message sent (see `App.tsx`'s `handleSend`,
 * which reads this same state at send time), never the turn already in
 * flight, since the SDK itself only reads `model`/`effort` at its own
 * `start()`/`resume()` call time (verified — see
 * `HarnessStartOptions.model`/`.effort`'s doc comments).
 *
 * `open`/`onOpenChange` are lifted up into `Composer` (bug #56) rather than
 * kept as this component's own local state, so typing `/model` and hitting
 * Enter/Tab (or clicking the `/model` slash-command entry) can open this
 * exact popover instead of a second, redundant "opened" state living here.
 */
function ModelPicker({
  selection,
  onChange,
  open,
  onOpenChange,
  liveModels
}: {
  selection: ModelSelection | null
  onChange: (selection: ModelSelection) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  liveModels: ModelInfo[]
}): JSX.Element {
  const modelOptions = resolveModelPickerOptions(liveModels)
  // Live /model list supplies options; 'default' matches SDK alias fallback.
  const currentModel = selection?.model ?? modelOptions[0]?.id ?? 'default'
  const currentEffort = selection?.effort ?? EFFORT_OPTIONS[2].id

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(): void {
      onOpenChange(false)
    }
    document.addEventListener('click', handleOutsideClick)
    return () => document.removeEventListener('click', handleOutsideClick)
  }, [open, onOpenChange])

  function pickModel(model: string): void {
    onChange({ model, effort: currentEffort })
  }

  function pickEffort(effort: NonNullable<ModelSelection['effort']>): void {
    onChange({ model: currentModel, effort })
  }

  return (
    <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
      <button
        className="footer-btn"
        data-testid="model-picker-button"
        onClick={() => onOpenChange(!open)}
      >
        <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3l1.8 5.4L19 10l-5.2 1.6L12 17l-1.8-5.4L5 10l5.2-1.6z" />
        </svg>
        <span className="composer-model-label">{labelFor(selection, modelOptions)} ▾</span>
      </button>
      {open && (
        <div className="picker-pop" data-testid="model-picker-popover">
          <div className="label-caps" style={{ padding: '4px 8px' }}>Model</div>
          {modelOptions.map((opt) => (
            <div
              key={opt.id}
              className={'picker-item' + (opt.id === currentModel ? ' sel' : '')}
              data-testid={`model-option-${opt.id}`}
              onClick={() => {
                pickModel(opt.id)
                onOpenChange(false)
              }}
            >
              <span>{opt.displayName}</span>
              {opt.contextLabel ? (
                <span className="picker-item-meta">{opt.contextLabel}</span>
              ) : null}
            </div>
          ))}
          <div className="label-caps" style={{ padding: '8px 8px 4px' }}>Effort</div>
          {EFFORT_OPTIONS.map((opt) => (
            <div
              key={opt.id}
              className={'picker-item' + (opt.id === currentEffort ? ' sel' : '')}
              data-testid={`effort-option-${opt.id}`}
              onClick={() => {
                pickEffort(opt.id)
                onOpenChange(false)
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ACCEPTED_IMAGE_MIME_TYPES = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
const ACCEPTED_PDF_MIME_TYPES = new Set<string>(['application/pdf'])
/** Extensions whose files are sent as plain-text document blocks regardless of the browser-reported MIME. */
const TEXT_EXTENSIONS = new Set(['.md', '.ts', '.tsx', '.js', '.jsx', '.py', '.json', '.sh', '.bash', '.yaml', '.yml', '.css', '.html', '.xml', '.txt', '.toml', '.go', '.rs', '.rb', '.java', '.c', '.cpp', '.h', '.swift', '.kt', '.php', '.r', '.sql'])
/** Max bytes per individual file (20 MB). */
const MAX_FILE_BYTES = 20 * 1024 * 1024

type AttachedFile = FileAttachment & {
  /** `data:<mime>;base64,<data>` — only set for images, for the thumbnail `<img src>`. */
  previewUrl?: string
}

type PendingAppNoteAttach = {
  id: string
  title: string
}

export interface ComposerHandle {
  setValue(text: string): void
  getValue(): string
  focus(): void
}

interface ComposerProps {
  onSend: (text: string, attachments?: FileAttachment[]) => void
  onInterrupt: () => void
  /** True while a turn is in flight for the active session — shows Stop alongside Send, per e2e-test-plan.md/spec.md. */
  busy: boolean
  /** Active session id — used for worktree branch label before git/harness events arrive. */
  sessionId?: string
  /** Session mode — hides Claude-specific controls (mode pill, model picker) for non-claude-code sessions. */
  sessionMode?: string
  /** Active session's project root — `@file` mentions are resolved (real, live `fs` walk via the existing Files-panel IPC) against this. Undefined/empty just disables the mention popover. */
  projectPath?: string
  /** Worktree path if the session runs inside a git worktree, else null. */
  worktreePath?: string | null
  /** Claude Code cwd from the harness (SDK init + inferred Bash `cd`). */
  harnessCwd?: string | null
  /** Hostname for remote sessions — forwarded to git IPC calls. */
  hostname?: string | null
  /** Git cwd (`worktreePath ?? projectPath`) — session workspace root for the changes cap. */
  gitWorkspacePath?: string
  /** Preloaded git summary for branch refresh when Claude cwd matches workspace. */
  diffSummary?: DiffSummary | null
  /** Pending files for the chat changes cap. */
  sessionChangesCap?: SessionChangesCap | null
  /** Session-scoped chat link/file bookmarks shown in the same cap. */
  sessionBookmarks?: readonly SessionBookmark[]
  /** Preloaded workspace file paths for @-mentions (relative paths). */
  mentionFilePaths?: string[]
  /** Chat changes cap: open the file in the dedicated right-side review renderer. */
  onOpenChangedFile?: (path: string, opensInFilesTab: boolean) => void
  /** Opens a bookmarked link externally or a bookmarked file in the review renderer. */
  onOpenBookmark?: (bookmark: SessionBookmark) => void
  /** Removes a standalone bookmark from the in-chat Bookmarks list. */
  onRemoveBookmark?: (bookmark: SessionBookmark) => void
  /** `/fork` slash command's real action: forks the active session (same as the sidebar's fork action). */
  onFork: () => void
  /** `/clear` slash command: wipe transcript + start a fresh CLI conversation. */
  onClearConversation: () => void
  /** Current model/effort override (10f-enrichment-model-effort-picker); `null` until the user picks something, in which case no override is sent at all (harness default). */
  modelSelection: ModelSelection | null
  /** Fired the moment the user picks a new model/effort — applies starting with the NEXT `onSend`, never the in-flight turn. */
  onModelSelectionChange: (selection: ModelSelection) => void
  /**
   * Live slash-command registry for the active session (bug #56) — the REAL
   * list the SDK itself reports (`SessionCommandsEvent`, sourced from
   * `query.initializationResult()` / mid-session `commands_changed` pushes),
   * not a hand-maintained client array. Empty until the harness's first push
   * for this session lands (typically within the same tick or two as
   * session start/resume). Atelier's own client-only conveniences (`/clear`,
   * `/interrupt`, `/fork`, `/model`) are added on top of this list locally —
   * see `slashCommands` below — since the SDK has no concept of them.
   */
  liveSlashCommands: SlashCommandInfo[]
  /** Live model registry from SDK initialization — drives the model picker list. */
  liveModels?: ModelInfo[]
  /** Current SDK permission mode for the active session (11-composer-mode-indicator) — always defined, defaulting to 'default' for a session that's never been cycled. */
  mode: PermissionModeValue
  /** Fired on Shift+Tab (composer focused) or a click on the mode pill — cycles default -> plan -> acceptEdits -> auto -> default via a real IPC round-trip to SessionManager.cycleMode. */
  onCycleMode: () => void
  /** Messages queued while the session was busy (message-queue). Rendered as `.queued-strip` rows inside `.composer-box`. Empty when idle or no queue. */
  queuedMessages?: string[]
  /** Pending review comments (display cards only — full notes merged on send). */
  reviewComments?: ReviewComposerComment[]
  onUpdateReviewCommentBody?: (commentId: string, body: string) => void
  onDeleteReviewComment?: (commentId: string) => void
  /** Cancels the queued message at `index` (0-based). Wired to the ✕ button in each `.queued-strip` row. */
  onCancelQueued?: (index: number) => void
  /**
   * Current context-window token usage for this session (token-usage-indicator).
   * Undefined until the session's first turn completes. Values come from the
   * SDK's `getContextUsage()`: usage is total in-context tokens; cap is the
   * effective context window (`maxTokens`), not the auto-compaction trigger.
   */
  tokenUsage?: { inputTokens: number; contextWindow: number }
  /** SDK `prompt_suggestion` — placeholder in the empty composer; Tab accepts. */
  promptSuggestion?: string
  /** SDK rate-limit chrome — composer chips + send block when rejected. */
  rateLimit?: SessionRateLimitEvent | null
  /** SDK status chrome — turn-in-flight hint above the input (requesting / api retry). */
  sdkChrome?: SessionSdkChromeEvent | null
  /** Appends a renderer-only system message to the active session's transcript, no SDK round-trip — used to surface an unknown `/model <id>` inline in the chat panel. */
  onAddLocalMessage: (content: string) => void
  /** Validates a `/model <id>` against the SDK's own live acceptance logic (calls `Query.setModel()` on the connected session), fetched on demand at the moment `/model <id>` is submitted — not a static list, since the backend silently substitutes the default model for an unrecognized id instead of erroring on it (the only reason `setModel()`'s real accept/reject signal is trustworthy here). */
  onValidateModel: (model: string) => Promise<ModelValidationResult>
  /** True when the harness is not connected (session-startup-idle) — composer is read-only until Reconnect. */
  harnessDisconnected?: boolean
  /** False for cached per-session composers hidden off-screen — skips cursor mirror + auto-grow. */
  active?: boolean
}

interface SlashCommand {
  cmd: string
  desc: string
  /**
   * Local-only real action (`/clear`, `/interrupt`, `/fork`, `/model`) —
   * selecting/submitting this command swallows the typed token and runs
   * this instead; it is NEVER forwarded to `session:sendMessage` (bug #56's
   * "must not regress" scenario). Omitted entirely for a live, SDK-reported
   * command Atelier has no special UI for — those are dispatched as a real
   * prompt turn instead (see `selectSlash` below).
   */
  run?: () => void
}

type PopoverState = { kind: 'mention' | 'slash'; query: string; tokenStart: number } | null

function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsText(file, 'utf-8')
  })
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/** Returns null for unsupported/oversized files. Error string for size violations (to show to user). */
async function readAttachedFile(file: File): Promise<AttachedFile | 'too_large' | null> {
  if (file.size > MAX_FILE_BYTES) return 'too_large'
  const ext = fileExtension(file.name)
  if (ACCEPTED_IMAGE_MIME_TYPES.has(file.type)) {
    const previewUrl = await readAsDataUrl(file)
    const commaIndex = previewUrl.indexOf(',')
    if (commaIndex === -1) return null
    return { mimeType: file.type as FileAttachmentMimeType, data: previewUrl.slice(commaIndex + 1), name: file.name, previewUrl }
  }
  if (ACCEPTED_PDF_MIME_TYPES.has(file.type)) {
    const dataUrl = await readAsDataUrl(file)
    const commaIndex = dataUrl.indexOf(',')
    if (commaIndex === -1) return null
    return { mimeType: 'application/pdf', data: dataUrl.slice(commaIndex + 1), name: file.name }
  }
  if (TEXT_EXTENSIONS.has(ext) || file.type.startsWith('text/')) {
    const text = await readAsText(file)
    return { mimeType: 'text/plain', data: text, name: file.name }
  }
  return null
}

/**
 * Composer core (04-composer-core) + `@file` mention / `/` slash-command
 * autocomplete (10e-enrichment-file-mentions-and-commands): multi-line
 * auto-grow textarea (Enter sends, Shift+Enter inserts a newline), a real
 * Send/Stop pill that swaps based on `busy`, and two live popovers that
 * trigger on keystroke — matching `mocks/index.html`'s
 * `.mention-popup`/`.slash-popup` markup+CSS and keyboard-nav interaction
 * pattern lifted from CommandPalette.tsx (arrows to move, Enter/Tab to
 * select, Escape to dismiss).
 *
 * `@partial` anywhere in the text opens a popover of REAL files under the
 * session's `projectPath` (reusing the Files panel's own `filesTree` IPC —
 * no separate file-walking implementation), filtered by substring on
 * `relativePath`/name, same `.includes()` filtering CommandPalette already
 * uses. Selecting one replaces the partial token with `@relative/path `.
 *
 * `/partial` only triggers when it's the very first token in the composer
 * (matches the mock's `val.trim() === lastWord` guard — a slash command is
 * the whole input, not a token mid-sentence) and opens a popover listing:
 *   - Four LOCAL, Atelier-only real actions Atelier intercepts (bug #56 —
 *     these never reach `session:sendMessage`, since the SDK has no concept
 *     of any of them):
 *       - `/clear`     — clears the conversation (transcript + SDK session)
 *       - `/interrupt` — stops the current in-flight turn (same real IPC as the Stop button)
 *       - `/fork`      — forks the active session (same real IPC as the sidebar's fork action)
 *       - `/model`     — opens the REAL `ModelPicker` popover (its `open` state
 *         is lifted up into this component for exactly this reason) instead
 *         of ever being sent as literal chat text — the bug this task fixes:
 *         previously `/model` wasn't in the (hardcoded) list at all, so
 *         typing it and pressing Enter fell straight through to an ordinary
 *         `onSend`, posting "/model" as a real user message with no handler
 *         on the other end.
 *   - Every OTHER command the harness's live registry reports for this
 *     session (`liveSlashCommands`, backed by the SDK's own
 *     `query.initializationResult()` / mid-session `commands_changed` push —
 *     see `main/harness/claude-agent-sdk-harness.ts`) — real built-ins
 *     (`/compact`, `/cost`, `/usage`, ...), project/plugin commands, or
 *     dynamically-discovered skills. Atelier has no special UI for any of
 *     these, so selecting one is NOT swallowed into a local action — it is
 *     dispatched through `onSend` as an ordinary prompt turn, exactly like
 *     typing it out in full and pressing Enter without ever opening this
 *     popover (that's how the CLI/SDK's own local slash commands execute
 *     server-side: as a real turn). This is deliberately NOT a hardcoded
 *     4th-command re-list — see `slashCommands` below.
 *
 * The four local commands above are exactly the ones the SDK's own list
 * might also legitimately report (e.g. a real Claude Code session likely
 * has genuine `/model` and `/clear` built-ins) — when that happens they're
 * de-duplicated in favor of Atelier's local action, never doubled up in
 * the popover (see `slashCommands`' `localNames` filter).
 *
 * Selecting a slash command always removes the typed token from the
 * composer first; what happens next depends on whether it's local (real
 * client-side action, never sent as text) or forwarded (dispatched as a
 * real prompt turn) — see `selectSlash` below.
 *
 * Sending while `busy` queues the message for automatic dispatch when the
 * current turn finishes (message-queue). While busy the send control stays an
 * up-arrow icon (tooltip "Queue"); `.queued-strip` rows show pending messages.
 * Image attachments can't be queued and fall through to the normal send path.
 *
 * Image attachment (10g-enrichment-image-attachment): dropping or pasting an
 * image renders a real thumbnail chip in `.attach-row`/`.attach-thumb`
 * (matching the mock's Attach affordance markup/CSS exactly — see
 * mocks/index.html's `attachDemoImage()` — except the thumb here shows the
 * REAL dropped/pasted image via an `<img>`, not the mock's gradient
 * placeholder icon) with a `.remove` (×) button to clear it before sending.
 * `onSend` receives the image alongside whatever text was typed, single
 * image at a time (dropping/pasting a second one replaces the first — no
 * multi-attach UI, per spec.md's minimal scope).
 */
const CARET_MIRROR_PROPS = [
  'borderBottomWidth', 'borderLeftWidth', 'borderRightWidth', 'borderTopWidth',
  'boxSizing', 'fontFamily', 'fontSize', 'fontStyle', 'fontVariant', 'fontWeight',
  'letterSpacing', 'lineHeight', 'paddingBottom', 'paddingLeft', 'paddingRight', 'paddingTop',
  'textIndent', 'textRendering', 'textTransform', 'width', 'wordSpacing', 'overflowWrap', 'wordWrap'
] as const

let caretMirrorDiv: HTMLDivElement | null = null
let caretMirrorMarker: HTMLSpanElement | null = null

function getCaretCoordinates(ta: HTMLTextAreaElement, position: number): { top: number; left: number } {
  if (!caretMirrorDiv) {
    caretMirrorDiv = document.createElement('div')
    caretMirrorMarker = document.createElement('span')
    caretMirrorMarker.textContent = '\u200b'
    caretMirrorDiv.style.position = 'absolute'
    caretMirrorDiv.style.visibility = 'hidden'
    caretMirrorDiv.style.whiteSpace = 'pre-wrap'
    caretMirrorDiv.style.overflow = 'hidden'
    caretMirrorDiv.style.top = '0'
    caretMirrorDiv.style.left = '0'
    document.body.appendChild(caretMirrorDiv)
  }
  const div = caretMirrorDiv
  const marker = caretMirrorMarker!
  const cs = window.getComputedStyle(ta)
  for (const prop of CARET_MIRROR_PROPS) {
    ;(div.style as unknown as Record<string, string>)[prop] = (cs as unknown as Record<string, string>)[prop]
  }
  div.replaceChildren(document.createTextNode(ta.value.slice(0, position)), marker)
  return { top: marker.offsetTop - ta.scrollTop, left: marker.offsetLeft }
}

export default forwardRef<ComposerHandle, ComposerProps>(function Composer({
  onSend,
  onInterrupt,
  busy,
  sessionId,
  sessionMode,
  projectPath,
  worktreePath,
  harnessCwd,
  hostname,
  gitWorkspacePath,
  diffSummary,
  sessionChangesCap,
  sessionBookmarks = [],
  mentionFilePaths,
  onOpenChangedFile,
  onOpenBookmark,
  onRemoveBookmark,
  onFork,
  onClearConversation,
  modelSelection,
  onModelSelectionChange,
  liveSlashCommands,
  liveModels = [],
  mode,
  onCycleMode,
  queuedMessages = [],
  reviewComments = [],
  onUpdateReviewCommentBody,
  onDeleteReviewComment,
  onCancelQueued,
  tokenUsage,
  promptSuggestion,
  rateLimit,
  sdkChrome, // minion_working → composer-turn-status
  onAddLocalMessage,
  onValidateModel,
  harnessDisconnected = false,
  active = true
}: ComposerProps, ref): JSX.Element {
  const [value, setValue] = useState('')
  const valueRef = useRef(value)
  valueRef.current = value
  const largePastesRef = useRef<LargePasteEntry[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const markdownInputRef = useRef<ComposerMarkdownInputHandle>(null)
  const [popover, setPopover] = useState<PopoverState>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [branch, setBranch] = useState<string | null>(null)
  const [branchCopied, setBranchCopied] = useState(false)
  const [fileList, setFileList] = useState<string[]>([])
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [pendingAppNotes, setPendingAppNotes] = useState<PendingAppNoteAttach[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const [inputMultiline, setInputMultiline] = useState(false)
  // `/model`'s target — lifted out of ModelPicker itself (bug #56) so typing
  // the full command and pressing Enter/Tab, or clicking its slash-item, can
  // open the SAME real popover the footer button opens.
  const [modelPickerOpen, setModelPickerOpen] = useState(false)

  const [cursorPhase, setCursorPhase] = useState<'typing' | 'idle' | 'unfocused'>('unfocused')
  const [cursorPos, setCursorPos] = useState<{ top: number; left: number; height?: number } | null>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorRafRef = useRef<number | null>(null)

  const updateCursorPos = useCallback(() => {
    if (!active) return
    const ta = textareaRef.current
    if (!ta) return
    const position = ta.selectionStart ?? 0
    const composer = ta.closest<HTMLElement>('.composer-box')
    if (!composer) return
    const composerRect = composer.getBoundingClientRect()
    const renderedCoords = markdownInputRef.current?.getCursorCoordinates(position)
    if (renderedCoords) {
      const relTop = renderedCoords.top - composerRect.top
      const relLeft = renderedCoords.left - composerRect.left
      // Only use CM6 coords when they land within the visible composer area.
      // The CM6 scroll position is a pixel copy from the textarea but the two
      // layouts have different line heights, so the coordinates can drift
      // outside the box when headings/code blocks push lines past the cursor.
      if (relTop >= 0 && relTop <= composerRect.height && relLeft >= 0) {
        setCursorPos({ top: relTop, left: relLeft, height: renderedCoords.height })
        return
      }
    }
    const coords = getCaretCoordinates(ta, position)
    const textareaRect = ta.getBoundingClientRect()
    setCursorPos({
      top: coords.top + textareaRect.top - composerRect.top - composer.clientTop,
      left: coords.left + textareaRect.left - composerRect.left - composer.clientLeft
    })
  }, [active])

  const scheduleCursorUpdate = useCallback(() => {
    if (!active || cursorRafRef.current != null) return
    cursorRafRef.current = requestAnimationFrame(() => {
      cursorRafRef.current = null
      updateCursorPos()
    })
  }, [active, updateCursorPos])

  /** Recomputes trigger state from the token immediately before the cursor. */
  const updatePopoverFromCursor = useCallback((text: string, cursor: number): void => {
    const before = text.slice(0, cursor)
    const tokenStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1
    const token = before.slice(tokenStart)

    if (token.startsWith('@')) {
      setPopover({ kind: 'mention', query: token.slice(1), tokenStart })
      setSelectedIndex(0)
      return
    }
    if (token.startsWith('/') && tokenStart === 0) {
      setPopover({ kind: 'slash', query: token.slice(1), tokenStart })
      setSelectedIndex(0)
      return
    }
    setPopover(null)
  }, [])

  const syncPopoverFromTextarea = useCallback((): void => {
    const ta = textareaRef.current
    if (!ta) return
    updatePopoverFromCursor(ta.value, ta.selectionStart ?? ta.value.length)
  }, [updatePopoverFromCursor])

  const onTextareaFocus = useCallback(() => {
    setCursorPhase('idle')
    scheduleCursorUpdate()
    syncPopoverFromTextarea()
  }, [scheduleCursorUpdate, syncPopoverFromTextarea])

  const onTextareaBlur = useCallback(() => {
    if (typingTimer.current) clearTimeout(typingTimer.current)
    setCursorPhase('unfocused')
    scheduleCursorUpdate()
  }, [scheduleCursorUpdate])

  const onTextareaKeyActivity = useCallback(() => {
    setCursorPhase('typing')
    scheduleCursorUpdate()
    if (typingTimer.current) clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => setCursorPhase('idle'), 500)
  }, [scheduleCursorUpdate])

  useEffect(() => {
    if (!active) return
    scheduleCursorUpdate()
  }, [active, value, scheduleCursorUpdate])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [active])

  // Composers stay mounted across session switches (draft cache). Drop file
  // attachments when leaving so a screenshot from "many sessions ago" cannot
  // silently ride along on the next Minion send (Vibe dashboard Error 1406).
  useEffect(() => {
    if (active) return
    setAttachedFiles((prev) => (prev.length === 0 ? prev : []))
    setPendingAppNotes((prev) => (prev.length === 0 ? prev : []))
  }, [active])

  useEffect(() => {
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current)
      if (cursorRafRef.current != null) cancelAnimationFrame(cursorRafRef.current)
    }
  }, [])

  useImperativeHandle(ref, () => ({
    setValue: (text: string) => {
      largePastesRef.current = []
      setValue(text)
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (!ta) return
        updatePopoverFromCursor(text, ta.selectionStart ?? text.length)
      })
    },
    getValue: () => value,
    focus: () => textareaRef.current?.focus()
  }), [updatePopoverFromCursor, value])

  // Git branch at Claude's current path — refreshed when cwd or workspace diff changes.
  useEffect(() => {
    const claudePath = harnessCwd ?? worktreePath ?? projectPath
    if (!claudePath) { setBranch(null); return }
    if (gitWorkspacePath === claudePath && diffSummary?.isRepo) {
      setBranch(diffSummary.branch)
      return undefined
    }
    let cancelled = false
    window.atelier.gitBranch(claudePath, hostname ?? null).then((b) => { if (!cancelled) setBranch(b) }).catch(() => { if (!cancelled) setBranch(null) })
    return () => { cancelled = true }
  }, [projectPath, worktreePath, harnessCwd, gitWorkspacePath, diffSummary, hostname])

  // Real file list for @-mentions: from preloaded workspace when available.
  useEffect(() => {
    if (mentionFilePaths != null) {
      setFileList(mentionFilePaths)
      return undefined
    }
    // Remote/devpod: never background-scan the workspace — wait for preload snapshot.
    if (hostname) {
      setFileList([])
      return undefined
    }
    let cancelled = false
    if (!projectPath) {
      setFileList([])
      return undefined
    }
    const listPath = worktreePath || projectPath
    window.atelier.filesList(listPath, null, hostname ?? null).then((entries) => {
      if (!cancelled) setFileList(entries.map((e) => e.relativePath))
    })
    return () => {
      cancelled = true
    }
  }, [projectPath, worktreePath, hostname, mentionFilePaths])

  // bug #56: the four commands Atelier handles itself, merged on top of
  // whatever the harness's live registry reports. `localNames` also drives
  // de-duplication below — if the SDK's own list happens to report one of
  // these names too (a real session likely does report a genuine `/model`
  // and `/clear`), Atelier's local action wins and the live entry is
  // dropped rather than shown twice.
  const slashCommands: SlashCommand[] = useMemo(() => {
    const local: SlashCommand[] = [
      { cmd: '/clear', desc: 'Clear conversation', run: () => { largePastesRef.current = []; setValue(''); onClearConversation() } },
      { cmd: '/interrupt', desc: 'Stop the current in-flight turn', run: () => onInterrupt() },
      { cmd: '/fork', desc: 'Fork this session into a new one', run: () => onFork() },
      { cmd: '/model', desc: 'Open the model/effort picker', run: () => setModelPickerOpen(true) }
    ]
    // `seenNames` starts with the 4 local command names and also accumulates
    // live command names as they're added — this deduplicates in both
    // directions: local commands win over same-named SDK entries (pre-existing
    // behavior), AND duplicate entries within `liveSlashCommands` itself are
    // collapsed to their first occurrence. The SDK can return the same name
    // multiple times when it discovers commands from multiple sources (built-in
    // CLI commands, CLAUDE.md skills, MCP server tools, project-level .claude/
    // commands), and without this guard each duplicate passes the old
    // `!localNames.has(c.name)` filter and appears twice in the popup
    // (confirmed: both entries render because `key={command.cmd}` is the same
    // for both — a React duplicate-key case that still renders all items).
    const seenNames = new Set(local.map((c) => c.cmd.slice(1)))
    // No `run` here on purpose — see `selectSlash`'s handling of a command
    // with no `run`: it forwards the command through as a real prompt turn
    // instead of swallowing it into a local action Atelier doesn't have.
    const live: SlashCommand[] = liveSlashCommands
      .filter((c) => {
        if (seenNames.has(c.name)) return false
        seenNames.add(c.name)
        return true
      })
      .map((c) => ({ cmd: `/${c.name}`, desc: c.description || c.argumentHint || 'Session command' }))
    return [...local, ...live]
  }, [onInterrupt, onFork, onClearConversation, liveSlashCommands])

  useEffect(() => {
    if (!active) return
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const cs = window.getComputedStyle(ta)
    const lineHeight = parseFloat(cs.lineHeight) || 22
    const verticalPad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const minContentHeight = lineHeight + verticalPad
    const singleLineHeight = Math.max(minContentHeight, parseFloat(cs.minHeight) || 0)

    // Always decide wrapping against the narrower inline-control layout.
    // Otherwise moving the controls below can widen the textarea enough to
    // unwrap it, causing the actions to oscillate between both positions.
    ta.style.paddingRight = '226px'
    const inlineScrollHeight = ta.scrollHeight
    const nextMultiline = inlineScrollHeight > singleLineHeight + 1

    ta.style.paddingRight = nextMultiline ? '18px' : '226px'
    const layoutScrollHeight = ta.scrollHeight
    const capped = layoutScrollHeight > MAX_TEXTAREA_HEIGHT
    const next = Math.min(Math.max(layoutScrollHeight, minContentHeight), MAX_TEXTAREA_HEIGHT)
    ta.style.height = `${next}px`
    ta.style.overflowY = capped ? 'auto' : 'hidden'
    ta.style.removeProperty('padding-right')
    setInputMultiline(nextMultiline)
    if (!value.trim()) ta.scrollTop = 0
  }, [active, inputMultiline, value])

  const mentionMatches = useMemo(() => {
    if (popover?.kind !== 'mention') return []
    const q = popover.query.toLowerCase()
    return fileList.filter((f) => f.toLowerCase().includes(q)).slice(0, MAX_MENTION_MATCHES)
  }, [popover, fileList])

  const slashMatches = useMemo(() => {
    if (popover?.kind !== 'slash') return []
    const q = popover.query.toLowerCase()
    return slashCommands.filter((c) => c.cmd.slice(1).startsWith(q))
  }, [popover, slashCommands])

  const activeMatches: (string | SlashCommand)[] =
    popover?.kind === 'mention' ? mentionMatches : popover?.kind === 'slash' ? slashMatches : []

  async function materializePendingAppNotes(): Promise<string[]> {
    if (pendingAppNotes.length === 0) return []
    const workspaceRoot = harnessCwd ?? worktreePath ?? projectPath ?? ''
    if (!workspaceRoot.trim()) {
      onAddLocalMessage('Cannot attach app notes — session workspace path is not available yet.')
      return []
    }

    const mentionPaths: string[] = []
    for (const pending of pendingAppNotes) {
      let note
      try {
        note = await window.atelier.getAppNote(pending.id)
      } catch {
        onAddLocalMessage(`Could not attach note "${pending.title}" — it may have been deleted.`)
        continue
      }
      const relativePath = appNoteAttachRelativePath(note.id, note.title)
      const absolutePath = joinToWorkspaceRoot(relativePath, workspaceRoot)
      const result = await window.atelier.filesWrite(absolutePath, formatAppNoteFileContent(note), hostname)
      if (!result.ok) {
        onAddLocalMessage(`Could not write note "${pending.title}" to the workspace: ${result.error ?? 'unknown error'}`)
        continue
      }
      mentionPaths.push(relativePath)
    }
    return mentionPaths
  }

  async function handleSend(): Promise<void> {
    const text = resolveSendText(value, largePastesRef.current).trim()
    const mentionPaths = await materializePendingAppNotes()
    const mentionPrefix = mentionPaths.length > 0 ? mentionPaths.map((p) => `@${p}`).join(' ') + ' ' : ''
    const mergedText = (mentionPrefix + text).trim()
    const sendText = buildComposerSendText(mergedText, reviewComments)
    if (!sendText && !attachedFiles.length) return
    // `/model <model-id>` validates against the SDK's own live acceptance
    // logic (calls `Query.setModel()` on the connected session and checks
    // whether it threw) rather than any static/curated list — verified for
    // real that the backend otherwise silently substitutes the default
    // model for an unrecognized id instead of erroring on it, so a static
    // list can't tell a typo from a legitimate uncurated override (e.g. an
    // older family left out of the live `/model` picker). `setModel()`'s
    // own error text is shown verbatim.
    if (text.startsWith('/model ')) {
      const arg = text.slice('/model '.length).trim()
      if (arg) {
        setValue('')
        largePastesRef.current = []
        const result = await onValidateModel(arg)
        if (!result.ok) {
          onAddLocalMessage(`Unknown model "${arg}": ${result.error}`)
          return
        }
        onModelSelectionChange({ model: arg, effort: modelSelection?.effort ?? 'high' })
        return
      }
    }
    const outAttachments: FileAttachment[] = attachedFiles.map(({ previewUrl: _, ...f }) => f)
    onSend(mergedText, outAttachments.length ? outAttachments : undefined)
    setValue('')
    largePastesRef.current = []
    setAttachedFiles([])
    setPendingAppNotes([])
  }

  async function attachFiles(files: File[]): Promise<void> {
    const results = await Promise.all(files.map((f) => readAttachedFile(f)))
    const valid: AttachedFile[] = []
    for (const r of results) {
      if (r === 'too_large') {
        // TODO: surface a proper toast; for now just skip
        continue
      }
      if (r) valid.push(r)
    }
    if (valid.length > 0) setAttachedFiles((prev) => [...prev, ...valid])
  }

  function acceptsComposerDrop(types: readonly string[]): boolean {
    return types.includes('Files') || types.includes(APP_NOTE_DRAG_MIME)
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!acceptsComposerDrop(e.dataTransfer.types)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setIsDragOver(true)
  }

  function handleDragLeave(): void {
    setIsDragOver(false)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    e.preventDefault()
    setIsDragOver(false)
    const notePayload = parseAppNoteDragPayload(e.dataTransfer.getData(APP_NOTE_DRAG_MIME))
    if (notePayload) {
      setPendingAppNotes((prev) =>
        prev.some((n) => n.id === notePayload.id) ? prev : [...prev, { id: notePayload.id, title: notePayload.title }]
      )
      return
    }
    if (e.dataTransfer.files.length === 0) return
    void attachFiles(Array.from(e.dataTransfer.files))
  }

  function applyTextPaste(pasted: string, selectionStart: number, selectionEnd: number): void {
    const insert =
      pasted.length > LARGE_PASTE_THRESHOLD ? largePasteDisplayLabel(pasted.length) : pasted
    const { next, cursor } = insertTextAtSelection(valueRef.current, insert, selectionStart, selectionEnd)
    if (pasted.length > LARGE_PASTE_THRESHOLD) {
      largePastesRef.current = [...largePastesRef.current, { display: insert, full: pasted }]
    }
    setValue(next)
    updatePopoverFromCursor(next, cursor)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.setSelectionRange(cursor, cursor)
    })
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const items = Array.from(e.clipboardData.items)
    const imageFiles = items
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null)
    if (imageFiles.length > 0) {
      e.preventDefault()
      void attachFiles(imageFiles)
      return
    }

    const hasText =
      items.some((item) => item.kind === 'string' && item.type === 'text/plain') ||
      e.clipboardData.types.includes('text/plain')
    if (!hasText) return

    e.preventDefault()
    const ta = textareaRef.current
    if (!ta) return
    const selectionStart = ta.selectionStart ?? valueRef.current.length
    const selectionEnd = ta.selectionEnd ?? valueRef.current.length

    void (async () => {
      const pasted = await resolvePasteText(e.clipboardData)
      if (!pasted) return
      applyTextPaste(pasted, selectionStart, selectionEnd)
    })()
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    const text = e.target.value
    largePastesRef.current = largePastesRef.current.filter((entry) => text.includes(entry.display))
    setValue(text)
    updatePopoverFromCursor(text, e.target.selectionStart ?? text.length)
  }

  function selectMention(path: string): void {
    if (!popover) return
    const ta = textareaRef.current
    const cursor = ta?.selectionStart ?? value.length
    const before = value.slice(0, popover.tokenStart)
    const after = value.slice(cursor)
    const inserted = `@${path} `
    setValue(before + inserted + after)
    setPopover(null)
    const newCursor = before.length + inserted.length
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(newCursor, newCursor)
    })
  }

  function selectSlash(command: SlashCommand): void {
    if (!popover) return
    const ta = textareaRef.current
    const cursor = ta?.selectionStart ?? value.length
    const before = value.slice(0, popover.tokenStart)
    const after = value.slice(cursor)
    if (!command.run) {
      // A live, SDK-reported command Atelier has no special UI for (bug
      // #56) — do NOT swallow it. Dispatch it through as a REAL prompt turn,
      // exactly like typing it out in full and pressing Enter without ever
      // opening this popover (that's how the CLI/SDK's own local slash
      // commands / custom project commands execute server-side).
      const text = resolveSendText(before + command.cmd + after, largePastesRef.current).trim()
      largePastesRef.current = []
      setValue('')
      setPopover(null)
      onSend(text)
      requestAnimationFrame(() => ta?.focus())
      return
    }
    // Local Atelier action (/clear, /interrupt, /fork, /model): unlike the
    // static mock (which just inserts the command text), this must run a
    // real action — so the typed `/token` is removed rather than left
    // sitting in the composer as literal text to send, and it NEVER reaches
    // `onSend`/`session:sendMessage`.
    setValue(before + after)
    setPopover(null)
    command.run()
    requestAnimationFrame(() => ta?.focus())
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    // 11-composer-mode-indicator: checked BEFORE the mention/slash-popover
    // Tab-select branch below (deliberately, not merely "happens to run
    // first") so Shift+Tab always cycles the mode, even while a popover
    // happens to be open — never falls through to select a popover match.
    // Bare Tab (no shift) is completely untouched by this branch, so the
    // existing Tab-to-select-popover behavior/tests below are unaffected.
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      onCycleMode()
      return
    }

    if (
      e.key === 'Tab' &&
      !e.shiftKey &&
      !popover &&
      value.trim() === '' &&
      promptSuggestion
    ) {
      e.preventDefault()
      setValue(promptSuggestion)
      const ta = textareaRef.current
      if (ta) {
        ta.focus()
        const end = promptSuggestion.length
        ta.setSelectionRange(end, end)
      }
      return
    }

    if (popover && activeMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, activeMatches.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const picked = activeMatches[selectedIndex]
        if (popover.kind === 'mention') selectMention(picked as string)
        else selectSlash(picked as SlashCommand)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setPopover(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
      return
    }

    if (handleEmacsTextareaKeyDown(e, value, setValue)) return
  }

  const displayBranch =
    branch ?? (worktreePath && sessionId ? sessionWorktreeBranch(sessionId) : null)
  const worktreeTitle =
    worktreePath && displayBranch
      ? `Worktree: ${worktreePath}\nBranch: ${displayBranch}`
      : worktreePath ?? undefined
  const hasSendableContent = Boolean(
    buildComposerSendText(value, reviewComments).trim() ||
    attachedFiles.length > 0 ||
    pendingAppNotes.length > 0
  )

  const renderPrimaryActions = (placement: 'inline' | 'footer'): JSX.Element => (
    <div
      className={`composer-primary-actions${placement === 'inline' ? ' composer-primary-actions--inline' : ''}`}
      data-testid="composer-primary-actions"
      data-placement={placement}
    >
      {sessionMode !== 'cortana' && sessionMode !== 'minion' && (
        <ModelPicker
          selection={modelSelection}
          onChange={onModelSelectionChange}
          open={modelPickerOpen}
          onOpenChange={setModelPickerOpen}
          liveModels={liveModels}
        />
      )}
      {busy && !hasSendableContent ? (
        <button
          className="stop-btn composer-turn-action-active"
          data-testid="stop-button"
          type="button"
          title="Stop"
          aria-label="Stop"
          onClick={onInterrupt}
        >
          <svg className="icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />
          </svg>
        </button>
      ) : (
        <button
          className={`send-btn${busy && sessionMode !== 'minion' ? ' composer-turn-action-active' : ''}`}
          data-testid="send-button"
          type="button"
          disabled={harnessDisconnected || rateLimit?.sendBlocked || !hasSendableContent}
          title={busy && sessionMode !== 'minion' ? 'Queue (Enter)' : 'Send (Enter)'}
          aria-label={busy && sessionMode !== 'minion' ? 'Queue' : 'Send'}
          onClick={() => void handleSend()}
        >
          <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="6 11 12 5 18 11" />
          </svg>
        </button>
      )}
    </div>
  )

  // Prefer short title ("Working…"); only show detail when it is a short tool
  // label — never paint answer-length latest_update prose above the composer.
  const minionWorkingText = (() => {
    if (sdkChrome?.status !== 'minion_working') return ''
    const title = sdkChrome.title?.trim() || 'Working…'
    const detail = sdkChrome.detail?.trim() || ''
    if (detail && detail.length <= 80 && !/[.!?]\s/.test(detail)) return detail
    return title
  })()

  return (
    <div className="composer-wrap">
      <div className="composer-stack">
      {minionWorkingText ? (
        <div className="composer-turn-status" data-testid="composer-turn-status">
          {minionWorkingText}
        </div>
      ) : null}
      <div
        className={`composer-box${inputMultiline ? ' composer-box--multiline' : ''}${isDragOver ? ' drag-over' : ''}${harnessDisconnected ? ' harness-disconnected' : ''}`}
        data-testid={harnessDisconnected ? 'composer-harness-disconnected' : undefined}
        data-working={busy && !harnessDisconnected ? 'true' : 'false'}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="context-bar" data-testid="composer-context-bar">
          {sessionMode !== 'cortana' && sessionMode !== 'minion' && (
            <span
              className={`mode-pill mode-${mode} context-bar-mode`}
              data-testid="composer-mode-pill"
              data-mode={mode}
              title="Click or press Shift+Tab to cycle mode"
              onClick={onCycleMode}
            >
              <span className="mode-icon">{MODE_ICON[mode]}</span>
              <span>{MODE_LABEL[mode]}</span>
            </span>
          )}
          {tokenUsage && tokenUsage.contextWindow > 0 && (() => {
            const pct = Math.min(100, Math.round((tokenUsage.inputTokens / tokenUsage.contextWindow) * 100))
            const usageTitle = `${tokenUsage.inputTokens.toLocaleString()} / ${tokenUsage.contextWindow.toLocaleString()} context tokens (${pct}%)`
            return (
              <span
                className={`context-usage-ring${pct >= 70 ? ' context-usage-high' : ''}`}
                data-testid="token-usage"
                data-context-percent={pct}
                title={usageTitle}
                role="img"
                aria-label={usageTitle}
              >
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle className="context-usage-track" cx="10" cy="10" r="7" />
                  <circle
                    className="context-usage-progress"
                    cx="10"
                    cy="10"
                    r="7"
                    pathLength="100"
                    strokeDasharray={`${pct} 100`}
                  />
                </svg>
              </span>
            )
          })()}
          <span className="context-bar-spacer" aria-hidden="true" />
          {displayBranch && (
            <span
              className={`context-bar-item context-bar-item--copyable${branchCopied ? ' context-bar-item--copied' : ''}`}
              data-testid="composer-context-branch"
              title={branchCopied ? 'Copied!' : `${displayBranch} — click to copy`}
              role="button"
              tabIndex={0}
              onClick={() => {
                void navigator.clipboard.writeText(displayBranch)
                setBranchCopied(true)
                setTimeout(() => setBranchCopied(false), 1500)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  void navigator.clipboard.writeText(displayBranch)
                  setBranchCopied(true)
                  setTimeout(() => setBranchCopied(false), 1500)
                }
              }}
            >
              {branchCopied ? (
                <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
              ) : CONTEXT_BRANCH_ICON}
              <span className="context-bar-value">{branchCopied ? 'Copied!' : displayBranch}</span>
            </span>
          )}
          {worktreePath && (
            <span
              className="context-bar-item context-bar-item--icon-only"
              data-testid="composer-worktree-indicator"
              title={worktreeTitle}
              role="img"
              aria-label="Worktree"
            >
              {CONTEXT_WORKTREE_ICON}
            </span>
          )}
          {gitWorkspacePath && onOpenChangedFile && onOpenBookmark && onRemoveBookmark && (
            <ChatUncommittedChanges
              items={sessionChangesCap?.items}
              bookmarks={sessionBookmarks}
              workspaceRoot={gitWorkspacePath}
              onOpenFile={onOpenChangedFile}
              onOpenBookmark={onOpenBookmark}
              onRemoveBookmark={onRemoveBookmark}
            />
          )}
        </div>
        {sessionMode !== 'cortana' && sessionMode !== 'minion' && <div className="context-bar-divider" />}
        {popover?.kind === 'mention' && mentionMatches.length > 0 && (
          <div className="mention-popup" data-testid="mention-popover">
            {mentionMatches.map((path, idx) => {
              const name = path.split('/').pop() ?? path
              return (
                <div
                  key={path}
                  className={`mention-item${idx === selectedIndex ? ' selected' : ''}`}
                  data-testid="mention-item"
                  data-path={path}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onMouseDown={(e) => {
                    // mousedown (not click) so this fires before the
                    // textarea's blur would otherwise dismiss the popover.
                    e.preventDefault()
                    selectMention(path)
                  }}
                >
                  <span>{name}</span>
                  <span className="fpath">{path}</span>
                </div>
              )
            })}
          </div>
        )}
        {popover?.kind === 'slash' && slashMatches.length > 0 && (
          <div className="slash-popup" data-testid="slash-popover">
            {slashMatches.map((command, idx) => (
              <div
                key={command.cmd}
                className={`slash-item${idx === selectedIndex ? ' selected' : ''}`}
                data-testid="slash-item"
                data-command={command.cmd}
                onMouseEnter={() => setSelectedIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectSlash(command)
                }}
              >
                <span className="cmd">{command.cmd}</span>
                <span className="cmddesc">{command.desc}</span>
              </div>
            ))}
          </div>
        )}
        {(attachedFiles.length > 0 || pendingAppNotes.length > 0) && (
          <div className="attach-row" data-testid="composer-attach-row">
            {attachedFiles.map((file, i) => (
              file.previewUrl ? (
                <div key={i} className="attach-thumb" data-testid="composer-attach-thumb">
                  <img src={file.previewUrl} alt={file.name ?? 'Attached image'} data-testid="composer-attach-image" />
                  <span className="remove" data-testid="composer-attach-remove" onClick={() => setAttachedFiles((prev) => prev.filter((_, j) => j !== i))}>✕</span>
                </div>
              ) : (
                <div key={i} className="attach-thumb attach-thumb--file" data-testid="composer-attach-file" title={file.name}>
                  <span className="attach-file-icon" aria-hidden="true">
                    <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M6 2h8l4 4v16H6z" /><path d="M14 2v4h4" />
                    </svg>
                  </span>
                  <span className="attach-file-label">{file.name ?? file.mimeType}</span>
                  <span className="remove" data-testid="composer-attach-remove" onClick={() => setAttachedFiles((prev) => prev.filter((_, j) => j !== i))}>✕</span>
                </div>
              )
            ))}
            {pendingAppNotes.map((note) => (
              <div
                key={note.id}
                className="attach-thumb attach-thumb--note"
                data-testid="composer-attach-note"
                data-note-id={note.id}
                title={note.title}
              >
                <span className="attach-note-icon" aria-hidden="true">
                  <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 2h8l4 4v16H6z" />
                    <path d="M14 2v4h4" />
                  </svg>
                </span>
                <span className="attach-note-label">{note.title}</span>
                <span
                  className="remove"
                  data-testid="composer-attach-note-remove"
                  onClick={() => setPendingAppNotes((prev) => prev.filter((n) => n.id !== note.id))}
                >
                  ✕
                </span>
              </div>
            ))}
          </div>
        )}
        <ReviewComposerCommentList
          comments={reviewComments}
          onUpdateCommentBody={onUpdateReviewCommentBody ?? (() => undefined)}
          onDeleteComment={onDeleteReviewComment ?? (() => undefined)}
        />
        <div className="composer-input-stack">
          {value.length > 0 && (
            <ComposerMarkdownInput
              ref={markdownInputRef}
              value={value}
              selectionStart={textareaRef.current?.selectionStart ?? value.length}
              selectionEnd={textareaRef.current?.selectionEnd ?? value.length}
              scrollTop={textareaRef.current?.scrollTop ?? 0}
            />
          )}
          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            data-session-tab-shortcut="l"
            data-hint-exclude=""
            placeholder={
              harnessDisconnected
                ? 'Reconnect to continue chatting…'
                : value.trim() === '' && promptSuggestion
                  ? promptSuggestion
                  : 'Message Atelier…'
            }
            className={value.trim() === '' && promptSuggestion ? 'composer-input-has-suggestion' : undefined}
            rows={1}
            value={value}
            readOnly={harnessDisconnected}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onKeyUp={onTextareaKeyActivity}
            onSelect={syncPopoverFromTextarea}
            onScroll={scheduleCursorUpdate}
            onClick={() => {
              scheduleCursorUpdate()
              syncPopoverFromTextarea()
            }}
            onFocus={onTextareaFocus}
            onBlur={onTextareaBlur}
            onPaste={handlePaste}
          />
          {!inputMultiline && renderPrimaryActions('inline')}
        </div>
        {cursorPos && (cursorPhase !== 'unfocused' || value.length > 0) && (
          <span
            aria-hidden="true"
            className={`composer-cursor cursor-${cursorPhase}`}
            style={{ top: cursorPos.top, left: cursorPos.left, height: cursorPos.height }}
          />
        )}
        {queuedMessages.length > 0 && (
          <div className="queued-strips-list">
            {queuedMessages.map((msg, idx) => (
          <div key={idx} className="queued-strip" data-testid="queued-strip">
            <span className="queued-strip-label">
              {queuedMessages.length === 1 ? 'Queued' : `Queued ×${queuedMessages.length}`}
            </span>
            <span className="queued-strip-text">{msg}</span>
            <button
              className="queued-strip-cancel"
              data-testid="queued-strip-cancel"
              title="Cancel queued message"
              onClick={() => onCancelQueued?.(idx)}
            >
              ✕
            </button>
          </div>
            ))}
          </div>
        )}
        <div className="composer-footer">
          {rateLimit?.warnLabel && (
            <span className="composer-status-chip warn" data-testid="composer-rate-limit-chip">
              {rateLimit.warnLabel}
            </span>
          )}
          {rateLimit?.sendBlocked && (
            <span className="composer-status-chip danger" data-testid="composer-send-blocked-chip">
              Send blocked
            </span>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/*,.ts,.tsx,.js,.jsx,.py,.json,.sh,.bash,.yaml,.yml,.go,.rs,.rb,.java,.c,.cpp,.h,.swift,.kt,.php,.r,.sql,.md,.toml,.xml,.css,.html"
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files?.length) {
                void attachFiles(Array.from(e.target.files))
                e.target.value = ''
              }
            }}
          />
          <button
            type="button"
            className="btn-icon composer-attach-btn"
            data-testid="composer-attach-btn"
            title="Attach files"
            onClick={() => fileInputRef.current?.click()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
          </button>
          <div className="spacer" />
          {inputMultiline && renderPrimaryActions('footer')}
        </div>
      </div>
      </div>
    </div>
  )
})
