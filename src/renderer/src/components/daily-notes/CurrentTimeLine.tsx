import { TIMELINE_START_HOUR, TIMELINE_END_HOUR, minutesToPx } from './timeline-scale'

/**
 * Absolutely-positioned "now" line overlaid on the Timeline's hour grid
 * (UC-11). Rendered at `top: minutesToPx(minutes - TIMELINE_START_HOUR*60)`
 * inside the grid's `relative` container, only when `minutes` falls within
 * the displayed [TIMELINE_START_HOUR*60, TIMELINE_END_HOUR*60] window —
 * callers should not render this component at all outside that window (see
 * Timeline.tsx).
 */
interface CurrentTimeMarkerProps {
  minutes: number
}

export default function CurrentTimeMarker({ minutes }: CurrentTimeMarkerProps): JSX.Element | null {
  const startMin = TIMELINE_START_HOUR * 60
  const endMin = TIMELINE_END_HOUR * 60
  if (minutes < startMin || minutes > endMin) return null

  const top = minutesToPx(minutes - startMin)
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')

  return (
    <div
      className="dn-timeline-now-line"
      data-testid="current-time-line"
      data-minutes={minutes}
      style={{ top: `${top}px` }}
    >
      <span className="dn-now-dot">●</span>
      <span className="dn-now-label">{`${hh}:${mm}`}</span>
    </div>
  )
}
