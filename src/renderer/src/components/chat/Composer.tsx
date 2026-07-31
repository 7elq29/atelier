import { useEffect, useRef, useState } from 'react'
import type { ModelSelection } from '../../../../shared/session-types'

/** Cap in px for the textarea's auto-grow, per mocks/index.html's `.composer-box textarea { max-height: 160px }`. */
const MAX_TEXTAREA_HEIGHT = 160

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

interface ComposerProps {
  value: string
  onChange: (text: string) => void
  onSend: (text: string) => void
  onInterrupt: () => void
  /** True while a turn is in flight for the active session — swaps Send for Stop, per e2e-test-plan.md/spec.md. */
  busy: boolean
  /** Current model/effort override (10f-enrichment-model-effort-picker); `null` until the user picks something, in which case no override is sent at all (harness default). */
  modelSelection: ModelSelection | null
  /** Fired the moment the user picks a new model/effort — applies starting with the NEXT `onSend`, never the in-flight turn. */
  onModelSelectionChange: (selection: ModelSelection) => void
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
export default function Composer({
  value,
  onChange,
  onSend,
  onInterrupt,
  busy,
  modelSelection,
  onModelSelectionChange
}: ComposerProps): JSX.Element {
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
          <ModelPicker selection={modelSelection} onChange={onModelSelectionChange} />
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
