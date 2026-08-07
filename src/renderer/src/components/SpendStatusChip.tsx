import { useEffect, useState } from 'react'
import type { HarnessSpendBreakdown, SpendStatus } from '../../../shared/spend-status-types'

const POLL_MS = 5 * 60 * 1000
const COST_INSIGHTS_URL = 'https://eng-insights.uberinternal.com/ai-insights/individual/cost'

function formatWholeDollars(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

function formatLabel(data: SpendStatus): string {
  const spent = formatWholeDollars(data.spent)
  const cap = data.cap == null ? '?' : formatWholeDollars(data.cap)
  return `${spent}/${cap}`
}

function formatTooltip(data: SpendStatus): string {
  if (data.harnesses.length === 0) return `Harness pool spend for ${data.email}`
  return data.harnesses
    .map(
      (item: HarnessSpendBreakdown) =>
        `${item.harness}: ${formatWholeDollars(item.spent)}${item.cap == null ? '' : `/${formatWholeDollars(item.cap)}`}`
    )
    .join('\n')
}

/**
 * Org-wide AI harness-pool spend chip, ported from Morpheus's
 * `CostSpendIndicator.tsx`. Polls the main process every 5 minutes and
 * renders nothing if the fetch fails (missing `usso`, offline, disabled) —
 * this is a "nice to have" sidebar indicator, not something that should
 * ever show an error state to the user.
 */
export default function SpendStatusChip(): JSX.Element | null {
  const [data, setData] = useState<SpendStatus | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = (): void => {
      void window.gardenia.getSpendStatus().then((next) => {
        if (!cancelled) setData(next)
      })
    }

    load()
    const interval = setInterval(load, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  if (!data) return null

  return (
    <div className="spend-indicator" data-testid="spend-status-chip" title={formatTooltip(data)}>
      <svg
        className="spend-indicator-icon"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <line x1="2" y1="10" x2="22" y2="10" />
      </svg>
      <b>{formatLabel(data)}</b> spent ·{' '}
      <button
        type="button"
        className="spend-indicator-link"
        onClick={() => void window.gardenia.openExternal(COST_INSIGHTS_URL)}
        aria-label={`AI spend ${formatLabel(data)}, view usage`}
      >
        view usage
      </button>
    </div>
  )
}
