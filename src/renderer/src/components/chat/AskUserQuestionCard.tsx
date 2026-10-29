import { useState } from 'react'
import type { AskUserQuestionContent } from '../../../../shared/chat-content'
import type { PromptDecision } from '../../../../shared/session-types'
import ResolvedPromptFold from './ResolvedPromptFold'
import { askUserFoldSummary } from './resolved-prompt-fold'
import { handleEmacsTextareaKeyDown } from '../../palette-input-keys'

/** Sentinel in `picked` when the user chose the "Other" row for a question. */
const OTHER_PICK = '__other__'

function stepLabel(header: string | undefined, index: number): string {
  const trimmed = header?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : `Q${index + 1}`
}

function isPickComplete(
  qIndex: number,
  picked: Record<number, string>,
  otherTextByQ: Record<number, string>
): boolean {
  const pick = picked[qIndex]
  if (pick === OTHER_PICK) return (otherTextByQ[qIndex] ?? '').trim().length > 0
  return pick !== undefined
}

/** Display name in the card head — Claude / Cortana / Minion (same card format). */
export type AskUserAskerName = 'Claude' | 'Cortana' | 'Minion'

/**
 * AskUserQuestion card (05-interactive-prompts) — a REAL clickable card:
 * clicking an option selects; Submit sends the SDK's expected `answers` shape
 * through `onRespond`. Same chrome for Claude / Cortana / Minion sessions.
 * Multi-question batches use a stepper; single-question cards show all options.
 * Resolved cards fold into the tool-sequence summary when embedded in a run.
 */

export default function AskUserQuestionCard({
  content,
  onRespond,
  embedded = false,
  askerName = 'Claude'
}: {
  content: AskUserQuestionContent
  onRespond: (decision: PromptDecision) => void
  embedded?: boolean
  askerName?: AskUserAskerName
}): JSX.Element {
  const answered = content.status === 'answered'
  const cancelled = content.status === 'cancelled'
  const expired = content.status === 'expired'
  const resolved = content.status !== 'pending'
  const questionCount = content.questions.length
  const useStepper = !resolved && questionCount > 1

  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)
  const [otherOpenFor, setOtherOpenFor] = useState<number | null>(null)
  const [otherTextByQ, setOtherTextByQ] = useState<Record<number, string>>({})
  const [picked, setPicked] = useState<Record<number, string>>({})

  function submit(nextPicked: Record<number, string>): void {
    const answers: Record<string, string> = {}
    let freeText: string | undefined
    content.questions.forEach((q, i) => {
      const pick = nextPicked[i]
      if (pick === OTHER_PICK) {
        const text = (otherTextByQ[i] ?? '').trim()
        answers[q.question] = text
        freeText = text
      } else if (pick !== undefined) {
        answers[q.question] = pick
      }
    })
    onRespond({ kind: 'ask_user_question', answers, freeText })
  }

  function advanceFromStep(qIndex: number): void {
    if (!useStepper || qIndex !== step || qIndex >= questionCount - 1) return
    setStep(qIndex + 1)
  }

  function pickOption(qIndex: number, label: string): void {
    if (resolved) return
    setOtherOpenFor((cur) => (cur === qIndex ? null : cur))
    setPicked((prev) => ({ ...prev, [qIndex]: label }))
    advanceFromStep(qIndex)
  }

  function pickOther(qIndex: number): void {
    if (resolved) return
    setOtherOpenFor(qIndex)
    setPicked((prev) => ({ ...prev, [qIndex]: OTHER_PICK }))
  }

  function cancelQuestion(): void {
    if (resolved) return
    onRespond({ kind: 'ask_user_question', cancelled: true })
  }

  function goToStep(idx: number): void {
    if (!useStepper || resolved) return
    if (idx > step && !isPickComplete(idx - 1, picked, otherTextByQ)) return
    setStep(idx)
  }

  const selectedAnswer = (q: AskUserQuestionContent['questions'][number]): string | undefined =>
    answered ? content.answers?.[q.question] : undefined

  const allPicked = content.questions.every((_, i) => isPickComplete(i, picked, otherTextByQ))
  const onLastStep = step === questionCount - 1
  const currentStepComplete = isPickComplete(step, picked, otherTextByQ)

  function renderQuestion(q: AskUserQuestionContent['questions'][number], qIndex: number): JSX.Element {
    const selected = selectedAnswer(q)
    const pendingPick = picked[qIndex]
    const otherSelected = pendingPick === OTHER_PICK || otherOpenFor === qIndex
    const otherText = otherTextByQ[qIndex] ?? ''
    const showThisQuestion = !useStepper || resolved || step === qIndex

    if (!showThisQuestion) return <div key={q.question} hidden aria-hidden="true" />

    return (
      <div
        key={q.question}
        className="aq-step-panel active"
        data-testid="aq-question-block"
        data-step={qIndex}
      >
        <div className="aq-question">{q.question}</div>
        <div className="aq-options" data-testid="aq-options">
          {q.options.map((opt, optIndex) => (
            <button
              type="button"
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
            </button>
          ))}
          {!resolved ? (
            <button
              type="button"
              className={`aq-option aq-other${otherSelected ? ' selected' : ''}`}
              data-testid="aq-option-other"
              onClick={() => pickOther(qIndex)}
            >
              <div className="num">{q.options.length + 1}</div>
              <div>Other — type your own answer</div>
            </button>
          ) : null}
        </div>
        {!resolved ? (
          <div className={`aq-other-box${otherOpenFor === qIndex ? ' show' : ''}`} data-testid="aq-other-box">
            <textarea
              data-testid="aq-other-input"
              rows={2}
              placeholder="Type your answer…"
              value={otherText}
              onChange={(e) => setOtherTextByQ((prev) => ({ ...prev, [qIndex]: e.target.value }))}
              onKeyDown={(e) => {
                handleEmacsTextareaKeyDown(e, otherText, (next) =>
                  setOtherTextByQ((prev) => ({ ...prev, [qIndex]: next }))
                )
              }}
            />
          </div>
        ) : null}
      </div>
    )
  }

  const stepperNav =
    useStepper && !resolved ? (
      <div className="aq-wizard-nav" data-testid="aq-wizard-nav">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          data-testid="aq-back"
          disabled={step === 0}
          onClick={() => setStep((s) => Math.max(0, s - 1))}
        >
          Back
        </button>
        <span className="aq-step-count" data-testid="aq-step-count">
          Question {step + 1} of {questionCount}
        </span>
        {!onLastStep ? (
          <button
            type="button"
            className="btn btn-sm aq-submit"
            data-testid="aq-next"
            disabled={!currentStepComplete}
            onClick={() => setStep((s) => Math.min(questionCount - 1, s + 1))}
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm aq-submit"
            data-testid="aq-submit"
            disabled={!allPicked}
            onClick={() => submit(picked)}
          >
            Submit
          </button>
        )}
      </div>
    ) : null

  const footerActions =
    !resolved && !useStepper ? (
      <div className="aq-actions" data-testid="aq-actions">
        <button
          type="button"
          className="btn btn-sm aq-submit"
          data-testid="aq-submit"
          disabled={!allPicked}
          onClick={() => submit(picked)}
        >
          Submit answer
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost aq-cancel"
          data-testid="aq-cancel"
          onClick={cancelQuestion}
        >
          Continue without answering
        </button>
      </div>
    ) : !resolved && useStepper ? (
      <div className="aq-actions" data-testid="aq-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost aq-cancel"
          data-testid="aq-cancel"
          onClick={cancelQuestion}
        >
          Continue without answering
        </button>
      </div>
    ) : null

  const questionBody = (
    <>
      {useStepper && !resolved ? (
        <div className="aq-stepper" data-testid="aq-stepper" aria-label="Question progress">
          {content.questions.map((q, i) => {
            const done = isPickComplete(i, picked, otherTextByQ)
            const cls = i === step ? 'active' : done ? 'done' : ''
            return (
              <button
                key={q.question}
                type="button"
                className={`aq-step ${cls}`.trim()}
                data-testid="aq-step"
                data-step={i}
                onClick={() => goToStep(i)}
              >
                <span className="aq-step-num">{i + 1}</span>
                <span>{stepLabel(q.header, i)}</span>
              </button>
            )
          })}
        </div>
      ) : null}
      {content.questions.map((q, qIndex) => renderQuestion(q, qIndex))}
      {stepperNav}
      {footerActions}
      {expired ? (
        <div className="aq-footer-hint" data-testid="aq-expired-note">
          This request expired — the turn ended before you could respond.
        </div>
      ) : cancelled ? (
        <div className="aq-footer-hint" data-testid="aq-cancelled-note">
          Skipped — {askerName} will continue in normal chat.
        </div>
      ) : !resolved ? (
        <div className="aq-footer-hint">Or type a reply in the composer below.</div>
      ) : null}
    </>
  )

  const headLabel =
    questionCount > 1
      ? `${askerName} is asking ${questionCount} questions`
      : `${askerName} is asking a question`

  const resolvedBody = (
    <div
      className="aq-card answered resolved open"
      data-testid="ask-user-question-card"
      data-status={content.status}
    >
      <div className="aq-head">
        <span aria-hidden="true">?</span> {headLabel}
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
    <div
      className={`aq-card${useStepper ? ' aq-mode-stepper' : ''}`}
      data-testid="ask-user-question-card"
      data-status={content.status}
    >
      <div className="aq-head">
        <span aria-hidden="true">?</span> {headLabel}
      </div>
      <div className="aq-body">{questionBody}</div>
    </div>
  )
}
