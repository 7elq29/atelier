/**
 * Model picker rows derived from `@anthropic-ai/claude-agent-sdk`'s hand-maintained
 * model catalog (`sdk.mjs` — schema_version 1).
 *
 * Context badges reflect what each wire id actually runs with:
 * - `supports_1m_suffix` models get a standard row plus a `[1m]` row (Haiku, Opus 4.8).
 * - Native-1M-only models (Sonnet 5, Fable, Mythos) show the effective ~400k tier
 *   (`getContextUsage().maxTokens`), not a misleading "1M" label on a single id.
 */

export interface ModelPickerOption {
  /** Wire id passed to the harness (`Query.setModel()` / `HarnessStartOptions.model`). */
  id: string
  /** Short family label, e.g. "Opus 4.8". */
  displayName: string
  /** Right-aligned context badge in the picker, e.g. "200k", "400k", or "1M". */
  contextLabel: string
}

/** Effective maxTokens tier for native-1M models without a separate `[1m]` row. */
const NATIVE_1M_EFFECTIVE_WINDOW = 400_000

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return '1M'
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/**
 * Verified against SDK catalog `latest_per_family` + `claude-mythos-5`.
 * Opus 4.8 includes `[1m]` because the catalog sets `supports_1m_suffix` even
 * though it is also `native_1m` — the bare id runs the standard tier (~200k);
 * `[1m]` selects the full 1M context window.
 */
const CATALOG_ENTRIES: Array<{ id: string; displayName: string; contextWindow: number }> = [
  { id: 'claude-opus-4-8', displayName: 'Opus 4.8', contextWindow: 200_000 },
  { id: 'claude-opus-4-8[1m]', displayName: 'Opus 4.8', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5', displayName: 'Sonnet 5', contextWindow: NATIVE_1M_EFFECTIVE_WINDOW },
  { id: 'claude-haiku-4-5', displayName: 'Haiku 4.5', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5[1m]', displayName: 'Haiku 4.5', contextWindow: 1_000_000 },
  { id: 'claude-fable-5', displayName: 'Fable 5', contextWindow: NATIVE_1M_EFFECTIVE_WINDOW },
  { id: 'claude-mythos-5', displayName: 'Mythos 5', contextWindow: NATIVE_1M_EFFECTIVE_WINDOW }
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
  return DISPLAY_BY_ID.get(modelId) ?? modelId.replace(/\[1m\]$/, '')
}
