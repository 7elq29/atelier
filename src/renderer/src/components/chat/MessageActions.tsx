import { Fragment, useState } from 'react'
import ReviewPaneIconButton from './ReviewPaneIconButton'

/**
 * Per-message hover actions (10d-enrichment-message-actions): Copy always,
 * Speak (Web Speech API) only where the caller passes `speakable` — i.e.
 * plain assistant text, not raw tool JSON. Markup/classes (`.msg-actions`,
 * `.icon-copy`/`.icon-speaker` paths) copied verbatim from mocks/index.html's
 * `#icon-copy`/`#icon-speaker` symbols and `copyMessage`/`speakMessage`
 * handlers, adapted to the renderer's clipboard/speechSynthesis APIs instead
 * of the mock's static-page stand-ins.
 */
export default function MessageActions({
  text,
  speakable,
  onReview,
  reviewActive
}: {
  text: string
  speakable?: boolean
  onReview?: () => void
  reviewActive?: boolean
}): JSX.Element {
  const [speaking, setSpeaking] = useState(false)

  function handleCopy(): void {
    void navigator.clipboard.writeText(text)
  }

  function handleSpeak(): void {
    if (speaking) {
      window.speechSynthesis.cancel()
      setSpeaking(false)
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.onstart = () => setSpeaking(true)
    utterance.onend = () => setSpeaking(false)
    utterance.onerror = () => setSpeaking(false)
    window.speechSynthesis.speak(utterance)
  }

  return (
    <Fragment>
      <div className="msg-actions" data-testid="msg-actions">
        <button title="Copy" data-testid="msg-copy-button" onClick={handleCopy}>
          <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        </button>
        {onReview ? (
          <ReviewPaneIconButton
            title="Review response"
            testId="msg-review-button"
            active={reviewActive}
            onClick={onReview}
          />
        ) : null}
        {speakable && (
          <button title="Speak" data-testid="msg-speak-button" onClick={handleSpeak}>
            <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 9h4l5-4v14l-5-4H4z" />
              <path d="M16 9.5a3 3 0 0 1 0 5" />
            </svg>
          </button>
        )}
      </div>
      {speaking && (
        <div className="speaking-indicator" data-testid="msg-speaking-indicator">
          <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 9h4l5-4v14l-5-4H4z" />
            <path d="M16 9.5a3 3 0 0 1 0 5" />
          </svg>
          Speaking…
        </div>
      )}
    </Fragment>
  )
}
