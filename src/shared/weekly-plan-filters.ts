import type { DailyTask } from './daily-note-types'

/** Template / checklist noise in weekly note Big Three sections. */
export function isWeeklyPlanInstructionLine(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (t.startsWith('%%')) return true
  if (/^\d+\.\s*\[\s*[ xX]?\s*\]\s*\.?\s*$/.test(t)) return true
  if (/^\[Completion:\s*%?\]\s*$/i.test(t)) return true
  if (/^At least ONE must/i.test(t)) return true
  return false
}

/** Checkbox tasks under Tasks or Backlog (not plain note bullets). */
export function isDailyNoteActionTask(task: Pick<DailyTask, 'isNote' | 'section'>): boolean {
  if (task.isNote) return false
  if (task.section === 'tracker') return false
  return task.section === 'day-plan' || task.section === 'unscheduled'
}

/** Plain `-` bullets under Tasks or Backlog (daily notes, not checkbox tasks). */
export function isDailyNoteNoteLine(task: Pick<DailyTask, 'isNote' | 'section'>): boolean {
  if (!task.isNote) return false
  if (task.section === 'tracker') return false
  return task.section === 'day-plan' || task.section === 'unscheduled'
}

/** Checkbox tasks and note bullets (e.g. #meeting) that belong on the weekly schedule. */
export function isDailyNoteScheduleItem(task: Pick<DailyTask, 'isNote' | 'section'>): boolean {
  return isDailyNoteActionTask(task) || isDailyNoteNoteLine(task)
}
