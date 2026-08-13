import { useState } from 'react'
import type { AskUserQuestionContent } from '../../../../shared/chat-content'
import type { PromptDecision } from '../../../../shared/session-types'
import ResolvedPromptFold from './ResolvedPromptFold'
import { askUserFoldSummary } from './resolved-prompt-fold'
import { handleEmacsTextareaKeyDown } from '../../palette-input-keys'

/**
 * AskUserQuestion card (05-interactive-prompts) — a REAL clickable card:
 * clicking an option sends the SDK's expected `answers` shape back through
 * `onRespond`. Resolved cards fold into the tool-sequence summary when
 * embedded in an activity run; standalone cards keep their own fold row.
 */
export default function AskUserQuestionCard({
  content,
  onRespond,
  embedded = false
}: {
  content: AskUserQuestionContent
  onRespond: (decision: PromptDecision) => void
  embedded?: boolean
}): JSX.Element {
  const answered = content.status === 'answered'
  const expired = content.status === 'expired'
  const resolved = content.status !== 'pending'
  const [open, setOpen] = useState(false)
  const [otherOpenFor, setOtherOpenFor] = useState<number | null>(null)
  const [otherText, setOtherText] = useState('')
  const [picked, setPicked] = useState<Record<number, string>>({})

  function submit(nextPicked: Record<number, string>): void {
    const answers: Record<string, string> = {}
    content.questions.forEach((q, i) => {
      if (nextPicked[i] !== undefined) answers[q.question] = nextPicked[i]
    })
    onRespond({ kind: 'ask_user_question', answers })
  }

  function pickOption(qIndex: number, label: string): void {
    if (resolved) return
    setPicked((prev) => ({ ...prev, [qIndex]: label }))
  }

  function submitOther(qIndex: number): void {
    const text = otherText.trim()
    if (!text) return
    onRespond({ kind: 'ask_user_question', answers: { [content.questions[qIndex].question]: text }, freeText: text })
    setOtherOpenFor(null)
    setOtherText('')
  }

  const selectedAnswer = (q: AskUserQuestionContent['questions'][number]): string | undefined =>
    answered ? content.answers?.[q.question] : undefined

  const allPicked = content.questions.every((_, i) => picked[i] !== undefined)

  const questionBody = (
    <>
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
              {!resolved ? (
                <div
                  className="aq-option aq-other"
                  data-testid="aq-option-other"
                  onClick={() => setOtherOpenFor(qIndex)}
                >
                  <div className="num">{q.options.length + 1}</div>
                  <div>Other — type your own answer</div>
                </div>
              ) : null}
            </div>
            {!resolved ? (
              <div className={`aq-other-box${otherOpenFor === qIndex ? ' show' : ''}`} data-testid="aq-other-box">
                <textarea
                  data-testid="aq-other-input"
                  rows={2}
                  placeholder="Type your answer…"
                  value={otherText}
                  onChange={(e) => setOtherText(e.target.value)}
                  onKeyDown={(e) => {
                    handleEmacsTextareaKeyDown(e, otherText, setOtherText)
                  }}
                />
                <button className="btn btn-primary btn-sm" data-testid="aq-other-send" onClick={() => submitOther(qIndex)}>
                  Send
                </button>
              </div>
            ) : null}
          </div>
        )
      })}
      {!resolved && (
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
      ) : !resolved ? (
        <div className="aq-footer-hint">You can also just type a reply in the composer below instead of picking an option.</div>
      ) : null}
    </>
  )

  const resolvedBody = (
    <div className="aq-card answered resolved open" data-testid="ask-user-question-card" data-status={content.status}>
      <div className="aq-head">
        <span aria-hidden="true">?</span> Claude is asking a question
      </div>
      <div className="aq-body">{questionBody}</div>
    </div>
  )

  if (resolved) {
    if (embedded) return resolvedBody
    return (
      <ResolvedPromptFold
        testId="ask-user-question-card"
        summaryTestId="aq-resolved-summary"
        summary={askUserFoldSummary(content)}
        open={open}
        onToggle={() => setOpen((v) => !v)}
        status={content.status}
      >
        {resolvedBody}
      </ResolvedPromptFold>
    )
  }

  return (
    <div className="aq-card" data-testid="ask-user-question-card" data-status={content.status}>
      <div className="aq-head">
        <span aria-hidden="true">?</span> Claude is asking a question
      </div>
      <div className="aq-body">{questionBody}</div>
    </div>
  )
}
