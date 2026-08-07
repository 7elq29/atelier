import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import ChatUncommittedChanges from './ChatUncommittedChanges'
import type { DiffSummary } from '../../../../shared/panel-types'
import type { ImageAttachment, ModelSelection, ModelValidationResult, PermissionModeValue, SlashCommandInfo } from '../../../../shared/session-types'

/** Cap in px for the textarea's auto-grow, per mocks/index.html's `.composer-box textarea { max-height: 160px }`. */
const MAX_TEXTAREA_HEIGHT = 160

/**
 * Formats a token count as a short human-readable string.
 * 285000 → "285k", 1200000 → "1.2M", 999 → "999".
 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}

/**
 * Renders a 20-char block-character progress bar.
 * pct=71 → "██████████████░░░░░░" (14 filled + 6 empty).
 */
function tokenBar(pct: number): string {
  const TOTAL = 20
  const filled = Math.round((Math.min(100, pct) / 100) * TOTAL)
  return '█'.repeat(filled) + '░'.repeat(TOTAL - filled)
}

/** Cap on how many `@file` matches are rendered at once — the underlying file walk is already capped (files.ts's MAX_ENTRIES), this just keeps the popover itself short and scannable. */
const MAX_MENTION_MATCHES = 20

/**
 * Icon + label per permission mode (11-composer-mode-indicator), quoted
 * verbatim from mocks/index.html's `composer-mode-row` markup — same glyphs,
 * same copy, same cycle order as `MODE_CYCLE` in `main/sessions/manager.ts`.
 */
const MODE_ICON: Record<PermissionModeValue, string> = {
  default: '●',
  plan: '⏸',
  acceptEdits: '⏵⏵',
  auto: '⚡'
}
const MODE_LABEL: Record<PermissionModeValue, string> = {
  default: 'Default',
  plan: 'Plan mode',
  acceptEdits: 'Accept edits',
  auto: 'Auto'
}

/**
 * Model/effort options for the picker (10f-enrichment-model-effort-picker),
 * re-derived (bug #53) from the installed
 * `@anthropic-ai/claude-agent-sdk@0.3.212` package's OWN hand-maintained
 * model catalog — the literal object in `sdk.mjs` whose own inline comment
 * reads "Hand-maintained baked-in model catalog — the source of truth for
 * per-model provider IDs and metadata" — not the previous 3-entry snapshot,
 * and NOT the unverified aifx `/model` screenshot this task started from
 * (that screenshot's "Opus 5" does not correspond to any id anywhere in the
 * catalog; grepping the whole file for it turns up nothing, so it's treated
 * as unreliable rather than a ground truth to chase). Per-model facts, all
 * read directly out of that catalog object:
 *   - claude-opus-4-8:   display_name "Opus 4.8",   family "opus",   the
 *     catalog's own `aliases.opus.default` / `latest_per_family.opus`.
 *   - claude-sonnet-5:   display_name "Sonnet 5",   family "sonnet", the
 *     catalog's own `aliases.sonnet.default` / `latest_per_family.sonnet`.
 *     Its `context` is already `{ window: 1e6, native_1m: true, ... }` —
 *     natively 1M, not a toggle — so there is no separate "Sonnet 5 (1M
 *     context)" id/entry to add; the aifx screenshot's extra row for that
 *     doesn't map onto anything the catalog or `HarnessStartOptions`
 *     (main/harness/types.ts) exposes (no context-window field there at
 *     all), so it's left out rather than invented.
 *   - claude-haiku-4-5:  display_name "Haiku 4.5",  family "haiku",  the
 *     catalog's own `aliases.haiku.default` / `latest_per_family.haiku`.
 *   - claude-fable-5:    display_name "Fable 5",    family "fable",  the
 *     catalog's own `aliases.fable.default` / `latest_per_family.fable` —
 *     and the catalog's own top-level `best: "fable"` flag, i.e. the SDK
 *     considers this (not opus) its single best model overall.
 *   - claude-mythos-5:   display_name "Mythos 5",   family "mythos". Present
 *     in `models[]` with a real 1M-native context block but absent from
 *     `aliases`/`latest_per_family` (no `mythos:` entry in either) — i.e. it
 *     has no short alias, but it's still a real, resolvable id the catalog
 *     lists, not a legacy/removed one. Included because it's exactly the
 *     other family the picker was previously and silently omitting (see the
 *     pre-existing `e2e/bug-model-picker-option-list.spec.ts`, whose
 *     baseline assertions this fix is a deliberate diff against).
 * Every other id families/generations that appear in the same catalog
 * (claude-3-5-haiku, claude-3-5-sonnet, claude-3-7-sonnet, claude-sonnet-4-0/
 * -4-5/-4-6, claude-opus-4-0/-4-1/-4-5/-4-6/-4-7) are deliberately left out:
 * they're older generations within a family already represented by its own
 * `latest_per_family` entry above, not distinct current options a picker
 * needs to surface. This is still a hand-picked-at-fix-time snapshot (see
 * this file's `slashCommands`/bug #56 for the live-registry alternative
 * pattern) rather than a live catalog fetch — the SDK does expose a live
 * alternative here too (`supportedModels(): Promise<ModelInfo[]>` /
 * `SDKControlInitializeResponse.models`, sdk.d.ts ~1193/~3398), but wiring
 * that through the harness was scoped OUT of this fix (unlike bug #56's
 * slash commands) since the task's own ground truth explicitly frames this
 * one as "update MODEL_OPTIONS to the verified real set", not as a live-list
 * migration — left as a natural follow-up given the plumbing bug #56 adds is
 * directly reusable for it.
 */
const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-mythos-5', label: 'Mythos 5' }
]

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

/** Fallback label only reached if `modelSelection` is ever `null` (defensive — `App.tsx` now always initializes it to Sonnet 5 · High, the app's real default, so this normally never renders). */
const DEFAULT_LABEL = 'Sonnet 5 · High'

function labelFor(selection: ModelSelection | null): string {
  if (!selection) return DEFAULT_LABEL
  const modelLabel = MODEL_OPTIONS.find((m) => m.id === selection.model)?.label ?? selection.model ?? MODEL_OPTIONS[0].label
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
  onOpenChange
}: {
  selection: ModelSelection | null
  onChange: (selection: ModelSelection) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const currentModel = selection?.model ?? MODEL_OPTIONS[0].id
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
        {labelFor(selection)} ▾
      </button>
      {open && (
        <div className="picker-pop" data-testid="model-picker-popover">
          <div className="label-caps" style={{ padding: '4px 8px' }}>Model</div>
          {MODEL_OPTIONS.map((opt) => (
            <div
              key={opt.id}
              className={'picker-item' + (opt.id === currentModel ? ' sel' : '')}
              data-testid={`model-option-${opt.id}`}
              onClick={() => {
                pickModel(opt.id)
                onOpenChange(false)
              }}
            >
              {opt.label}
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

/** The only mime types the Anthropic Messages API's image content block accepts — see `ImageAttachment` in shared/session-types.ts. */
const ACCEPTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

interface AttachedImage extends ImageAttachment {
  /** `data:<mime>;base64,<data>` — the same bytes as `data`, kept around only so the thumbnail's `<img src>` doesn't need to re-derive it. */
  previewUrl: string
}

export interface ComposerHandle {
  setValue(text: string): void
  getValue(): string
}

interface ComposerProps {
  onSend: (text: string, image?: ImageAttachment) => void
  onInterrupt: () => void
  /** True while a turn is in flight for the active session — shows Stop alongside Send, per e2e-test-plan.md/spec.md. */
  busy: boolean
  /** Active session's project root — `@file` mentions are resolved (real, live `fs` walk via the existing Files-panel IPC) against this. Undefined/empty just disables the mention popover. */
  projectPath?: string
  /** Worktree path if the session runs inside a git worktree, else null. Shown as an icon-only indicator in the context bar (full path in `title`). */
  worktreePath?: string | null
  /** Hostname for remote sessions — forwarded to the branch IPC call. */
  hostname?: string | null
  /** Git cwd (`worktreePath ?? projectPath`) — drives the uncommitted-changes cap above the composer. */
  gitWorkspacePath?: string
  /** Preloaded diff summary for the changes cap (main workspace service). */
  diffSummary?: DiffSummary | null
  /** Preloaded workspace file paths for @-mentions (relative paths). */
  mentionFilePaths?: string[]
  /** Chat changes cap: open Diff › Changes for this repo-relative path. */
  onOpenChangedFile?: (path: string) => void
  /** `/fork` slash command's real action: forks the active session (same as the sidebar's fork action). */
  onFork: () => void
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
  /** Current SDK permission mode for the active session (11-composer-mode-indicator) — always defined, defaulting to 'default' for a session that's never been cycled. */
  mode: PermissionModeValue
  /** Fired on Shift+Tab (composer focused) or a click on the mode pill — cycles default -> plan -> acceptEdits -> auto -> default via a real IPC round-trip to SessionManager.cycleMode. */
  onCycleMode: () => void
  /** Messages queued while the session was busy (message-queue). Rendered as `.queued-strip` rows inside `.composer-box`. Empty when idle or no queue. */
  queuedMessages?: string[]
  /** Cancels the queued message at `index` (0-based). Wired to the ✕ button in each `.queued-strip` row. */
  onCancelQueued?: (index: number) => void
  /**
   * Current context-window token usage for this session (token-usage-indicator).
   * Undefined until the session's first turn completes (no display until data is
   * available). `inputTokens` is cumulative for the live connection; `contextWindow`
   * is the model's declared context size.
   */
  tokenUsage?: { inputTokens: number; contextWindow: number }
  /** Appends a renderer-only system message to the active session's transcript, no SDK round-trip — used to surface an unknown `/model <id>` inline in the chat panel. */
  onAddLocalMessage: (content: string) => void
  /** Validates a `/model <id>` against the SDK's own live acceptance logic (calls `Query.setModel()` on the connected session), fetched on demand at the moment `/model <id>` is submitted — not a static list, since the backend silently substitutes the default model for an unrecognized id instead of erroring on it (the only reason `setModel()`'s real accept/reject signal is trustworthy here). */
  onValidateModel: (model: string) => Promise<ModelValidationResult>
  /** True when the harness is not connected (session-startup-idle) — composer is read-only until Reconnect. */
  harnessDisconnected?: boolean
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

/**
 * Reads a File/Blob into a `data:` URL via FileReader (10g-enrichment-image-attachment)
 * — simpler than `arrayBuffer()` + manual base64 encoding, and the result
 * already carries the mime type in the `data:<mime>;base64,` prefix, which
 * `readAttachedImage` below splits back apart.
 */
function readAsDataUrl(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(file)
  })
}

/** Returns null for anything that isn't an image the SDK's image content block actually accepts (see ACCEPTED_IMAGE_MIME_TYPES). */
async function readAttachedImage(file: File | Blob): Promise<AttachedImage | null> {
  if (!ACCEPTED_IMAGE_MIME_TYPES.has(file.type)) return null
  const previewUrl = await readAsDataUrl(file)
  const commaIndex = previewUrl.indexOf(',')
  if (commaIndex === -1) return null
  return {
    mimeType: file.type as AttachedImage['mimeType'],
    data: previewUrl.slice(commaIndex + 1),
    previewUrl,
  }
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
 *       - `/clear`     — clears the composer (same as selecting-all + delete)
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
 * Sending while `busy` is intentionally NOT held back client-side: per
 * spec.md/e2e-test-plan.md this must inject live into the still-streaming
 * turn (`SessionManager.sendUserMessage` -> `harness.streamInput()` on the
 * turn's still-open input queue, verified for real against the SDK — see
 * that function's doc comment), not queue-and-wait. The mock's own
 * `sendMessage()` shows a "queued — will be delivered..." card while
 * working; that's superseded here by the real live-injection behavior this
 * task requires, so a follow-up sent while busy renders as an ordinary
 * message immediately, just like an idle send. The Send button itself is
 * hidden while busy (matching the mock's `setWorking()` toggle exactly),
 * but Enter still submits — same as the mock's `onComposerKeydown`, which
 * calls `sendMessage()` unconditionally regardless of working state.
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
/** Calculates the pixel position of the caret within a textarea using the
 *  mirror-div technique: clones the textarea's styles into a hidden div,
 *  inserts a marker span at `position`, and reads its offset coordinates.
 *  Returns coordinates relative to the textarea element's top-left corner
 *  (including its own padding), adjusted for the current scroll position. */
function getCaretCoordinates(ta: HTMLTextAreaElement, position: number): { top: number; left: number } {
  const PROPS = ['borderBottomWidth','borderLeftWidth','borderRightWidth','borderTopWidth',
    'boxSizing','fontFamily','fontSize','fontStyle','fontVariant','fontWeight',
    'letterSpacing','lineHeight','paddingBottom','paddingLeft','paddingRight','paddingTop',
    'textIndent','textRendering','textTransform','width','wordSpacing','overflowWrap','wordWrap']
  const div = document.createElement('div')
  const cs = window.getComputedStyle(ta)
  PROPS.forEach((p) => { (div.style as unknown as Record<string, string>)[p] = (cs as unknown as Record<string, string>)[p] })
  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.overflow = 'hidden'
  div.style.top = '0'
  div.style.left = '0'
  document.body.appendChild(div)
  div.textContent = ta.value.slice(0, position)
  const marker = document.createElement('span')
  marker.textContent = '​'
  div.appendChild(marker)
  const top = marker.offsetTop - ta.scrollTop
  const left = marker.offsetLeft
  document.body.removeChild(div)
  return { top, left }
}

export default forwardRef<ComposerHandle, ComposerProps>(function Composer({
  onSend,
  onInterrupt,
  busy,
  projectPath,
  worktreePath,
  hostname,
  gitWorkspacePath,
  diffSummary,
  mentionFilePaths,
  onOpenChangedFile,
  onFork,
  modelSelection,
  onModelSelectionChange,
  liveSlashCommands,
  mode,
  onCycleMode,
  queuedMessages = [],
  onCancelQueued,
  tokenUsage,
  onAddLocalMessage,
  onValidateModel,
  harnessDisconnected = false
}: ComposerProps, ref): JSX.Element {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [popover, setPopover] = useState<PopoverState>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [branch, setBranch] = useState<string | null>(null)
  const [fileList, setFileList] = useState<string[]>([])
  const [attachedImage, setAttachedImage] = useState<AttachedImage | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  // `/model`'s target — lifted out of ModelPicker itself (bug #56) so typing
  // the full command and pressing Enter/Tab, or clicking its slash-item, can
  // open the SAME real popover the footer button opens.
  const [modelPickerOpen, setModelPickerOpen] = useState(false)

  // Block cursor state
  const [cursorPhase, setCursorPhase] = useState<'typing' | 'idle' | 'unfocused'>('unfocused')
  const [cursorPos, setCursorPos] = useState<{ top: number; left: number } | null>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateCursorPos = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    const coords = getCaretCoordinates(ta, ta.selectionStart ?? 0)
    // Add the textarea's own offset within .composer-box (its offsetParent).
    setCursorPos({ top: coords.top + ta.offsetTop, left: coords.left + ta.offsetLeft })
  }, [])

  const onTextareaFocus = useCallback(() => {
    setCursorPhase('idle')
    updateCursorPos()
  }, [updateCursorPos])

  const onTextareaBlur = useCallback(() => {
    if (typingTimer.current) clearTimeout(typingTimer.current)
    setCursorPhase('unfocused')
    updateCursorPos()
  }, [updateCursorPos])

  const onTextareaKeyActivity = useCallback(() => {
    setCursorPhase('typing')
    updateCursorPos()
    if (typingTimer.current) clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => setCursorPhase('idle'), 500)
  }, [updateCursorPos])

  // Keep cursor position in sync whenever value changes.
  useEffect(() => {
    updateCursorPos()
  }, [value, updateCursorPos])

  useImperativeHandle(ref, () => ({
    setValue,
    getValue: () => value,
  }), [value])

  // Fetch the current git branch for the context bar whenever the effective cwd changes.
  useEffect(() => {
    const cwd = worktreePath || projectPath
    if (!cwd) { setBranch(null); return }
    let cancelled = false
    window.atelier.gitBranch(cwd, hostname ?? null).then((b) => { if (!cancelled) setBranch(b) }).catch(() => { if (!cancelled) setBranch(null) })
    return () => { cancelled = true }
  }, [projectPath, worktreePath, hostname])

  // Real file list for @-mentions: from preloaded workspace when available.
  useEffect(() => {
    if (mentionFilePaths != null) {
      setFileList(mentionFilePaths)
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
      { cmd: '/clear', desc: 'Clear the composer', run: () => setValue('') },
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
  }, [onInterrupt, onFork, liveSlashCommands])


  // Auto-grow: mirrors mocks/index.html's onComposerInput exactly —
  // `height = 'auto'` first (so shrinking on delete works, not just
  // growing), then clamp to the 160px cap; beyond that the textarea's own
  // `overflow` (default for a textarea) scrolls instead of growing further.
  // `overflow-y` is set explicitly (not left to the CSS default `auto`)
  // because `scrollHeight` can exceed `clientHeight` by a stray sub-pixel
  // even when content fits on screen, which made the native scrollbar
  // flash in briefly with nothing to actually scroll to.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const cs = window.getComputedStyle(ta)
    const lineHeight = parseFloat(cs.lineHeight) || 22
    const verticalPad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const minContentHeight = lineHeight + verticalPad
    const capped = ta.scrollHeight > MAX_TEXTAREA_HEIGHT
    const next = Math.min(Math.max(ta.scrollHeight, minContentHeight), MAX_TEXTAREA_HEIGHT)
    ta.style.height = `${next}px`
    ta.style.overflowY = capped ? 'auto' : 'hidden'
  }, [value])

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

  async function handleSend(): Promise<void> {
    const text = value.trim()
    if (!text && !attachedImage) return
    // `/model <model-id>` validates against the SDK's own live acceptance
    // logic (calls `Query.setModel()` on the connected session and checks
    // whether it threw) rather than any static/curated list — verified for
    // real that the backend otherwise silently substitutes the default
    // model for an unrecognized id instead of erroring on it, so a static
    // list can't tell a typo from a legitimate uncurated override (e.g. an
    // older family deliberately left out of `MODEL_OPTIONS`, see its doc
    // comment). `setModel()`'s own error text is shown verbatim.
    if (text.startsWith('/model ')) {
      const arg = text.slice('/model '.length).trim()
      if (arg) {
        setValue('')
        const result = await onValidateModel(arg)
        if (!result.ok) {
          onAddLocalMessage(`Unknown model "${arg}": ${result.error}`)
          return
        }
        onModelSelectionChange({ model: arg, effort: modelSelection?.effort ?? 'high' })
        return
      }
    }
    onSend(text, attachedImage ? { mimeType: attachedImage.mimeType, data: attachedImage.data } : undefined)
    setValue('')
    setAttachedImage(null)
  }

  async function attachFile(file: File | null | undefined): Promise<void> {
    if (!file) return
    const image = await readAttachedImage(file)
    if (image) setAttachedImage(image)
  }

  function handleDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    setIsDragOver(true)
  }

  function handleDragLeave(): void {
    setIsDragOver(false)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    setIsDragOver(false)
    void attachFile(e.dataTransfer.files[0])
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const items = Array.from(e.clipboardData.items)
    const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'))
    if (!imageItem) return // ordinary text paste — let the default handler run
    e.preventDefault()
    void attachFile(imageItem.getAsFile())
  }

  /** Recomputes trigger state from the token immediately before the cursor — re-run on every keystroke, mirroring the mock's `onComposerInput`, but cursor-anchored rather than end-of-value-anchored so it still works if the user edits mid-string. */
  function updatePopoverFromCursor(text: string, cursor: number): void {
    const before = text.slice(0, cursor)
    const tokenStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1
    const token = before.slice(tokenStart)

    if (token.startsWith('@')) {
      setPopover({ kind: 'mention', query: token.slice(1), tokenStart })
      setSelectedIndex(0)
      return
    }
    // Slash commands only trigger as the very first token of the composer
    // (mock's `val.trim() === lastWord` guard) — a `/` mid-sentence is just
    // a character, not a command.
    if (token.startsWith('/') && tokenStart === 0) {
      setPopover({ kind: 'slash', query: token.slice(1), tokenStart })
      setSelectedIndex(0)
      return
    }
    setPopover(null)
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    const text = e.target.value
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
      const text = (before + command.cmd + after).trim()
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
        // Stop propagation so the global App-level ESC handler doesn't
        // simultaneously trigger an interrupt while we're just closing
        // the popover — the two actions shouldn't fire together.
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

    // Readline/Emacs word-navigation and kill-line bindings.
    // These fire regardless of popover state (they're editing bindings, not
    // popover-navigation bindings) — the popover guard above only intercepts
    // ArrowUp/Down, Enter, Tab, and Escape.

    // opt+f: move cursor forward one word (skip non-\w, then skip \w)
    // Uses e.code (physical key) not e.key — macOS Option+F sends 'ƒ', not 'f'.
    if (e.altKey && e.code === 'KeyF') {
      e.preventDefault()
      const ta = e.target as HTMLTextAreaElement
      const cursor = ta.selectionStart
      let pos = cursor
      while (pos < value.length && !/\w/.test(value[pos])) pos++
      while (pos < value.length && /\w/.test(value[pos])) pos++
      requestAnimationFrame(() => ta.setSelectionRange(pos, pos))
      return
    }

    // opt+b: move cursor backward one word (skip non-\w backwards, then skip \w backwards)
    // Uses e.code (physical key) not e.key — macOS Option+B sends '∫', not 'b'.
    if (e.altKey && e.code === 'KeyB') {
      e.preventDefault()
      const ta = e.target as HTMLTextAreaElement
      const cursor = ta.selectionStart
      let pos = cursor
      while (pos > 0 && !/\w/.test(value[pos - 1])) pos--
      while (pos > 0 && /\w/.test(value[pos - 1])) pos--
      requestAnimationFrame(() => ta.setSelectionRange(pos, pos))
      return
    }

    // ctrl+k: kill from cursor to end of line (delete text from cursor to next
    // newline, or to end of value if there is no following newline)
    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault()
      const ta = e.target as HTMLTextAreaElement
      const cursor = ta.selectionStart
      const nextNewline = value.indexOf('\n', cursor)
      const killEnd = nextNewline === -1 ? value.length : nextNewline
      setValue(value.slice(0, cursor) + value.slice(killEnd))
      requestAnimationFrame(() => ta.setSelectionRange(cursor, cursor))
      return
    }
  }

  const displayPath = (() => {
    if (!projectPath) return null
    const parts = projectPath.replace(/^\/Users\/[^/]+/, '~').split('/').filter(Boolean)
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : `/${parts.join('/')}`
  })()
  const contextPathTitle = projectPath ? projectPath.replace(/^\/Users\/[^/]+/, '~') : undefined
  const worktreeTitle =
    worktreePath && branch
      ? `Worktree: ${worktreePath}\nBranch: ${branch}`
      : worktreePath
        ? `Worktree: ${worktreePath}`
        : null

  return (
    <div className="composer-wrap">
      <div className="composer-stack">
        {gitWorkspacePath && onOpenChangedFile && (
          <ChatUncommittedChanges
            diffSummary={diffSummary}
            onOpenFile={onOpenChangedFile}
          />
        )}
      <div
        className={`composer-box${isDragOver ? ' drag-over' : ''}${harnessDisconnected ? ' harness-disconnected' : ''}`}
        data-testid={harnessDisconnected ? 'composer-harness-disconnected' : undefined}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {(displayPath || branch || worktreePath) && (
          <>
            <div className="context-bar" data-testid="composer-context-bar">
              {displayPath && (
                <span className="context-bar-item" title={contextPathTitle}>
                  <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
                  {displayPath}
                </span>
              )}
              {branch && (
                <>
                  {displayPath && <span className="context-bar-sep">›</span>}
                  <span className="context-bar-item" title={branch}>
                    <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 7.2V16.8M6 9.5a6 6 0 0 0 6 6h4"/></svg>
                    {branch}
                  </span>
                </>
              )}
              {worktreePath && (
                <>
                  <span className="context-bar-spacer" aria-hidden />
                  <span
                    className="context-bar-item context-bar-item--icon-only"
                    data-testid="composer-worktree-indicator"
                    title={worktreeTitle ?? undefined}
                    role="img"
                    aria-label="Worktree"
                    onContextMenu={(e) => {
                      e.preventDefault()
                      void navigator.clipboard.writeText(worktreePath)
                    }}
                  >
                    <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d="M20 4C10 4 4 10 4 18v2h2c8 0 14-6 14-16z"/><path d="M9 19c3-5 6-8 11-11"/></svg>
                  </span>
                </>
              )}
            </div>
            <div className="context-bar-divider" />
          </>
        )}
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
        {attachedImage && (
          <div className="attach-row" data-testid="composer-attach-row">
            <div className="attach-thumb" data-testid="composer-attach-thumb">
              <img src={attachedImage.previewUrl} alt="Attached" data-testid="composer-attach-image" />
              <span
                className="remove"
                data-testid="composer-attach-remove"
                onClick={() => setAttachedImage(null)}
              >
                ✕
              </span>
            </div>
          </div>
        )}
        <textarea
          ref={textareaRef}
          data-testid="composer-input"
          placeholder={harnessDisconnected ? 'Reconnect to continue chatting…' : 'Message Atelier…'}
          rows={1}
          value={value}
          readOnly={harnessDisconnected}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={onTextareaKeyActivity}
          onClick={updateCursorPos}
          onFocus={onTextareaFocus}
          onBlur={onTextareaBlur}
          onPaste={handlePaste}
        />
        {cursorPos && (cursorPhase !== 'unfocused' || value.length > 0) && (
          <span
            aria-hidden="true"
            className={`composer-cursor cursor-${cursorPhase}`}
            style={{ top: cursorPos.top, left: cursorPos.left }}
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
          <span
            className={`mode-pill mode-${mode}`}
            data-testid="composer-mode-pill"
            data-mode={mode}
            title="Click or press Shift+Tab to cycle mode"
            onClick={onCycleMode}
          >
            <span className="mode-icon">{MODE_ICON[mode]}</span>
            <span>{MODE_LABEL[mode]}</span>
          </span>
          {tokenUsage && tokenUsage.contextWindow > 0 && (() => {
            const pct = Math.min(100, Math.round((tokenUsage.inputTokens / tokenUsage.contextWindow) * 100))
            return (
              <span
                className={`token-usage${pct >= 70 ? ' token-usage-high' : ''}`}
                data-testid="token-usage"
                title={`${tokenUsage.inputTokens.toLocaleString()} / ${tokenUsage.contextWindow.toLocaleString()} context tokens used`}
              >
                {formatTokens(tokenUsage.inputTokens)} [{tokenBar(pct)} {pct}%/{formatTokens(tokenUsage.contextWindow)}]
              </span>
            )
          })()}
          <div className="spacer" />
          {busy && (
            <span className="working-pill" data-testid="composer-working-pill">
              <span className="spinner" />
              Working…
            </span>
          )}
          <ModelPicker
            selection={modelSelection}
            onChange={onModelSelectionChange}
            open={modelPickerOpen}
            onOpenChange={setModelPickerOpen}
          />
          {busy ? (
            <button className="stop-btn" data-testid="stop-button" onClick={onInterrupt}>
              ⏹ Stop
            </button>
          ) : null}
          <button
            className="send-btn"
            data-testid="send-button"
            disabled={harnessDisconnected || (!value.trim() && !attachedImage)}
            title={busy ? 'Queue (Enter)' : 'Send (Enter)'}
            onClick={() => void handleSend()}
          >
            <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="6 11 12 5 18 11" />
            </svg>
            {busy ? 'Queue' : 'Send'}
          </button>
        </div>
      </div>
      </div>
    </div>
  )
})
