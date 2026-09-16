import { useState, type ReactNode } from 'react'

interface ConfirmDialogShellProps {
  testId: string
  'data-step'?: number
  stepLabel?: string
  title: string
  lead: string
  subjectLabel: string
  subject: string
  onCancel: () => void
  footer: ReactNode
}

function ConfirmDialogShell({
  testId,
  'data-step': dataStep,
  stepLabel,
  title,
  lead,
  subjectLabel,
  subject,
  onCancel,
  footer
}: ConfirmDialogShellProps): JSX.Element {
  return (
    <div
      className="modal-backdrop"
      data-testid={testId}
      {...(dataStep !== undefined ? { 'data-step': dataStep } : {})}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`}>
        <div className="modal-header">
          <div className="confirm-dialog-header-text">
            {stepLabel && <div className="confirm-dialog-step">{stepLabel}</div>}
            <h2 id={`${testId}-title`}>{title}</h2>
          </div>
          <button type="button" className="close-btn" aria-label="Dismiss" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="confirm-dialog-lead">{lead}</p>
          <div className="confirm-dialog-subject-block">
            <span className="confirm-dialog-subject-label">{subjectLabel}</span>
            <p className="confirm-dialog-subject">{subject}</p>
          </div>
        </div>
        <div className="modal-footer">{footer}</div>
      </div>
    </div>
  )
}

interface TaskSessionReplaceDialogProps {
  taskText: string
  onConfirm: () => void
  onCancel: () => void
}

/** One confirmation before replacing an existing task ↔ session link. */
export function TaskSessionReplaceDialog({
  taskText,
  onConfirm,
  onCancel
}: TaskSessionReplaceDialogProps): JSX.Element {
  return (
    <ConfirmDialogShell
      testId="task-session-replace-dialog"
      title="Replace linked session?"
      lead="This task already has a session. You’ll configure a new one next; it will replace the link. The old session stays in the sidebar but won’t be tied to this task."
      subjectLabel="Task"
      subject={taskText}
      onCancel={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-ghost btn-sm" data-testid="task-session-replace-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" data-testid="task-session-replace-confirm" onClick={onConfirm}>
            Continue
          </button>
        </>
      }
    />
  )
}

type DeleteLinkedOutcome = 'complete' | 'session-only'

interface DeleteSessionLinkedTaskDialogProps {
  sessionName: string
  onDeleteOnly: () => void
  onDeleteAndComplete: () => void
  onCancel: () => void
}

export function DeleteSessionLinkedTaskDialog({
  sessionName,
  onDeleteOnly,
  onDeleteAndComplete,
  onCancel
}: DeleteSessionLinkedTaskDialogProps): JSX.Element {
  const [outcome, setOutcome] = useState<DeleteLinkedOutcome>('complete')
  const testId = 'delete-session-linked-task-dialog'

  const handleConfirm = (): void => {
    if (outcome === 'complete') onDeleteAndComplete()
    else onDeleteOnly()
  }

  return (
    <div
      className="modal-backdrop"
      data-testid={testId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={`${testId}-title`}>
        <div className="modal-header">
          <div className="confirm-dialog-header-text">
            <h2 id={`${testId}-title`}>Delete linked session?</h2>
          </div>
          <button type="button" className="close-btn" aria-label="Dismiss" onClick={onCancel}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <p className="confirm-dialog-lead">
            Session <strong className="confirm-dialog-lead-emphasis">{sessionName}</strong> is linked to a daily note task.
          </p>
          <ul className="confirm-choice-list" role="radiogroup" aria-label="Delete outcome">
            <li>
              <label
                className={`confirm-choice${outcome === 'complete' ? ' selected' : ''}`}
                data-testid="delete-linked-choice-complete"
              >
                <input
                  type="radio"
                  name="delete-linked-outcome"
                  checked={outcome === 'complete'}
                  onChange={() => setOutcome('complete')}
                />
                <span className="confirm-choice-body">
                  <span className="confirm-choice-title">Complete task and delete session</span>
                  <span className="confirm-choice-hint">
                    Marks the linked todo done in the vault, then removes the session.
                  </span>
                </span>
              </label>
            </li>
            <li>
              <label
                className={`confirm-choice${outcome === 'session-only' ? ' selected' : ''}`}
                data-testid="delete-linked-choice-session-only"
              >
                <input
                  type="radio"
                  name="delete-linked-outcome"
                  checked={outcome === 'session-only'}
                  onChange={() => setOutcome('session-only')}
                />
                <span className="confirm-choice-body">
                  <span className="confirm-choice-title">Delete session only</span>
                  <span className="confirm-choice-hint">
                    Leaves the task open; the note may still reference this session id.
                  </span>
                </span>
              </label>
            </li>
          </ul>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost btn-sm" data-testid="delete-linked-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" data-testid="delete-linked-confirm" onClick={handleConfirm}>
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}

export function DeleteAppNoteDialog({
  noteName,
  onArchive,
  onDeletePermanently,
  onCancel
}: {
  noteName: string
  onArchive: () => void
  onDeletePermanently: () => void
  onCancel: () => void
}): JSX.Element {
  const testId = 'delete-app-note-dialog'
  return (
    <ConfirmDialogShell
      testId={testId}
      title="Delete note?"
      lead="Delete moves this note to the archive folder and removes its Atelier tag. Delete permanently cannot be undone."
      subjectLabel="Note"
      subject={noteName}
      onCancel={onCancel}
      footer={
        <>
          <button type="button" className="btn btn-ghost btn-sm" data-testid="delete-app-note-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary btn-sm" data-testid="delete-app-note-archive" onClick={onArchive}>
            Delete
          </button>
          <button type="button" className="btn btn-danger btn-sm" data-testid="delete-app-note-permanently" onClick={onDeletePermanently}>
            Delete permanently
          </button>
        </>
      }
    />
  )
}
