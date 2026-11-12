import { useCallback, useEffect, useState } from 'react'
import type {
  HarnessSpendBreakdown,
  SpendStatus,
  SpendStatusSnapshot
} from '../../../shared/spend-status-types'

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

function SpendBar({
  label,
  spent,
  cap
}: {
  label: string
  spent: number
  cap: number | null | undefined
}): JSX.Element {
  const pct = cap ? Math.min(spent / cap, 1) : 0
  return (
    <div className="spend-bar-block">
      <div className="spend-bar-header">
        <span className="spend-bar-label">{label}</span>
        <span className="spend-bar-amount">
          {fmt(spent)}{cap != null ? <> / <span className="spend-bar-cap">{fmtCap(cap)}</span></> : null}
        </span>
      </div>
      {cap != null && (
        <div className="spend-bar-track">
          <div className="spend-bar-fill" style={{ width: `${pct * 100}%` }} />
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

/** Sidebar display order for named product pools (Claude Code is the main bar). */
const NAMED_BAR_ORDER = ['Cortana', 'Minion', 'Cursor'] as const

/**
 * Org-wide AI spend chip. Claude Code = harness-pool total; Cortana / Minion /
 * Cursor render as extra bars when their spendstatus endpoints return data.
 * When USSO is expired, shows a Renew USSO link instead of endless browser tabs.
 */
export default function SpendStatusChip(): JSX.Element | null {
  const [snap, setSnap] = useState<SpendStatusSnapshot | null>(null)
  const [renewing, setRenewing] = useState(false)

  const load = useCallback((): void => {
    void window.atelier.getSpendStatus().then((next) => {
      setSnap(next)
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const tick = (): void => {
      void window.atelier.getSpendStatus().then((next) => {
        if (!cancelled) setSnap(next)
      })
    }
    tick()
    const interval = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  const onRenew = useCallback((): void => {
    if (renewing) return
    setRenewing(true)
    void window.atelier
      .renewSpendStatusUsso()
      .then((result) => {
        if (result.ok) load()
        else load()
      })
      .finally(() => setRenewing(false))
  }, [load, renewing])

  if (!snap || snap.state === 'unavailable') return null

  if (snap.state === 'needs_usso') {
    return (
      <div className="spend-indicator" data-testid="spend-status-chip" data-spend-state="needs_usso">
        <div className="spend-bar-block">
          <div className="spend-bar-header">
            <span className="spend-bar-label">Claude Code</span>
            <span className="spend-bar-amount">—</span>
          </div>
        </div>
        <div className="spend-bar-block">
          <div className="spend-bar-header">
            <span className="spend-bar-label">Cortana</span>
            <span className="spend-bar-amount">—</span>
          </div>
        </div>
        <div className="spend-indicator-footer">
          USSO expired ·{' '}
          <button
            type="button"
            className="spend-indicator-link"
            data-testid="spend-status-renew-usso"
            onClick={onRenew}
            disabled={renewing}
            aria-label="Renew USSO"
          >
            {renewing ? 'Renewing…' : 'Renew USSO'}
          </button>
        </div>
      </div>
    )
  }

  const data = snap.data
  const namedBars = NAMED_BAR_ORDER.flatMap((label) => {
    const entry = data.harnesses.find((h) => h.harness === label)
    return entry ? [{ label, spent: entry.spent, cap: entry.cap }] : []
  })

  return (
    <div
      className="spend-indicator"
      data-testid="spend-status-chip"
      data-spend-state="ready"
      title={formatTooltip(data)}
    >
      <SpendBar label="Claude Code" spent={data.spent} cap={data.cap} />
      {namedBars.map((bar) => (
        <SpendBar key={bar.label} label={bar.label} spent={bar.spent} cap={bar.cap} />
      ))}
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
