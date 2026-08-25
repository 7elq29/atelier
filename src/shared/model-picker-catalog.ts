/**
 * Model picker rows derived from `@anthropic-ai/claude-agent-sdk`'s hand-maintained
 * model catalog (`sdk.mjs` — schema_version 1). Each latest-per-family entry gets
 * its native context window; models with `supports_1m_suffix` also get a `[1m]` row.
 */

export interface ModelPickerOption {
  /** Wire id passed to the harness (`Query.setModel()` / `HarnessStartOptions.model`). */
  id: string
  /** Short family label, e.g. "Opus 4.8". */
  displayName: string
  /** Right-aligned context badge in the picker, e.g. "200k" or "1M". */
  contextLabel: string
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return '1M'
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/** Verified against SDK catalog `latest_per_family` + `claude-mythos-5`. */
const CATALOG_ENTRIES: Array<{ id: string; displayName: string; contextWindow: number }> = [
  { id: 'claude-opus-4-8', displayName: 'Opus 4.8', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5', displayName: 'Sonnet 5', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5[1m]', displayName: 'Haiku 4.5', contextWindow: 1_000_000 },
  { id: 'claude-fable-5', displayName: 'Fable 5', contextWindow: 1_000_000 },
  { id: 'claude-mythos-5', displayName: 'Mythos 5', contextWindow: 1_000_000 }
]

const CONTEXT_BY_ID = new Map(CATALOG_ENTRIES.map((e) => [e.id, e.contextWindow]))
const DISPLAY_BY_ID = new Map(CATALOG_ENTRIES.map((e) => [e.id, e.displayName]))

/** Fallback picker rows when the live SDK model list has not arrived yet. */
export function defaultModelPickerOptions(): ModelPickerOption[] {
  return CATALOG_ENTRIES.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    contextLabel: formatContextWindow(entry.contextWindow)
  }))
}

export function contextLabelForModelId(modelId: string): string | undefined {
  const window = CONTEXT_BY_ID.get(modelId)
  return window != null ? formatContextWindow(window) : undefined
}

export function displayNameForModelId(modelId: string): string {
  return DISPLAY_BY_ID.get(modelId) ?? modelId
}
