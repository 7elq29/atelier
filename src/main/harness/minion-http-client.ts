/**
 * Minion SPA HTTP API (`https://minion.uberinternal.com/api/<Rpc>`).
 *
 * Auth: USSO Basic (`:token`) + `x-csrf-token: x` — same as the Minion web app.
 * Orchestrator + scratch both go through this transport (not aifx MCP).
 */

import { execFile } from 'node:child_process'
import { findUsso } from '../uber-auth'
import { subprocessEnvWithDevPath } from '../shell-path'

const BASE = 'https://minion.uberinternal.com'
const TOKEN_TTL_MS = 50 * 60 * 1000
export const MINION_HTTP_TIMEOUT_MS = 60_000

let cachedToken: { value: string; expiresAt: number } | null = null

function fetchUssoToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      findUsso(),
      ['-fetch', 'minion', '-print'],
      { timeout: 15_000, env: subprocessEnvWithDevPath() },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`usso -fetch minion failed: ${(stderr || err.message).trim().slice(0, 200)}`))
        } else {
          const value = stdout.trim()
          if (!value) reject(new Error('usso -fetch minion returned an empty token'))
          else resolve(value)
        }
      }
    )
  })
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value
  const value = await fetchUssoToken()
  cachedToken = { value, expiresAt: Date.now() + TOKEN_TTL_MS }
  return value
}

function authHeader(token: string): string {
  return `Basic ${Buffer.from(`:${token}`, 'utf8').toString('base64')}`
}

/** POST `/api/{endpoint}`; returns parsed JSON. Throws on HTTP/envelope failure. */
export async function postMinionApi(
  endpoint: string,
  body: Record<string, unknown>,
  opts?: { timeoutMs?: number; retry?: boolean }
): Promise<Record<string, unknown>> {
  const timeoutMs = opts?.timeoutMs ?? MINION_HTTP_TIMEOUT_MS
  const retry = opts?.retry ?? true
  const token = await getToken()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let resp: Response
  try {
    resp = await fetch(`${BASE}/api/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: authHeader(token),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-csrf-token': 'x'
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${endpoint} timed out after ${timeoutMs}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
  const text = await resp.text()
  if ((resp.status === 401 || resp.status === 403) && retry) {
    cachedToken = null
    return postMinionApi(endpoint, body, { ...opts, retry: false })
  }
  let parsed: Record<string, unknown> = {}
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    throw new Error(`${endpoint} returned non-JSON (${resp.status}): ${text.slice(0, 160)}`)
  }
  if (!resp.ok) {
    throw new Error(`${endpoint} HTTP ${resp.status}: ${text.slice(0, 200)}`)
  }
  if (parsed.status && parsed.status !== 'success') {
    const data = parsed.data
    const err =
      data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
        ? String((data as { message: string }).message)
        : typeof parsed.error === 'string'
          ? parsed.error
          : JSON.stringify(parsed).slice(0, 200)
    throw new Error(`${endpoint} status=${String(parsed.status)}: ${err}`)
  }
  return parsed
}

function dataOf(res: Record<string, unknown>): Record<string, unknown> {
  return res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : res
}

/** Normalize HTTP camelCase task → shape harness already reads (snake + camel). */
export function normalizeTask(task: Record<string, any>): Record<string, any> {
  const lu = task.latestUpdate ?? task.latest_update
  let latest_update = lu
  if (lu && typeof lu === 'object') {
    latest_update = {
      ...lu,
      message: lu.message,
      display_status: lu.displayStatus ?? lu.display_status,
      updated_at: lu.updatedAt ?? lu.updated_at,
      source: lu.source
    }
  }
  return {
    ...task,
    id: task.id,
    status: task.status,
    child_task_ids: task.childTaskIds ?? task.child_task_ids ?? [],
    runner_url: task.runnerUrl ?? task.runner_url,
    latest_update,
    metadata: task.metadata ?? {},
    output: task.output ?? task.Output,
    status_message: task.statusMessage ?? task.status_message
  }
}

export function normalizeInteraction(i: Record<string, any>): Record<string, any> {
  return {
    ...i,
    id: i.id,
    task_id: i.taskId ?? i.task_id,
    initiator: i.initiator,
    message: i.message,
    status: i.status,
    created_at: i.createdAt ?? i.created_at,
    responded_at: i.respondedAt ?? i.responded_at,
    response: i.response,
    content: i.content,
    response_content: i.responseContent ?? i.response_content
  }
}

export async function httpGetTask(id: string): Promise<{ task?: Record<string, any> }> {
  const res = await postMinionApi('getTask', { id })
  const data = dataOf(res)
  const task = data.task as Record<string, any> | undefined
  return { task: task ? normalizeTask(task) : undefined }
}

export async function httpListInteractions(taskId: string): Promise<{ interactions: Record<string, any>[] }> {
  const res = await postMinionApi('listInteractions', {
    taskId,
    afterInteractionId: '',
    initiatorFilter: 0,
    statusFilter: 0
  })
  const data = dataOf(res)
  const raw = (data.interactions ?? []) as Record<string, any>[]
  return { interactions: raw.map(normalizeInteraction) }
}

export async function httpCreateInteraction(
  taskId: string,
  text: string
): Promise<{ interaction: Record<string, any> }> {
  const res = await postMinionApi(
    'createInteraction',
    {
      taskId,
      initiator: 'INTERACTION_INITIATOR_USER',
      message: text,
      content: {
        // Match Minion web resume/steer surface.
        surface: 'INTERACTION_SURFACE_WEB',
        type: 'INTERACTION_CONTENT_TYPE_TEXT',
        text
      }
    },
    { timeoutMs: 45_000 }
  )
  const data = dataOf(res)
  const interaction = data.interaction as Record<string, any> | undefined
  if (!interaction?.id) {
    throw new Error('createInteraction returned no interaction id')
  }
  // Normalize so callers always see task_id from the response (authoritative).
  const normalized = normalizeInteraction(interaction)
  if (!normalized.task_id && typeof data.taskId === 'string') {
    normalized.task_id = data.taskId
  }
  return { interaction: normalized }
}

export async function httpCancelTask(id: string): Promise<void> {
  await postMinionApi('cancelTask', { id })
}

export async function httpCreateTask(body: Record<string, unknown>): Promise<{ task?: Record<string, any>; id?: string }> {
  const res = await postMinionApi('createTask', body, { timeoutMs: 120_000 })
  const data = dataOf(res)
  const task = data.task as Record<string, any> | undefined
  return {
    task: task ? normalizeTask(task) : undefined,
    id: typeof data.id === 'string' ? data.id : task?.id
  }
}

export type DevpodInfo = {
  name: string
  state: string
  taskId: string | null
}

/** List DevPods; match tip via name `…-minion-<shortId>` or feature-flag task id. */
export async function httpGetDevpods(): Promise<DevpodInfo[]> {
  const res = await postMinionApi('getDevpods', {})
  const data = dataOf(res)
  const infos = (data.infos ?? []) as Array<Record<string, any>>
  return infos.map((info) => {
    const d = (info.devpod ?? info) as Record<string, any>
    const name = String(d.name ?? '')
    const state = String(d.state ?? '')
    let taskId: string | null = null
    const map = d.featureFlags?.devpodMap ?? d.feature_flags?.devpodMap
    if (map && typeof map === 'object') {
      for (const [k, v] of Object.entries(map as Record<string, any>)) {
        if (k.includes('task_id') && v && typeof v === 'object' && typeof v.stringValue === 'string') {
          taskId = v.stringValue
          break
        }
      }
    }
    return { name, state, taskId }
  })
}

export function findDevpodForTask(pods: DevpodInfo[], taskId: string, devpodName?: string): DevpodInfo | null {
  const short = taskId.slice(0, 8)
  if (devpodName) {
    const byName = pods.find((p) => p.name === devpodName)
    if (byName) return byName
  }
  return (
    pods.find((p) => p.taskId === taskId) ??
    pods.find((p) => p.name.includes(short)) ??
    null
  )
}

export function isDevpodRunningState(state: string): boolean {
  return state === 'STATE_RUNNING'
}
