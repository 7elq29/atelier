/**
 * Minion web scratch APIs (listScratchFiles / getFileContents).
 *
 * Auth/transport: shared Minion HTTP client (USSO + `/api/…`).
 */

import { logger } from '../logger'
import { MINION_HTTP_TIMEOUT_MS, postMinionApi } from './minion-http-client'

/** Bound scratch HTTP so a hung getFileContents cannot stall gettask polling. */
export const SCRATCH_FETCH_TIMEOUT_MS = MINION_HTTP_TIMEOUT_MS

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
  const res = await postMinionApi(
    'listScratchFiles',
    {
      taskId: target.taskId,
      devpodName: target.devpodName,
      region: target.region
    },
    { timeoutMs: SCRATCH_FETCH_TIMEOUT_MS }
  )
  const data = (res.data && typeof res.data === 'object' ? res.data : res) as Record<string, unknown>
  const entries = (data.entries ?? data.files ?? []) as Array<Record<string, unknown>>
  return entries
    .map((e) => ({
      path: String(e.path ?? e.name ?? ''),
      type: typeof e.type === 'string' ? e.type : undefined,
      sizeBytes: asFiniteNumber(e.sizeBytes ?? e.size),
      modifiedTimeUnix: asFiniteNumber(e.modifiedTimeUnix ?? e.mtime)
    }))
    .filter((e) => e.path)
}

export async function getFileContents(target: DevpodScratchTarget, path: string): Promise<string> {
  const res = await postMinionApi(
    'getFileContents',
    {
      taskId: target.taskId,
      devpodName: target.devpodName,
      region: target.region,
      path
    },
    { timeoutMs: SCRATCH_FETCH_TIMEOUT_MS }
  )
  const data = (res.data && typeof res.data === 'object' ? res.data : res) as Record<string, unknown>
  const content = data.content
  if (typeof content !== 'string') {
    logger.warn('minionScratch: getFileContents missing content', { path, keys: Object.keys(data) })
    return ''
  }
  return content
}
