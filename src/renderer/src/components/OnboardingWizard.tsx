import { useEffect, useState } from 'react'
import { APP_DISPLAY_NAME } from '../../../shared/app-brand'
import type { GitIdentity } from '../../../shared/config'

interface OnboardingWizardProps {
  isOpen: boolean
  initialGitIdentity: GitIdentity
  onFinish: (identity: GitIdentity) => void
  onSkip: () => void
}

/**
 * First-run wizard shell. Only asks for a git identity placeholder step —
 * there's no multi-provider "connect agent account" concept yet, so that's
 * intentionally not built here (see TODO below). The important mechanism is
 * "shows once": App.tsx only renders this while `!config.onboardingCompleted`.
 */
export default function OnboardingWizard({
  isOpen,
  initialGitIdentity,
  onFinish,
  onSkip
}: OnboardingWizardProps): JSX.Element | null {
  const [step, setStep] = useState(0)
  const [name, setName] = useState(initialGitIdentity.name)
  const [email, setEmail] = useState(initialGitIdentity.email)

  useEffect(() => {
    if (isOpen) {
      setStep(0)
      setName(initialGitIdentity.name)
      setEmail(initialGitIdentity.email)
    }
  }, [isOpen, initialGitIdentity.name, initialGitIdentity.email])

  if (!isOpen) return null

  const isLastStep = step === 1

  return (
    <div className="modal-backdrop" data-testid="onboarding-backdrop">
      <div className="modal-dialog onboarding-dialog" data-testid="onboarding-wizard">
        <div className="modal-header">
          <h2>Welcome to {APP_DISPLAY_NAME}</h2>
          <button
            type="button"
            className="btn btn-icon"
            data-testid="onboarding-close"
            aria-label="Close"
            onClick={onSkip}
          >
            ✕
          </button>
        </div>
        <div className="ob-steps">
          <div className={'ob-step-dot' + (step >= 0 ? ' done' : '')} />
          <div className={'ob-step-dot' + (step >= 1 ? ' done' : '')} />
        </div>
        <div className="modal-body">
          {step === 0 && (
            <div className="ob-step active" data-testid="onboarding-step-identity">
              <div className="field-label">Git identity</div>
              {/* TODO(multi-provider): real "connect agent account" flows land once there's
                  more than one provider/backend concept — for now this step is just a
                  placeholder git-identity capture, matching the wizard shell only. */}
              <input
                className="input"
                placeholder="Name"
                value={name}
                data-testid="onboarding-name-input"
                onChange={(e) => setName(e.target.value)}
                style={{ marginBottom: 8 }}
              />
              <input
                className="input"
                placeholder="Email"
                value={email}
                data-testid="onboarding-email-input"
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}
          {step === 1 && (
            <div className="ob-step active" data-testid="onboarding-step-done">
              <div style={{ textAlign: 'center', padding: '10px 0' }}>
                <div style={{ fontWeight: 600, marginTop: 8 }}>You&apos;re all set</div>
                <div className="field-hint">Create your first session to get started.</div>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost" data-testid="onboarding-skip" onClick={onSkip}>
            Skip
          </button>
          <div style={{ flex: 1 }} />
          {step > 0 && (
            <button className="btn" data-testid="onboarding-back" onClick={() => setStep((s) => s - 1)}>
              Back
            </button>
          )}
          {!isLastStep && (
            <button
              className="btn btn-primary"
              data-testid="onboarding-next"
              onClick={() => setStep((s) => s + 1)}
            >
              Next
            </button>
          )}
          {isLastStep && (
            <button
              className="btn btn-primary"
              data-testid="onboarding-finish"
              onClick={() => onFinish({ name, email })}
            >
              Finish
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
