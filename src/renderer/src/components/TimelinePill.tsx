import React, { useState, useEffect } from 'react'
import type { DailyTask } from '../../../shared/daily-note-types'
import { parseTimeBlock } from './daily-notes/timeline-scale'

const DONE_STATUSES = new Set(['done', 'cancelled', 'forwarded'])
const NOW_POLL_MS = 60_000

function getNowMinutes(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

// Drop ":00" when on the hour — "2 PM" instead of "2:00 PM"
function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const h12 = h % 12 || 12
  const ampm = h < 12 ? 'AM' : 'PM'
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

interface TimelinePillProps {
  tasks: DailyTask[]
  onClick: () => void
}

export function TimelinePill({ tasks, onClick }: TimelinePillProps): React.JSX.Element {
  const [nowMinutes, setNowMinutes] = useState(getNowMinutes)

  useEffect(() => {
    const id = setInterval(() => setNowMinutes(getNowMinutes()), NOW_POLL_MS)
    return () => clearInterval(id)
  }, [])

  // Next task: earliest checkbox task that hasn't started yet
  const nextTask = tasks
    .filter((t) => {
      if (DONE_STATUSES.has(t.status) || t.isNote) return false
      const tb = parseTimeBlock(t.timeBlock)
      return tb !== null && tb.start > nowMinutes
    })
    .sort((a, b) => parseTimeBlock(a.timeBlock)!.start - parseTimeBlock(b.timeBlock)!.start)[0] ?? null

  // Next meeting: earliest isNote item not yet ended (includes in-progress)
  const nextMeeting = tasks
    .filter((t) => {
      if (DONE_STATUSES.has(t.status) || !t.isNote) return false
      const tb = parseTimeBlock(t.timeBlock)
      return tb !== null && tb.end > nowMinutes
    })
    .sort((a, b) => parseTimeBlock(a.timeBlock)!.start - parseTimeBlock(b.timeBlock)!.start)[0] ?? null

  // Build items in chronological order
  type PillItem = { kind: 'task' | 'meeting'; startMin: number; task: DailyTask }
  const items: PillItem[] = []
  if (nextTask) {
    items.push({ kind: 'task', startMin: parseTimeBlock(nextTask.timeBlock)!.start, task: nextTask })
  }
  if (nextMeeting) {
    items.push({ kind: 'meeting', startMin: parseTimeBlock(nextMeeting.timeBlock)!.start, task: nextMeeting })
  }
  items.sort((a, b) => a.startMin - b.startMin)

  return (
    <button
      type="button"
      className="topbar-pill"
      title="Timeline — click to open"
      aria-label="Open timeline panel"
      data-testid="toggle-daily-notes-panel"
      data-hint-exclude=""
      onClick={onClick}
    >
      <svg
        className="topbar-pill-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>

      {items.length > 0 && (
        <>
          <span className="topbar-pill-divider" aria-hidden="true" />
          {items.map((item, idx) => (
            <React.Fragment key={item.task.id}>
              {idx > 0 && <span className="topbar-pill-divider" aria-hidden="true" />}
              <span className="topbar-pill-item">
                <span
                  className="topbar-pill-item-label"
                  style={{ color: item.kind === 'task' ? 'var(--sc-green)' : 'var(--sc-blue)' }}
                >
                  {item.kind === 'task' ? 'next' : 'mtg'}
                </span>
                <span className="topbar-pill-item-time">{formatTime(item.startMin)}</span>
                {item.kind === 'meeting' && (
                  <span className="topbar-pill-item-name">{item.task.text}</span>
                )}
              </span>
            </React.Fragment>
          ))}
        </>
      )}
    </button>
  )
}
