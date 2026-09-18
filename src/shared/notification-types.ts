/** A floating in-app notification pushed from the main process to the renderer. */
export interface AppNotification {
  /** Stable identifier — used for deduplication and dismiss. */
  id: string
  /** Primary line. */
  title: string
  /** Secondary line, shown before the countdown if both are present. */
  sub?: string
  /** Unix timestamp (ms) of the event start. When set, a live "in M:SS" countdown
   *  is appended inline to the subtitle line. */
  startsAtMs?: number
  /** Auto-dismiss after this many ms. 0 or absent = sticky until dismissed. */
  autoMs?: number
}

/** IPC payload pushed from main → renderer on `notification:push`. */
export interface NotificationPushEvent {
  notification: AppNotification
}

/** IPC payload for `notification:schedule` — schedule a future push. */
export interface ScheduleNotificationPayload {
  notification: Omit<AppNotification, 'id'> & { id?: string }
  /** Fire at this unix timestamp (ms). Omit or 0 to fire immediately. */
  fireAtMs?: number
}
