/**
 * Inline "now" divider row for the Timeline list. Rendered by Timeline.tsx
 * as a plain flow item, spliced in between the two time-blocks that
 * chronologically bracket the current time — matching the mock's
 * `.timeline-now-marker` (a small accent-colored label followed by a
 * horizontal rule via `::after`), not an absolutely-positioned overlay line
 * on a grid.
 */
interface CurrentTimeMarkerProps {
  minutes: number
}

export default function CurrentTimeMarker({ minutes }: CurrentTimeMarkerProps): JSX.Element {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')

  return (
    <div className="dn-timeline-now-marker" data-testid="current-time-line" data-minutes={minutes}>
      <span className="dn-now-dot">●</span>
      <span>{`${hh}:${mm} now`}</span>
    </div>
  )
}
