import { useEffect, useRef, useState } from 'react'
import type { ImageAttachment } from '../../../../shared/session-types'

/** Cap in px for the textarea's auto-grow, per mocks/index.html's `.composer-box textarea { max-height: 160px }`. */
const MAX_TEXTAREA_HEIGHT = 160

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
}

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
 * Composer core (04-composer-core): multi-line auto-grow textarea (Enter
 * sends, Shift+Enter inserts a newline), and a real Send/Stop pill that
 * swaps based on `busy`. Markup/classes match `mocks/index.html`'s
 * `.composer-wrap`/`.composer-box`/`.composer-footer`/`.send-btn`/
 * `.stop-btn` exactly (see spec.md's quoted CSS) — note the textarea and
 * footer are now SIBLINGS inside `.composer-box` (not a flex row), per the
 * most recently hand-tuned layout.
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
export default function Composer({ value, onChange, onSend, onInterrupt, busy }: ComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [attachedImage, setAttachedImage] = useState<AttachedImage | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)

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

  return (
    <div className="composer-wrap">
      <div
        className={`composer-box${isDragOver ? ' drag-over' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
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
          onChange={(e) => onChange(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSend()
            }
          }}
        />
        <div className="composer-footer">
          <div className="spacer" />
          {busy && (
            <span className="working-pill" data-testid="composer-working-pill">
              <span className="spinner" />
              Working…
            </span>
          )}
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
