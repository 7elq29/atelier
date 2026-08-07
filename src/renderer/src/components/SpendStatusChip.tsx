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
      void window.atelier.getSpendStatus().then((next) => {
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
    <button
      type="button"
      className="spend-status-chip"
      data-testid="spend-status-chip"
      onClick={() => void window.atelier.openExternal(COST_INSIGHTS_URL)}
      title={formatTooltip(data)}
      aria-label={`AI spend ${formatLabel(data)}`}
    >
      {formatLabel(data)}
    </button>
  )
}
