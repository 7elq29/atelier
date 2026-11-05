/**
 * Shared types for the org-wide AI harness-pool spend indicator (ported from
 * Morpheus's cost-spend-status feature). Global, not per-session — kept
 * dependency-free so both main and renderer can import them, same convention
 * as session-types.ts / panel-types.ts.
 */

export interface HarnessSpendBreakdown {
  harness: string
  spent: number
  cap?: number | null
}

export interface SpendStatus {
  email: string
  spent: number
  cap: number | null
  currency: 'USD'
  updatedAt: number
  harnesses: HarnessSpendBreakdown[]
}

/**
 * Renderer-facing snapshot for the sidebar chip.
 * - `ready` — bars + “view usage”
 * - `needs_usso` — auth expired/missing; show Renew USSO (no auto tab storm)
 * - `unavailable` — disabled / offline / other non-auth failure; hide chip
 */
export type SpendStatusSnapshot =
  | { state: 'ready'; data: SpendStatus }
  | { state: 'needs_usso' }
  | { state: 'unavailable' }
