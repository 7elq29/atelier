import { useEffect, useState } from 'react'
import type { HarnessSpendBreakdown, SpendStatus } from '../../../shared/spend-status-types'

const POLL_MS = 5 * 60 * 1000

function insightsUrl(): string {
  const now = new Date()
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
  return `https://eng-insights.uberinternal.com/ai-insights/individual/cost?granularity=monthly&period=${period}`
}

function fmt(value: number): string {
  // Drop cents when >= $100 to save space
  if (value >= 100) return `$${Math.round(value).toLocaleString()}`
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtCap(value: number): string {
  return `$${Math.round(value).toLocaleString()}`
}

function barColor(pct: number): string {
  if (pct >= 0.95) return 'var(--error, #e06c75)'
  if (pct >= 0.80) return 'var(--warning, #e5b75a)'
  return 'var(--accent)'
}

function SpendBar({
  label,
  spent,
  cap,
  color
}: {
  label: string
  spent: number
  cap: number | null | undefined
  color: string
}): JSX.Element {
  const pct = cap ? Math.min(spent / cap, 1) : 0
  const barFill = barColor(pct)
  return (
    <div className="spend-bar-block">
      <div className="spend-bar-header">
        <span className="spend-bar-label" style={{ color }}>{label}</span>
        <span className="spend-bar-amount">
          {fmt(spent)}{cap != null ? <> / <span className="spend-bar-cap">{fmtCap(cap)}</span></> : null}
        </span>
      </div>
      {cap != null && (
        <div className="spend-bar-track">
          <div
            className="spend-bar-fill"
            style={{ width: `${pct * 100}%`, background: barFill }}
          />
        </div>
      )}
    </div>
  )
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
 * Org-wide AI harness-pool spend chip. Shows a progress bar for Claude Code
 * (main pool) and, when present, a second bar for Cortana.
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
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  if (!data) return null

  const cortana = data.harnesses.find((h) => h.harness === 'Cortana')

  return (
    <div className="spend-indicator" data-testid="spend-status-chip" title={formatTooltip(data)}>
      <SpendBar
        label="Claude Code"
        spent={data.spent}
        cap={data.cap}
        color="var(--accent)"
      />
      {cortana && (
        <SpendBar
          label="Cortana"
          spent={cortana.spent}
          cap={cortana.cap}
          color="var(--sc-purple)"
        />
      )}
      <div className="spend-indicator-footer">
        this month ·{' '}
        <button
          type="button"
          className="spend-indicator-link"
          onClick={() => void window.atelier.openExternal(insightsUrl())}
          aria-label={`AI spend ${fmt(data.spent)}, view usage`}
        >
          view usage
        </button>
      </div>
    </div>
  )
}
