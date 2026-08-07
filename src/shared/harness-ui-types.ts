/** Background task row for tracker rail (merged from SDK task_* + background_tasks_changed). */

export interface BackgroundTaskRow {
  taskId: string
  taskType: string
  description: string
  status?: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused'
  subtitle?: string
  error?: string
  done?: boolean
}

export interface SessionBackgroundTasksEvent {
  sessionId: string
  tasks: BackgroundTaskRow[]
}

export type SdkStatusKind = 'compacting' | 'requesting'

export interface SessionSdkChromeEvent {
  sessionId: string
  /** null clears ephemeral status card */
  status: SdkStatusKind | null
  permissionMode?: string
  compactFailed?: boolean
  compactError?: string
  apiRetryText?: string | null
}

export interface SessionRateLimitEvent {
  sessionId: string
  warnLabel: string | null
  sendBlocked: boolean
}

export interface SessionToastEvent {
  sessionId: string
  key: string
  text: string
  priority: 'low' | 'medium' | 'high' | 'immediate'
}

export interface SessionAuthStatusEvent {
  message: string | null
  isAuthenticating: boolean
}

export interface SessionHookLogEvent {
  sessionId: string
  line: string
}

export { backgroundTaskRailGroup } from './background-tasks-ui'
export type { BackgroundTaskRailFamily } from './background-tasks-ui'
