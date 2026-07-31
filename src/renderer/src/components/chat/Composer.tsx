import { useEffect, useRef } from 'react'

/** Cap in px for the textarea's auto-grow, per mocks/index.html's `.composer-box textarea { max-height: 160px }`. */
const MAX_TEXTAREA_HEIGHT = 160

interface ComposerProps {
  value: string
  onChange: (text: string) => void
  onSend: (text: string) => void
  onInterrupt: () => void
  /** True while a turn is in flight for the active session — swaps Send for Stop, per e2e-test-plan.md/spec.md. */
  busy: boolean
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
 */
export default function Composer({ value, onChange, onSend, onInterrupt, busy }: ComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
    if (!text) return
    onSend(text)
  }

  return (
    <div className="composer-wrap">
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          data-testid="composer-input"
          placeholder="Message Gardenia…"
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
              disabled={!value.trim()}
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
