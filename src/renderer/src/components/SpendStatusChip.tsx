import { useEffect, useState } from 'react'
import type { HarnessSpendBreakdown, SpendStatus } from '../../../shared/spend-status-types'

const POLL_MS = 5 * 60 * 1000

function insightsUrl(): string {
  const now = new Date()
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  return `https://eng-insights.uberinternal.com/ai-insights/individual/cost?granularity=monthly&period=${period}`
}

function formatSpent(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatTooltip(data: SpendStatus): string {
  if (data.harnesses.length === 0) return `Harness pool spend for ${data.email}`
  return data.harnesses
    .map(
      (item: HarnessSpendBreakdown) =>
        `${item.harness}: $${item.spent.toFixed(2)}${item.cap == null ? '' : `/$${Math.round(item.cap)}`}`
    )
    .join('\n')
}

/**
 * Org-wide AI harness-pool spend chip, ported from Morpheus's
 * `CostSpendIndicator.tsx`. Polls the main process every 5 minutes and
 * renders nothing if the fetch fails (missing `usso`, offline, disabled).
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

  const cortana = data.harnesses.find((h) => h.harness === 'Cortana')

  return (
    <div className="spend-indicator" data-testid="spend-status-chip" title={formatTooltip(data)}>
      <div className="spend-indicator-row1">
        <svg
          className="spend-indicator-icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
        </svg>
        <b>{formatSpent(data.spent)}{data.cap != null ? ` / $${Math.round(data.cap).toLocaleString()}` : ''}</b>
      </div>
      <div className="spend-indicator-row2">
        spent this month ·{' '}
        <button
          type="button"
          className="spend-indicator-link"
          onClick={() => void window.atelier.openExternal(insightsUrl())}
          aria-label={`AI spend ${formatSpent(data.spent)}, view usage`}
        >
          view usage
        </button>
      </div>
      {cortana && (
        <div className="spend-indicator-cortana">
          Cortana {formatSpent(cortana.spent)}{cortana.cap != null ? ` / $${Math.round(cortana.cap).toLocaleString()}` : ''}
        </div>
      )}
    </div>
  )
}

