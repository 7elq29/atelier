/**
 * Serializes workspace preloads per devpod host so one session's git/file SSH
 * storm does not saturate the shared mux and stall unrelated sessions on that host.
 */
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
