import { useState } from 'react'
import type { AskUserQuestionContent } from '../../../../shared/chat-content'
import type { PromptDecision } from '../../../../shared/session-types'

/**
 * AskUserQuestion card (05-interactive-prompts) — a REAL clickable card:
 * clicking an option sends the SDK's expected `answers` shape
 * (`{ [questionText]: label }`) back through `onRespond`, which routes all
 * the way to the harness's blocked `canUseTool` call so the conversation
 * actually continues with that answer (fixing Playground's Bug #92, where
 * the card existed visually but wasn't wired to respond).
 *
 * Markup/classes copied verbatim from mocks/index.html's `.aq-card` block
 * (lines ~757-772): `.aq-head`, `.aq-body`, one `.aq-question`/`.aq-options`
 * group per question, an `.aq-option.aq-other` row revealing an
 * `.aq-other-box` textarea+Send for free text, and the `.aq-footer-hint`.
 * Only single-select is exercised by the real e2e run; multiSelect questions
 * still render (comma-joins picks) since the SDK's own `AskUserQuestionInput`
 * allows it.
 *
 * bug #52: clicking an option used to call `submit()` the instant every
 * question had a pick — for the common single-question case, the very first
 * click submitted, with no chance to reconsider. Picking now only updates
 * local `picked` state (shown via `.aq-option.selected`); an explicit
 * `aq-submit` button — disabled until every question has a pick, styled
 * like the existing `aq-other-send` button — performs the actual submit.
 */
export default function AskUserQuestionCard({
  content,
  onRespond
}: {
  content: AskUserQuestionContent
  onRespond: (decision: PromptDecision) => void
}): JSX.Element {
  const answered = content.status === 'answered'
  const expired = content.status === 'expired'
  const locked = content.status !== 'pending'
  const [otherOpenFor, setOtherOpenFor] = useState<number | null>(null)
  const [otherText, setOtherText] = useState('')
  // Answers picked so far this render (pre-submit), per question index.
  const [picked, setPicked] = useState<Record<number, string>>({})

  function submit(nextPicked: Record<number, string>): void {
    const answers: Record<string, string> = {}
    content.questions.forEach((q, i) => {
      if (nextPicked[i] !== undefined) answers[q.question] = nextPicked[i]
    })
    onRespond({ kind: 'ask_user_question', answers })
  }

  function pickOption(qIndex: number, label: string): void {
    if (locked) return
    // Only record the pick here — submission requires an explicit click on
    // the Submit button below, even once every question has an answer
    // (bug #52: clicking an option used to submit instantly with no chance
    // to change your mind).
    setPicked((prev) => ({ ...prev, [qIndex]: label }))
  }

  function submitOther(qIndex: number): void {
    const text = otherText.trim()
    if (!text) return
    // A free-text answer for one question still fills in placeholder labels
    // for any other not-yet-answered questions isn't attempted here — the
    // real e2e prompt always asks exactly one question, matching the mock.
    onRespond({ kind: 'ask_user_question', answers: { [content.questions[qIndex].question]: text }, freeText: text })
    setOtherOpenFor(null)
    setOtherText('')
  }

  const selectedAnswer = (q: AskUserQuestionContent['questions'][number]): string | undefined =>
    answered ? content.answers?.[q.question] : undefined

  const allPicked = content.questions.every((_, i) => picked[i] !== undefined)

  return (
    <div className={`aq-card${answered ? ' answered' : ''}`} data-testid="ask-user-question-card" data-status={content.status}>
      <div className="aq-head">
        <span aria-hidden="true">?</span> Claude is asking a question
      </div>
      <div className="aq-body">
        {content.questions.map((q, qIndex) => {
          const selected = selectedAnswer(q)
          const pendingPick = picked[qIndex]
          return (
            <div key={q.question} data-testid="aq-question-block">
              <div className="aq-question">{q.question}</div>
              <div className="aq-options" data-testid="aq-options">
                {q.options.map((opt, optIndex) => (
                  <div
                    key={opt.label}
                    className={`aq-option${selected === opt.label || pendingPick === opt.label ? ' selected' : ''}`}
                    data-testid="aq-option"
                    onClick={() => pickOption(qIndex, opt.label)}
                  >
                    <div className="num">{optIndex + 1}</div>
                    <div>
                      {opt.label}
                      <div className="desc">{opt.description}</div>
                    </div>
                  </div>
                ))}
                <div
                  className="aq-option aq-other"
                  data-testid="aq-option-other"
                  onClick={() => !locked && setOtherOpenFor(qIndex)}
                >
                  <div className="num">{q.options.length + 1}</div>
                  <div>Other — type your own answer</div>
                </div>
              </div>
              <div className={`aq-other-box${otherOpenFor === qIndex ? ' show' : ''}`} data-testid="aq-other-box">
                <textarea
                  data-testid="aq-other-input"
                  rows={2}
                  placeholder="Type your answer…"
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                />
                <button className="btn btn-primary btn-sm" data-testid="aq-other-send" onClick={() => submitOther(qIndex)}>
                  Send
                </button>
              </div>
            </div>
          )
        })}
        {!locked && (
          <button
            className="btn btn-primary aq-submit"
            data-testid="aq-submit"
            disabled={!allPicked}
            onClick={() => submit(picked)}
          >
            Submit
          </button>
        )}
        {expired ? (
          <div className="aq-footer-hint" data-testid="aq-expired-note">
            This request expired — the turn ended before you could respond.
          </div>
        ) : (
          <div className="aq-footer-hint">You can also just type a reply in the composer below instead of picking an option.</div>
        )}
      </div>
    </div>
  )
}
