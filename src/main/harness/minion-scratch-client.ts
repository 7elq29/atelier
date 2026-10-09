/**
 * Minion web scratch APIs (listScratchFiles / getFileContents).
 *
 * Auth matches the Minion SPA: USSO Basic (`:token`) + `x-csrf-token: x`.
 * Used only for the Working/tool timeline in chat.jsonl — orchestrator CRUD
 * stays on aifx MCP.
 */

import { execFile } from 'node:child_process'
import { logger } from '../logger'
import { findUsso } from '../uber-auth'
import { subprocessEnvWithDevPath } from '../shell-path'

const BASE = 'https://minion.uberinternal.com'
const TOKEN_TTL_MS = 50 * 60 * 1000
/** Bound scratch HTTP so a hung getFileContents cannot stall gettask polling. */
export const SCRATCH_FETCH_TIMEOUT_MS = 60_000

let cachedToken: { value: string; expiresAt: number } | null = null

export interface ScratchFileEntry {
  path: string
  type?: string
  sizeBytes?: number
  modifiedTimeUnix?: number
}

/** Minion often returns numeric fields as JSON strings. */
function asFiniteNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export interface DevpodScratchTarget {
  taskId: string
  devpodName: string
  region: string
}

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

async function postApi(
  endpoint: string,
  body: Record<string, unknown>,
  retry = true
): Promise<Record<string, unknown>> {
  const token = await getToken()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SCRATCH_FETCH_TIMEOUT_MS)
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
      throw new Error(`${endpoint} timed out after ${SCRATCH_FETCH_TIMEOUT_MS}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
  const text = await resp.text()
  if ((resp.status === 401 || resp.status === 403) && retry) {
    cachedToken = null
    return postApi(endpoint, body, false)
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
    const err = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed).slice(0, 200)
    throw new Error(`${endpoint} status=${String(parsed.status)}: ${err}`)
  }
  return parsed
}

/** Pull DevPod name/region from gettask (snake or camel), else runner URL. */
export function extractDevpodTarget(taskId: string, task: Record<string, unknown>): DevpodScratchTarget | null {
  const meta = (task.metadata && typeof task.metadata === 'object'
    ? (task.metadata as Record<string, unknown>)
    : {}) as Record<string, unknown>
  let devpodName = String(
    meta.devpodName ?? meta.devpod_name ?? task.devpodName ?? task.devpod_name ?? ''
  ).trim()
  let region = String(
    meta.devpodRegion ??
      meta.devpod_region ??
      meta.region ??
      task.devpodRegion ??
      task.devpod_region ??
      task.region ??
      ''
  ).trim()
  if (!devpodName || !region) {
    const runnerUrl = String(task.runner_url ?? task.runnerUrl ?? '')
    const m = runnerUrl.match(/devpod\.uberinternal\.com\/([^/?#]+)\/([^/?#]+)/i)
    if (m) {
      region = region || m[1]
      devpodName = devpodName || m[2]
    }
  }
  if (!devpodName || !region) return null
  return { taskId, devpodName, region }
}

export async function listScratchFiles(target: DevpodScratchTarget): Promise<ScratchFileEntry[]> {
  const res = await postApi('listScratchFiles', {
    taskId: target.taskId,
    devpodName: target.devpodName,
    region: target.region
  })
  const data = (res.data && typeof res.data === 'object' ? res.data : res) as Record<string, unknown>
  const entries = (data.entries ?? data.files ?? []) as Array<Record<string, unknown>>
  return entries.map((e) => ({
    path: String(e.path ?? e.name ?? ''),
    type: typeof e.type === 'string' ? e.type : undefined,
    sizeBytes: asFiniteNumber(e.sizeBytes ?? e.size),
    modifiedTimeUnix: asFiniteNumber(e.modifiedTimeUnix ?? e.mtime)
  })).filter((e) => e.path)
}

export async function getFileContents(target: DevpodScratchTarget, path: string): Promise<string> {
  const res = await postApi('getFileContents', {
    taskId: target.taskId,
    devpodName: target.devpodName,
    region: target.region,
    path
  })
  const data = (res.data && typeof res.data === 'object' ? res.data : res) as Record<string, unknown>
  const content = data.content
  if (typeof content !== 'string') {
    logger.warn('minionScratch: getFileContents missing content', { path, keys: Object.keys(data) })
    return ''
  }
  return content
}
