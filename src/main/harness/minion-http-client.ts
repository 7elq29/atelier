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

/** USSO token for Minion HTTP (Basic) and worker WebSocket (Bearer). */
export async function getMinionBearerToken(): Promise<string> {
  return getToken()
}

/** Drop cached USSO token after a 401 (HTTP or WebSocket). */
export function invalidateMinionToken(): void {
  cachedToken = null
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
    invalidateMinionToken()
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

/**
 * MySQL `message` column on createInteraction is TEXT (64KiB). Stay under that
 * so we fail client-side with a clear error instead of Error 1406.
 */
export const MINION_CREATE_INTERACTION_MESSAGE_MAX = 60_000

/**
 * Minion's createInteraction wire format only persists TEXT — extra image/file
 * fields are stripped server-side. Embed small images as data URLs in the
 * message body so the remote agent can still read them.
 *
 * Prefer the live worker `USER_MESSAGE` path for attachments when the socket is
 * up — inlining into RPC hits the 64KiB column limit on typical screenshots.
 */
export function buildMinionSteerMessage(
  text: string,
  attachments?: Array<{ mimeType: string; data: string; name?: string }>
): string {
  const body = text.trim()
  if (!attachments?.length) return body
  const parts: string[] = []
  if (body) parts.push(body)
  parts.push('')
  parts.push(
    'The user attached the following file(s) as data URLs in this message (not under attachments/).',
    'Decode each data URL to a local file (e.g. probe/attN.png) and inspect it with Read — for images, look at the pixels and describe what you see.'
  )
  // Budget for labels + data URLs inside the TEXT column.
  let remaining = MINION_CREATE_INTERACTION_MESSAGE_MAX - parts.join('\n').length - 32
  for (const a of attachments) {
    const name = (a.name || 'attachment').replace(/\s+/g, '_')
    const mime = a.mimeType || 'application/octet-stream'
    const data = a.data.replace(/\s+/g, '')
    const header = `- ${name} (${mime}):`
    const dataUrl = `data:${mime};base64,${data}`
    const cost = header.length + dataUrl.length + 2
    if (cost > remaining) {
      parts.push(
        `- ${name} (${mime}): omitted — too large to inline for offline Minion send (${data.length} base64 chars). Re-send once the worker is linked, or use a smaller image.`
      )
      remaining -= 120
      continue
    }
    parts.push(header)
    parts.push(dataUrl)
    remaining -= cost
  }
  return parts.join('\n')
}

export async function httpCreateInteraction(
  taskId: string,
  text: string,
  attachments?: Array<{ mimeType: string; data: string; name?: string }>
): Promise<{ interaction: Record<string, any> }> {
  const message = buildMinionSteerMessage(text, attachments)
  if (!message.trim()) {
    throw new Error('createInteraction requires text or attachments')
  }
  if (message.length > MINION_CREATE_INTERACTION_MESSAGE_MAX) {
    throw new Error(
      `Message too large for Minion offline send (${message.length} chars; max ${MINION_CREATE_INTERACTION_MESSAGE_MAX}). ` +
        `Wait until the worker is linked (then attachments go over the socket), or send text only / a smaller image.`
    )
  }
  // Still too big after omit stubs → attachment couldn't fit at all.
  if (
    attachments?.length &&
    message.includes('omitted — too large') &&
    !message.includes('data:')
  ) {
    throw new Error(
      'Attachment too large for Minion offline send. Wait until the worker is linked, or send a smaller image / text only.'
    )
  }
  const res = await postMinionApi(
    'createInteraction',
    {
      taskId,
      initiator: 'INTERACTION_INITIATOR_USER',
      message,
      content: {
        // Match Minion web resume/steer surface.
        surface: 'INTERACTION_SURFACE_WEB',
        type: 'INTERACTION_CONTENT_TYPE_TEXT',
        text: message
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
  const short = taskId.slice(0, 8).toLowerCase()
  // Prefer the task's own pod name. If it is named but not listed yet, return
  // null — do NOT fuzzy-match another tip's RUNNING pod (that jumps SETUP
  // Boot → Connect while Minion UI correctly stays on Boot).
  if (devpodName) {
    return pods.find((p) => p.name === devpodName) ?? null
  }
  const byTaskId = pods.find((p) => p.taskId === taskId)
  if (byTaskId) return byTaskId
  // Names look like `…-minion-<shortId>`; require that marker (not bare UUID).
  return (
    pods.find((p) => {
      const n = p.name.toLowerCase()
      return n.includes(`minion-${short}`) || n.endsWith(`-${short}`)
    }) ?? null
  )
}

export function isDevpodRunningState(state: string): boolean {
  return state === 'STATE_RUNNING'
}

/** uTerm / Minion Web pod phase classes (see Features/minion-websocket-session). */
export type DevpodPhaseClass = 'running' | 'starting' | 'sleeping' | 'failed' | 'unknown'

export function classifyDevpodPhase(state: string): DevpodPhaseClass {
  const s = String(state ?? '').toUpperCase().replace(/^STATE_/, '')
  if (!s) return 'unknown'
  if (s === 'RUNNING') return 'running'
  if (
    s === 'PENDING' ||
    s === 'INITIATING' ||
    s === 'STARTING' ||
    s === 'CREATING' ||
    s === 'RESTORING' ||
    s === 'BOOTING'
  ) {
    return 'starting'
  }
  if (
    s === 'SNAPSHOTTED' ||
    s === 'SHUTDOWN' ||
    s === 'STOPPED' ||
    s === 'SUSPENDED' ||
    s === 'TERMINATED'
  ) {
    return 'sleeping'
  }
  if (s === 'FAILED' || s === 'ERROR') return 'failed'
  return 'unknown'
}

export function isDevpodSleepingState(state: string): boolean {
  return classifyDevpodPhase(state) === 'sleeping'
}

export function isDevpodStartingState(state: string): boolean {
  return classifyDevpodPhase(state) === 'starting'
}

/**
 * Restore a snapshotted / shutdown DevPod (Minion web `devpodStart`).
 * Body shape: `{ devpodName, region }` — verified against the live RPC.
 */
export async function httpDevpodStart(devpodName: string, region: string): Promise<void> {
  const name = devpodName.trim()
  const reg = region.trim()
  if (!name || !reg) throw new Error('devpodStart requires devpodName and region')
  await postMinionApi('devpodStart', { devpodName: name, region: reg }, { timeoutMs: 45_000 })
}
