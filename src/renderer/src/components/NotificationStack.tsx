import { useEffect, useRef, useState } from 'react'
import type { AppNotification } from '../../../shared/notification-types'

function formatCountdown(startsAtMs: number): string {
  const rem = Math.max(0, Math.floor((startsAtMs - Date.now()) / 1000))
  if (rem === 0) return 'starting now'
  const m = Math.floor(rem / 60)
  const s = rem % 60
  return `in ${m}:${String(s).padStart(2, '0')}`
}

function NotificationToast({
  notification,
  onDismiss,
}: {
  notification: AppNotification
  onDismiss: () => void
}): JSX.Element {
  const [countdown, setCountdown] = useState<string | null>(
    notification.startsAtMs ? formatCountdown(notification.startsAtMs) : null,
  )
  const [leaving, setLeaving] = useState(false)
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Tick countdown every second while the event is in the future.
  useEffect(() => {
    if (!notification.startsAtMs) return
    const id = setInterval(() => {
      setCountdown(formatCountdown(notification.startsAtMs!))
    }, 1000)
    return () => clearInterval(id)
  }, [notification.startsAtMs])

  // Auto-dismiss.
  useEffect(() => {
    if (!notification.autoMs) return
    dismissTimer.current = setTimeout(leave, notification.autoMs)
    return () => {
      if (dismissTimer.current) clearTimeout(dismissTimer.current)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notification.id, notification.autoMs])

  function leave(): void {
    setLeaving(true)
    setTimeout(onDismiss, 160)
  }

  const subParts: string[] = []
  if (notification.sub) subParts.push(notification.sub)
  if (countdown) subParts.push(countdown)
  const subLine = subParts.join(' · ')

  return (
    <div className={`notif-toast${leaving ? ' notif-toast--out' : ''}`}>
      <button className="notif-dismiss" onClick={leave} title="Dismiss" type="button">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
      <div className="notif-title">{notification.title}</div>
      {subLine && <div className="notif-sub">{subLine}</div>}
    </div>
  )
}

export default function NotificationStack({
  notifications,
  onDismiss,
}: {
  notifications: AppNotification[]
  onDismiss: (id: string) => void
}): JSX.Element | null {
  if (notifications.length === 0) return null
  return (
    <div className="notif-stack" data-testid="notif-stack">
      {notifications.map((n) => (
        <NotificationToast key={n.id} notification={n} onDismiss={() => onDismiss(n.id)} />
      ))}
    </div>
  )
}
