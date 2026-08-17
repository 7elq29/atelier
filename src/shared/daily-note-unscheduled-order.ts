import type { DailyTask } from './daily-note-types'

function isDelegatedUnscheduled(task: DailyTask): boolean {
  return task.section === 'unscheduled' && task.tags.includes('#delegated')
}

/** Open/in-progress tasks first, completed (`done`) last — stable within each bucket. */
function partitionDoneToBottom(tasks: DailyTask[]): DailyTask[] {
  const open: DailyTask[] = []
  const done: DailyTask[] = []
  for (const task of tasks) {
    if (task.status === 'done') done.push(task)
    else open.push(task)
  }
  return [...open, ...done]
}

/** Sort one unscheduled subsection (backlog or delegated) for display. */
export function sortUnscheduledSubsection(tasks: DailyTask[]): DailyTask[] {
  return partitionDoneToBottom(tasks)
}

/**
 * Rebuild the flat task list so each unscheduled subsection keeps backlog before
 * delegated, with completed tasks at the bottom of each subsection.
 */
export function reorderUnscheduledTasks(tasks: DailyTask[]): DailyTask[] {
  const dayPlan = tasks.filter((t) => t.section === 'day-plan')
  const backlog = partitionDoneToBottom(
    tasks.filter((t) => t.section === 'unscheduled' && !t.tags.includes('#delegated'))
  )
  const delegated = partitionDoneToBottom(tasks.filter(isDelegatedUnscheduled))
  const trackers = tasks.filter((t) => t.section === 'tracker')
  return [...dayPlan, ...backlog, ...delegated, ...trackers]
}

/** Display order for the Unscheduled panel (backlog rows, then delegated). */
export function sortUnscheduledTasksForDisplay(tasks: DailyTask[]): DailyTask[] {
  const unscheduled = tasks.filter((t) => t.section === 'unscheduled')
  const backlog = sortUnscheduledSubsection(unscheduled.filter((t) => !t.tags.includes('#delegated')))
  const delegated = sortUnscheduledSubsection(unscheduled.filter((t) => t.tags.includes('#delegated')))
  return [...backlog, ...delegated]
}
