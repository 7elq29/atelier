/**
 * Fallback model picker rows used only before the session’s live SDK
 * `initializationResult().models` arrives. Once live models are present,
 * `resolveModelPickerOptions` uses that list exclusively (same source as
 * Claude Code’s `/model` command).
 *
 * Keep this aligned with a typical `/model` menu shape (aliases + fable wire
 * id). Do not reintroduce superseded generation ids here — they rot.
 */

export interface ModelPickerOption {
  /** Wire id / alias passed to the harness (`Query.setModel()` / start options). */
  id: string
  /** Short label, e.g. "Opus". */
  displayName: string
  /** Right-aligned context badge when known, e.g. "200k", "400k", or "1M". */
  contextLabel: string
}

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return '1M'
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}k`
  return String(tokens)
}

/** Pre-init fallback — mirrors current SDK `/model` values (not a generation catalog). */
const FALLBACK_ENTRIES: Array<{ id: string; displayName: string; contextWindow?: number }> = [
  { id: 'default', displayName: 'Default (recommended)' },
  { id: 'opus', displayName: 'Opus' },
  { id: 'claude-fable-5[1m]', displayName: 'Fable', contextWindow: 1_000_000 },
  { id: 'sonnet', displayName: 'Sonnet' },
  { id: 'haiku', displayName: 'Haiku' }
]

const CONTEXT_BY_ID = new Map(
  FALLBACK_ENTRIES.filter((e) => e.contextWindow != null).map((e) => [e.id, e.contextWindow as number])
)
const DISPLAY_BY_ID = new Map(FALLBACK_ENTRIES.map((e) => [e.id, e.displayName]))

/** Fallback picker rows when the live SDK model list has not arrived yet. */
export function defaultModelPickerOptions(): ModelPickerOption[] {
  return FALLBACK_ENTRIES.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    contextLabel: entry.contextWindow != null ? formatContextWindow(entry.contextWindow) : ''
  }))
}

export function contextLabelForModelId(modelId: string): string | undefined {
  const window = CONTEXT_BY_ID.get(modelId)
  return window != null ? formatContextWindow(window) : undefined
}

export function displayNameForModelId(modelId: string): string {
  return DISPLAY_BY_ID.get(modelId) ?? modelId.replace(/\[1m\]$/, '')
}
