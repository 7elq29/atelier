/**
 * Serializes workspace preloads and background remote work per devpod host so
 * one session's git/file SSH storm does not saturate the shared mux and stall
 * unrelated sessions on that host.
 */
import type { SessionChangesCap } from '../../shared/session-changes-cap'

const hostPreloadTails = new Map<string, Promise<void>>()

export function withRemotePreloadHostQueue<T>(
  hostname: string | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!hostname) return fn()

  const prev = hostPreloadTails.get(hostname) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  hostPreloadTails.set(
    hostname,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

/** Background git/cap refresh — serialized per host alongside preload, not in parallel with it. */
const hostBackgroundWorkTails = new Map<string, Promise<void>>()

export function withRemoteBackgroundHostQueue<T>(
  hostname: string | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!hostname) return fn()

  const prev = hostBackgroundWorkTails.get(hostname) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  hostBackgroundWorkTails.set(
    hostname,
    run.then(
      () => undefined,
      () => undefined
    )
  )
  return run
}

/** At most one cap rebuild per session; overlapping callers share the in-flight result. */
const capRebuildInFlight = new Map<string, Promise<SessionChangesCap>>()

export function coalesceSessionCapRebuild(
  sessionId: string,
  fn: () => Promise<SessionChangesCap>
): Promise<SessionChangesCap> {
  const existing = capRebuildInFlight.get(sessionId)
  if (existing) return existing

  const run = fn().finally(() => {
    if (capRebuildInFlight.get(sessionId) === run) {
      capRebuildInFlight.delete(sessionId)
    }
  })
  capRebuildInFlight.set(sessionId, run)
  return run
}

/** Stagger harness reconnect starts on the same host (startupReconnect). */
const hostStartupReconnectTails = new Map<string, Promise<void>>()

export function scheduleHostStartupReconnect(
  hostname: string | null | undefined,
  staggerMs: number,
  fn: () => Promise<void>
): void {
  const key = hostname ?? '__local__'
  const prev = hostStartupReconnectTails.get(key) ?? Promise.resolve()
  const next = prev
    .catch(() => undefined)
    .then(async () => {
      if (staggerMs > 0) await new Promise((r) => setTimeout(r, staggerMs))
      await fn()
    })
  hostStartupReconnectTails.set(
    key,
    next.then(
      () => undefined,
      () => undefined
    )
  )
}
