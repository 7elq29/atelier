import { useCallback, useEffect, useState } from 'react'
import type { AppNotification } from '../../../shared/notification-types'

export interface UseNotificationsResult {
  notifications: AppNotification[]
  dismiss: (id: string) => void
}

export function useNotifications(): UseNotificationsResult {
  const [notifications, setNotifications] = useState<AppNotification[]>([])

  useEffect(() => {
    return window.atelier.onNotification(({ notification }) => {
      setNotifications((prev) => {
        // Deduplicate by id — re-push of the same id replaces in place.
        const idx = prev.findIndex((n) => n.id === notification.id)
        if (idx !== -1) {
          const next = [...prev]
          next[idx] = notification
          return next
        }
        // Cap at 5 visible; drop the oldest if over the limit.
        const next = [notification, ...prev]
        return next.length > 5 ? next.slice(0, 5) : next
      })
    })
  }, [])

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
  }, [])

  return { notifications, dismiss }
}
