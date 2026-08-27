/** SDK `getContextUsage()` fields used for the composer token-usage bar. */
export type ContextUsageCapSource = {
  autoCompactThreshold?: number
  maxTokens?: number
  rawMaxTokens?: number
}

/**
 * Effective context window for the token-usage bar (`maxTokens` from the SDK).
 * This is the usable in-context budget the model is actually running with —
 * e.g. ~400k on native-1M models, ~200k on standard-tier ids — not the
 * auto-compaction trigger (~167k on a 200k session) and not `rawMaxTokens`
 * (theoretical catalog max).
 */
export function resolveContextWindowForDisplay(source: ContextUsageCapSource): number | null {
  const cap = source.maxTokens
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return null
  return cap
}

/**
 * Context tokens at which auto-compaction fires. Prefer `autoCompactThreshold`
 * when the SDK provides it; otherwise `maxTokens`. Used only when a caller
 * needs the compact trigger explicitly — not for the composer usage bar.
 */
export function resolveContextCompactThreshold(source: ContextUsageCapSource): number | null {
  const cap = source.autoCompactThreshold ?? source.maxTokens
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return null
  return cap
}
