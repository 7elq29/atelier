import type { HarnessEvent } from '../harness/types'
import type { BackgroundTaskRow } from '../../shared/harness-ui-types'

export interface SdkChromeState {
  status: 'compacting' | 'requesting' | 'minion_setup' | 'minion_working' | null
  permissionMode?: string
  compactFailed?: boolean
  compactError?: string
  apiRetryText?: string | null
  thinkingActive?: boolean
  thinkingEstimatedTokens?: number
  title?: string
  detail?: string
  setupSteps?: Array<{
    id: 'provision' | 'boot' | 'connect'
    label: string
    state: 'done' | 'active' | 'pending'
  }>
}

export interface RateLimitChromeState {
  warnLabel: string | null
  sendBlocked: boolean
}

export interface AuthChromeState {
  message: string | null
  isAuthenticating: boolean
}

function formatRateLimitLabel(
  status: string,
  resetsAt?: number,
  utilization?: number
): RateLimitChromeState {
  const sendBlocked = status === 'rejected'
  if (status === 'allowed' && utilization == null) {
    return { warnLabel: null, sendBlocked: false }
  }
  const parts: string[] = []
  if (status === 'allowed_warning' || status === 'rejected') {
    parts.push('Rate limit')
  }
  if (utilization != null) {
    parts.push(`${Math.round(utilization * 100)}%`)
  }
  if (resetsAt != null) {
    parts.push(
      `resets ${new Date(resetsAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
    )
  }
  return { warnLabel: parts.length ? parts.join(' · ') : null, sendBlocked }
}

function taskSubtitleFromProgress(event: Extract<HarnessEvent, { type: 'task_progress' }>): string {
  const parts: string[] = []
  if (event.lastToolName) parts.push(event.lastToolName)
  if (event.usage) {
    parts.push(`${event.usage.tool_uses} tool uses`)
    const sec = Math.round(event.usage.duration_ms / 1000)
    if (sec >= 60) parts.push(`${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`)
    else if (sec > 0) parts.push(`${sec}s`)
  } else if (event.summary) {
    parts.push(event.summary)
  }
  return parts.join(' · ')
}

export class SessionHarnessUiState {
  private readonly taskRows = new Map<string, Map<string, BackgroundTaskRow>>()
  /**
   * After reset/reconnect, only task ids present in the latest
   * `background_tasks_changed` payload may exist in the rail. Replayed
   * `task_started` events from an old turn must not recreate dead jobs.
   */
  private readonly sdkChrome = new Map<string, SdkChromeState>()
  private readonly rateLimit = new Map<string, RateLimitChromeState>()
  private auth: AuthChromeState = { message: null, isAuthenticating: false }

  resetSession(sessionId: string): void {
    this.taskRows.set(sessionId, new Map())
    this.sdkChrome.delete(sessionId)
    this.rateLimit.delete(sessionId)
  }

  private taskAllowed(sessionId: string, taskId: string): boolean {
    const map = this.taskRows.get(sessionId)
    return Boolean(map?.has(taskId))
  }

  getTasks(sessionId: string): BackgroundTaskRow[] {
    return [...(this.taskRows.get(sessionId)?.values() ?? [])]
  }

  getSdkChrome(sessionId: string): SdkChromeState | null {
    return this.sdkChrome.get(sessionId) ?? null
  }

  setThinkingChrome(sessionId: string, estimatedTokens?: number): void {
    const cur = this.sdkChrome.get(sessionId) ?? { status: null, apiRetryText: null }
    this.sdkChrome.set(sessionId, {
      ...cur,
      thinkingActive: true,
      ...(estimatedTokens != null ? { thinkingEstimatedTokens: estimatedTokens } : {}),
    })
  }

  clearThinkingChrome(sessionId: string): void {
    const cur = this.sdkChrome.get(sessionId)
    if (!cur?.thinkingActive && cur?.thinkingEstimatedTokens == null) return
    this.sdkChrome.set(sessionId, {
      ...(cur ?? { status: null, apiRetryText: null }),
      thinkingActive: false,
      thinkingEstimatedTokens: undefined,
    })
  }

  getRateLimit(sessionId: string): RateLimitChromeState | null {
    return this.rateLimit.get(sessionId) ?? null
  }

  getAuth(): AuthChromeState {
    return this.auth
  }

  /** Clear ephemeral requesting/compacting chrome when the SDK omits `status: null`. */
  clearInFlightStatus(sessionId: string): void {
    const cur = this.sdkChrome.get(sessionId)
    if (!cur) return
    // Minion SETUP / Working cards are owned by MinionHarness until status:null.
    if (cur.status === 'minion_setup' || cur.status === 'minion_working') {
      if (cur.apiRetryText) {
        this.sdkChrome.set(sessionId, { ...cur, apiRetryText: null })
      }
      return
    }
    if (cur.compactFailed) {
      if (cur.apiRetryText) {
        this.sdkChrome.set(sessionId, { ...cur, apiRetryText: null })
      }
      return
    }
    if (cur.status == null && !cur.apiRetryText) return
    this.sdkChrome.set(sessionId, {
      status: null,
      permissionMode: undefined,
      compactFailed: false,
      compactError: undefined,
      apiRetryText: null,
      thinkingActive: false,
      thinkingEstimatedTokens: undefined,
      title: undefined,
      detail: undefined,
      setupSteps: undefined,
    })
  }

  apply(event: HarnessEvent): {
    toast?: { key: string; text: string; priority: 'low' | 'medium' | 'high' | 'immediate' }
    logHook?: string
  } {
    const sid = event.sessionId
    const side: {
      toast?: { key: string; text: string; priority: 'low' | 'medium' | 'high' | 'immediate' }
      logHook?: string
    } = {}

    switch (event.type) {
      case 'background_tasks_changed': {
        const prev = this.taskRows.get(sid) ?? new Map()
        const next = new Map<string, BackgroundTaskRow>()
        for (const t of event.tasks) {
          const old = prev.get(t.taskId)
          next.set(t.taskId, {
            taskId: t.taskId,
            taskType: t.taskType,
            description: t.description,
            status: old?.status ?? 'pending',
            subtitle: old?.subtitle,
            error: old?.error,
            done: old?.done,
          })
        }
        this.taskRows.set(sid, next)
        break
      }
      case 'task_started': {
        const map = this.taskRows.get(sid)
        if (!map) break
        const row = map.get(event.taskId)
        if (!row) break
        const meta: string[] = []
        if (event.subagentType) meta.push(event.subagentType)
        if (event.workflowName) meta.push(event.workflowName)
        row.taskType = event.taskType ?? row.taskType
        row.description = event.description
        row.status = 'running'
        if (meta.length) row.subtitle = meta.join(' · ')
        break
      }
      case 'task_updated': {
        const map = this.taskRows.get(sid)
        if (!map) break
        const row = map.get(event.taskId)
        if (!row) break
        if (event.patch.status) {
          row.status = event.patch.status
          if (event.patch.status === 'pending' && !row.subtitle?.includes('last:')) {
            row.subtitle = undefined
          }
        }
        if (event.patch.description) row.description = event.patch.description
        if (event.patch.error) {
          row.error = event.patch.error
          row.subtitle = `failed · ${event.patch.error}`
        }
        if (event.patch.status === 'completed' || event.patch.status === 'failed' || event.patch.status === 'killed') {
          row.done = true
        }
        break
      }
      case 'task_progress': {
        if (!this.taskAllowed(sid, event.taskId)) break
        const map = this.taskRows.get(sid)
        const row = map?.get(event.taskId)
        if (row) row.subtitle = taskSubtitleFromProgress(event)
        break
      }
      case 'task_notification': {
        if (!this.taskAllowed(sid, event.taskId)) break
        const map = this.taskRows.get(sid)
        const row = map?.get(event.taskId)
        if (row) {
          row.done = true
          row.status = event.status === 'completed' ? 'completed' : 'failed'
          if (event.summary) row.description = event.summary
        }
        break
      }
      case 'sdk_notification':
        if (event.priority === 'immediate' || event.priority === 'high') {
          side.toast = { key: event.key, text: event.text, priority: event.priority }
        }
        break
      case 'sdk_status': {
        if (event.status == null) {
          this.sdkChrome.set(sid, {
            status: null,
            apiRetryText: this.sdkChrome.get(sid)?.apiRetryText ?? null,
            title: undefined,
            detail: undefined,
            setupSteps: undefined,
          })
        } else if (event.compactResult === 'failed') {
          this.sdkChrome.set(sid, {
            status: null,
            compactFailed: true,
            compactError: event.compactError,
            permissionMode: event.permissionMode,
            apiRetryText: null,
            title: undefined,
            detail: undefined,
            setupSteps: undefined,
          })
        } else {
          this.sdkChrome.set(sid, {
            status: event.status,
            permissionMode: event.permissionMode,
            compactFailed: false,
            compactError: undefined,
            apiRetryText: this.sdkChrome.get(sid)?.apiRetryText ?? null,
            title: event.title,
            detail: event.detail,
            setupSteps: event.setupSteps,
          })
        }
        break
      }
      case 'api_retry': {
        const prev: SdkChromeState = this.sdkChrome.get(sid) ?? { status: null, apiRetryText: null }
        prev.apiRetryText = 'Retrying API…'
        this.sdkChrome.set(sid, prev)
        break
      }
      case 'rate_limit_event':
        this.rateLimit.set(sid, formatRateLimitLabel(event.status, event.resetsAt, event.utilization))
        break
      case 'auth_status': {
        const msg = event.error ?? event.output.join(' ').trim()
        this.auth = {
          isAuthenticating: event.isAuthenticating,
          message: msg || (event.isAuthenticating ? 'Signing in…' : null),
        }
        break
      }
      case 'hook_started':
        side.logHook = `hook ${event.hookEvent} · ${event.hookName}`
        break
      case 'hook_progress':
        side.logHook = `hook ${event.hookEvent} · ${event.line}`
        break
      case 'hook_response':
        side.logHook = `hook ${event.hookEvent} · ${event.outcome}${event.exitCode != null ? ` · ${event.exitCode}` : ''}`
        break
      case 'worker_shutting_down':
        side.logHook = `worker subagent worker shutting down (${event.agentId ?? 'unknown'})`
        break
      default:
        break
    }
    return side
  }
}
