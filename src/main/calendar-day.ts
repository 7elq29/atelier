import { app, ipcMain, powerMonitor, type BrowserWindow } from 'electron'
import { logger } from './logger'

const MAX_TIMER_DELAY_MS = 6 * 60 * 60 * 1000
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export interface CalendarDayChangedPayload {
  date: string
}

export function formatLocalDate(date: Date): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

/** Today's date as YYYY-MM-DD (local time), overridable for deterministic e2e runs. */
export function resolveDefaultDate(): string {
  return process.env.ATELIER_TEST_DATE ?? formatLocalDate(new Date())
}

function delayUntilNextLocalMidnight(now: Date): number {
  const nextMidnight = new Date(now)
  nextMidnight.setHours(24, 0, 0, 50)
  return Math.max(1, nextMidnight.getTime() - now.getTime())
}

/**
 * Owns the app's single calendar-day clock. The timeout handles an app left
 * running normally; resume/unlock handle timers suspended while the machine
 * slept. Every path converges through publishIfChanged so duplicate wake
 * events are free.
 */
export function startCalendarDayMonitor(getWindow: () => BrowserWindow | null): () => void {
  let currentDate = resolveDefaultDate()
  let timer: ReturnType<typeof setTimeout> | null = null

  const publishIfChanged = (): void => {
    const nextDate = resolveDefaultDate()
    if (nextDate === currentDate) return

    const previousDate = currentDate
    currentDate = nextDate
    logger.info('calendar day changed', { from: previousDate, to: nextDate })
    getWindow()?.webContents.send('calendar:day-changed', { date: nextDate } satisfies CalendarDayChangedPayload)
  }

  const schedule = (): void => {
    if (process.env.ATELIER_TEST_DATE) return
    const delay = Math.min(delayUntilNextLocalMidnight(new Date()), MAX_TIMER_DELAY_MS)
    timer = setTimeout(() => {
      publishIfChanged()
      schedule()
    }, delay)
  }

  const onResume = (): void => publishIfChanged()
  const onUnlock = (): void => publishIfChanged()
  powerMonitor.on('resume', onResume)
  powerMonitor.on('unlock-screen', onUnlock)

  const allowDebugDate = !app.isPackaged || process.env.ATELIER_TEST_VAULT_ROOT !== undefined
  if (allowDebugDate) {
    ipcMain.handle('debug:setCalendarDate', (_event, date: string) => {
      if (!DATE_KEY_PATTERN.test(date)) throw new Error(`invalid calendar date: ${date}`)
      process.env.ATELIER_TEST_DATE = date
      publishIfChanged()
      return { date: currentDate }
    })
  }

  schedule()

  return () => {
    if (timer) clearTimeout(timer)
    powerMonitor.removeListener('resume', onResume)
    powerMonitor.removeListener('unlock-screen', onUnlock)
    if (allowDebugDate) ipcMain.removeHandler('debug:setCalendarDate')
  }
}
