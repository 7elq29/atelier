/**
 * Date math for the "Move to..." context menu (16-task-move-to-date).
 *
 * Pure, no Node/Electron imports — safe for the renderer. Deliberately not
 * importing from `src/main/daily-note-io.ts` (which has the same day-name/
 * date-add logic already for `getDayOfWeek`/`resolveNotePath`) to keep the
 * renderer's own module boundary intact, matching how this codebase already
 * keeps renderer-side date helpers separate from main-process ones.
 */

export interface MoveDateOption {
  label: string
  date: string
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** `date` (YYYY-MM-DD) plus `n` days, formatted as YYYY-MM-DD. Constructs
 * with an explicit `T00:00:00` local-time suffix to avoid UTC/local
 * timezone drift shifting the computed day (same convention as
 * `subtractDays`/`resolveNotePath` in the main process). */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + n)
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function dayOfWeek(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  return DAY_NAMES[d.getDay()]!
}

export interface MoveDateOptions {
  /** "Move to tomorrow" + the next 5 days labeled by weekday name — always 6 entries. */
  days: MoveDateOption[]
  /** "Move to next week" = today + 7 days. */
  nextWeek: MoveDateOption
}

/**
 * Computes the "Move to..." menu's options relative to `today` (YYYY-MM-DD,
 * the date of the daily note currently open — see DailyNotesSidebar): a
 * "tomorrow" option, then the next 5 calendar days labeled by their weekday
 * name (so the menu always has 6 explicit day options regardless of what day
 * today is), then "next week" = today + 7 days (same weekday, one week out).
 */
export function computeMoveDateOptions(today: string): MoveDateOptions {
  const days: MoveDateOption[] = []
  for (let i = 1; i <= 6; i++) {
    const date = addDays(today, i)
    const label = i === 1 ? 'Move to tomorrow' : `Move to ${dayOfWeek(date)}`
    days.push({ label, date })
  }
  const nextWeekDate = addDays(today, 7)
  return { days, nextWeek: { label: 'Move to next week', date: nextWeekDate } }
}
