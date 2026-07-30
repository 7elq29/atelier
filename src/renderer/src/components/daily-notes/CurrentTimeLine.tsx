/**
 * Live "now" indicator for the Timeline. Renders a horizontal line + label
 * positioned by minutes-since-DAY_START_MIN, matching the pixel-per-minute
 * scale Timeline.tsx uses to place time-blocks. Re-renders every 30s so the
 * line visibly moves without needing a full note reload.
 */
import { useEffect, useState } from 'react'
import { DAY_START_MIN, DAY_END_MIN, PX_PER_MIN } from './timeline-scale'

function minutesNow(): number {
  const now = new Date()
  return now.getHours() * 60 + now.getMinutes()
}

export default function CurrentTimeLine(): JSX.Element | null {
  const [minutes, setMinutes] = useState(() => minutesNow())

  useEffect(() => {
    const interval = setInterval(() => setMinutes(minutesNow()), 30_000)
    return () => clearInterval(interval)
  }, [])

  if (minutes < DAY_START_MIN || minutes > DAY_END_MIN) return null

  const top = (minutes - DAY_START_MIN) * PX_PER_MIN
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')

  return (
    <div
      className="dn-current-time-line"
      data-testid="current-time-line"
      data-minutes={minutes}
      style={{ top: `${top}px` }}
    >
      <span className="dn-current-time-label">{`${hh}:${mm}`}</span>
      <div className="dn-current-time-track" />
    </div>
  )
}
