/** SDK `getContextUsage()` fields that define the compaction cap for the UI bar. */
export type ContextUsageCapSource = {
  autoCompactThreshold?: number
  maxTokens?: number
}

/**
 * Context tokens at which auto-compaction fires. Prefer `autoCompactThreshold`
 * when the SDK provides it; otherwise `maxTokens` (effective window, smaller
 * than `rawMaxTokens`). Never use `rawMaxTokens` — that is the model's full
 * theoretical window, not when compaction runs.
 */
export function resolveContextCompactThreshold(source: ContextUsageCapSource): number | null {
  const cap = source.autoCompactThreshold ?? source.maxTokens
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return null
  return cap
}
