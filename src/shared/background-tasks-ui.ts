import type { BackgroundTaskRow } from './harness-ui-types'

/** Max visible characters for background task titles in rail + transcript card. */
export const BACKGROUND_TASK_TITLE_MAX = 52

export type BackgroundTaskRailFamily = 'monitors' | 'subagents' | 'jobs' | 'shell'

export function backgroundTaskRailGroup(taskType: string): BackgroundTaskRailFamily {
  const t = taskType.toLowerCase()
  if (t === 'monitor') return 'monitors'
  if (t === 'shell') return 'shell'
  if (t === 'subagent') return 'subagents'
  return 'jobs'
}

/** SDK `task_type: subagent` — distinct from monitors, shell, and generic background jobs. */
export function isSubagentBackgroundTask(task: BackgroundTaskRow): boolean {
  return backgroundTaskRailGroup(task.taskType) === 'subagents'
}

/** Monitors, shell, and non-subagent jobs only — subagents belong in the tracker rail, not the transcript card. */
export function backgroundTasksForTranscriptCard(tasks: BackgroundTaskRow[]): BackgroundTaskRow[] {
  return tasks.filter((t) => !isSubagentBackgroundTask(t))
}

export function truncateBackgroundTaskTitle(text: string, max = BACKGROUND_TASK_TITLE_MAX): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

export function isBackgroundTaskActive(task: BackgroundTaskRow): boolean {
  if (task.done) return false
  const s = task.status
  return s !== 'completed' && s !== 'failed' && s !== 'killed'
}

/** User-visible lifecycle label (distinct from progress subtitle). */
export function backgroundTaskStatusLabel(task: BackgroundTaskRow): string {
  if (task.done || task.status === 'completed') return 'done'
  if (task.status === 'failed' || task.error) return 'failed'
  if (task.status === 'killed') return 'stopped'
  if (task.status === 'paused') return 'paused'
  if (task.status === 'pending') return 'starting'
  if (task.status === 'running') return 'running'
  return 'running'
}

export function backgroundTaskTypeBadgeClass(taskType: string): string {
  const t = taskType.toLowerCase()
  if (t === 'shell') return 'shell'
  if (t === 'monitor') return 'monitor'
  if (t === 'workflow') return 'workflow'
  if (t === 'subagent') return 'subagent'
  return 'job'
}

export function backgroundTaskTypeBadgeLabel(taskType: string): string {
  const t = taskType.toLowerCase()
  if (t === 'monitor') return 'monitor'
  if (t === 'shell') return 'shell'
  if (t === 'workflow') return 'workflow'
  if (t === 'subagent') return 'subagent'
  return 'job'
}

export function countActiveBackgroundTasks(tasks: BackgroundTaskRow[]): number {
  return tasks.filter(isBackgroundTaskActive).length
}
