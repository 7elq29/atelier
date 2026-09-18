import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { logger } from './logger'
import type {
  AppNotification,
  NotificationPushEvent,
  ScheduleNotificationPayload,
} from '../shared/notification-types'

/**
 * Manages scheduled and immediate in-app notification pushes to the renderer.
 * Any part of the main process can call `push()` or `schedule()` to surface
 * a floating notification card in the renderer without going through IPC itself.
 */
export class NotificationScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  /** Push a notification to the renderer immediately. */
  push(notification: AppNotification): void {
    const payload: NotificationPushEvent = { notification }
    logger.info('notification: push', { id: notification.id, title: notification.title })
    this.getWindow()?.webContents.send('notification:push', payload)
  }

  /**
   * Schedule a notification to fire at `fireAtMs`. Returns the notification id.
   * If `fireAtMs` is in the past or absent, fires immediately.
   * Pass `notification.id` to make the scheduled entry cancellable.
   */
  schedule(payload: ScheduleNotificationPayload): string {
    const id = payload.notification.id ?? randomUUID()
    const notification: AppNotification = { ...payload.notification, id }
    const delay = payload.fireAtMs ? Math.max(0, payload.fireAtMs - Date.now()) : 0

    // Cancel any existing timer for the same id before rescheduling.
    this.cancel(id)

    const timer = setTimeout(() => {
      this.timers.delete(id)
      this.push(notification)
    }, delay)
    this.timers.set(id, timer)

    logger.info('notification: scheduled', { id, delayMs: delay, title: notification.title })
    return id
  }

  /** Cancel a scheduled (not yet fired) notification by id. No-op if already fired. */
  cancel(id: string): void {
    const timer = this.timers.get(id)
    if (!timer) return
    clearTimeout(timer)
    this.timers.delete(id)
    logger.info('notification: cancelled', { id })
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }
}
