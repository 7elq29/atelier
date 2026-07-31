import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { FileTreeNode } from '../../../../shared/panel-types'
import type { ImageAttachment, ModelSelection } from '../../../../shared/session-types'

/** Cap in px for the textarea's auto-grow, per mocks/index.html's `.composer-box textarea { max-height: 160px }`. */
const MAX_TEXTAREA_HEIGHT = 160

/** Cap on how many `@file` matches are rendered at once — the underlying file walk is already capped (files.ts's MAX_ENTRIES), this just keeps the popover itself short and scannable. */
const MAX_MENTION_MATCHES = 20

/**
 * Model/effort options for the picker (10f-enrichment-model-effort-picker).
 * Every id below is a REAL model identifier — verified directly against the
 * installed `@anthropic-ai/claude-agent-sdk@0.3.212` package (grepped out of
 * its bundled `sdk.mjs`: `claude-opus-4-8`, `claude-sonnet-5`,
 * `claude-haiku-4-5` all appear verbatim as resolvable model ids), not
 * invented — and each label matches mocks/index.html's own static picker
 * list (`togglePicker()`: "Opus 4.8" / "Sonnet 5" / "Haiku 4.5").
 */
const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' }
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

/** Purely cosmetic placeholder shown before the user ever touches the picker — matches mocks/index.html's own static default ("Opus 4.8 · High ▾"). Selecting nothing keeps `modelSelection` `null`, so no override is ever sent until the user actually picks something (see ModelPicker's doc comment). */
const DEFAULT_LABEL = 'Opus 4.8 · High'

function labelFor(selection: ModelSelection | null): string {
  if (!selection) return DEFAULT_LABEL
  const modelLabel = MODEL_OPTIONS.find((m) => m.id === selection.model)?.label ?? MODEL_OPTIONS[0].label
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
 */
function ModelPicker({
  selection,
  onChange
}: {
  selection: ModelSelection | null
  onChange: (selection: ModelSelection) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const currentModel = selection?.model ?? MODEL_OPTIONS[0].id
  const currentEffort = selection?.effort ?? EFFORT_OPTIONS[2].id

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(): void {
      setOpen(false)
    }
    document.addEventListener('click', handleOutsideClick)
    return () => document.removeEventListener('click', handleOutsideClick)
  }, [open])

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
        onClick={() => setOpen((v) => !v)}
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
                setOpen(false)
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
                setOpen(false)
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

interface ComposerProps {
  value: string
  onChange: (text: string) => void
  onSend: (text: string, image?: ImageAttachment) => void
  onInterrupt: () => void
  /** True while a turn is in flight for the active session — swaps Send for Stop, per e2e-test-plan.md/spec.md. */
  busy: boolean
  /** Active session's project root — `@file` mentions are resolved (real, live `fs` walk via the existing Files-panel IPC) against this. Undefined/empty just disables the mention popover. */
  projectPath?: string
  /** `/fork` slash command's real action: forks the active session (same as the sidebar's fork action). */
  onFork: () => void
  /** Current model/effort override (10f-enrichment-model-effort-picker); `null` until the user picks something, in which case no override is sent at all (harness default). */
  modelSelection: ModelSelection | null
  /** Fired the moment the user picks a new model/effort — applies starting with the NEXT `onSend`, never the in-flight turn. */
  onModelSelectionChange: (selection: ModelSelection) => void
}

/** Flattens the Files-panel's real `fs`-backed tree (07-secondary-panels) into a flat list of `relativePath`s, files only — dirs aren't mentionable. */
function flattenFiles(nodes: FileTreeNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'file') acc.push(node.relativePath)
    else if (node.children) flattenFiles(node.children, acc)
  }
  return acc
}

interface SlashCommand {
  cmd: string
  desc: string
  run: () => void
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
 * the whole input, not a token mid-sentence) and opens a small, fixed set of
 * REAL actions (not a plugin/registration framework, per spec: "don't
 * over-engineer"):
 *   - `/clear`     — clears the composer (same as selecting-all + delete)
 *   - `/interrupt` — stops the current in-flight turn (same real IPC as the Stop button)
 *   - `/fork`      — forks the active session (same real IPC as the sidebar's fork action)
 * Selecting a slash command removes the typed token from the composer and
 * actually runs the action — unlike the static mock (which just inserts the
 * command text), this must be a real action per spec.
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
export default function Composer({
  value,
  onChange,
  onSend,
  onInterrupt,
  busy,
  projectPath,
  onFork,
  modelSelection,
  onModelSelectionChange
}: ComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [popover, setPopover] = useState<PopoverState>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [fileList, setFileList] = useState<string[]>([])
  const [attachedImage, setAttachedImage] = useState<AttachedImage | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

  // Real file list for @-mentions: same IPC the Files panel (07) already
  // uses to walk the session's real project_path on disk — no fixture/fake
  // list, no second file-walking implementation.
  useEffect(() => {
    let cancelled = false
    if (!projectPath) {
      setFileList([])
      return undefined
    }
    window.gardenia.filesTree(projectPath).then((tree) => {
      if (!cancelled) setFileList(flattenFiles(tree))
    })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const slashCommands: SlashCommand[] = useMemo(
    () => [
      { cmd: '/clear', desc: 'Clear the composer', run: () => onChange('') },
      { cmd: '/interrupt', desc: 'Stop the current in-flight turn', run: () => onInterrupt() },
      { cmd: '/fork', desc: 'Fork this session into a new one', run: () => onFork() }
    ],
    [onChange, onInterrupt, onFork]
  )

  // Auto-grow: mirrors mocks/index.html's onComposerInput exactly —
  // `height = 'auto'` first (so shrinking on delete works, not just
  // growing), then clamp to the 160px cap; beyond that the textarea's own
  // `overflow` (default for a textarea) scrolls instead of growing further.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
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

  function handleSend(): void {
    const text = value.trim()
    if (!text && !attachedImage) return
    onSend(text, attachedImage ? { mimeType: attachedImage.mimeType, data: attachedImage.data } : undefined)
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
    onChange(text)
    updatePopoverFromCursor(text, e.target.selectionStart ?? text.length)
  }

  function selectMention(path: string): void {
    if (!popover) return
    const ta = textareaRef.current
    const cursor = ta?.selectionStart ?? value.length
    const before = value.slice(0, popover.tokenStart)
    const after = value.slice(cursor)
    const inserted = `@${path} `
    onChange(before + inserted + after)
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
    // Unlike the static mock (which just inserts the command text), this
    // must run a real action — so the typed `/token` is removed rather than
    // left sitting in the composer as literal text to send.
    onChange(before + after)
    setPopover(null)
    command.run()
    requestAnimationFrame(() => ta?.focus())
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
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
        setPopover(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="composer-wrap">
      <div
        className={`composer-box${isDragOver ? ' drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
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
          placeholder="Message Gardenia…"
          rows={1}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        <div className="composer-footer">
          <div className="spacer" />
          {busy && (
            <span className="working-pill" data-testid="composer-working-pill">
              <span className="spinner" />
              Working…
            </span>
          )}
          <ModelPicker selection={modelSelection} onChange={onModelSelectionChange} />
          {busy ? (
            <button className="stop-btn" data-testid="stop-button" onClick={onInterrupt}>
              ⏹ Stop
            </button>
          ) : (
            <button
              className="send-btn"
              data-testid="send-button"
              disabled={!value.trim() && !attachedImage}
              title="Send (Enter)"
              onClick={handleSend}
            >
              <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="6 11 12 5 18 11" />
              </svg>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
