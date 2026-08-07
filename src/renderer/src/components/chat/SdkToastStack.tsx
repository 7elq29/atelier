import type { SessionToastEvent } from '../../../../shared/harness-ui-types'

export default function SdkToastStack({ toasts }: { toasts: SessionToastEvent[] }): JSX.Element | null {
  if (toasts.length === 0) return null
  return (
    <div className="sdk-toast-stack sdk-toast-stack--overlay" data-testid="sdk-toast-stack">
      {toasts.map((t) => (
        <div
          key={t.key}
          className={`sdk-toast sdk-toast--subtle ${t.priority}`}
          data-testid="sdk-toast"
          data-toast-key={t.key}
          data-toast-priority={t.priority}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}
