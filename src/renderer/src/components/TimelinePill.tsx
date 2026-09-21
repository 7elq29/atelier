/**
 * TimelinePill — the enriched calendar-toggle button shown in the topbar
 * when the daily notes panel is hidden.
 *
 * Shows:
 *  • A calendar icon (same as the plain toggle)
 *  • A 30-slot sparkline (6 am–9 pm in 30-min buckets), colored by task type:
 *      blue  = isNote (meetings / plain-bullet events)
 *      green = !isNote (checkbox tasks)
 *  • The next upcoming task: time + name
 *  • A "+N" remaining count badge
 *
 * Clicking anywhere opens the daily notes panel (same as the plain toggle).
 */
import { useState, useEffect } from 'react'
import type { DailyTask } from '../../../shared/daily-note-types'
import { parseTimeBlock } from './daily-notes/timeline-scale'

// ── Constants ──────────────────────────────────────────────────────────────

/** Sparkline covers 8 am–9 pm (13 hours × 2 = 26 half-hour slots). */
const PILL_START_MIN = 8 * 60   // 480
const PILL_END_MIN   = 21 * 60  // 1260
const SLOT_MIN       = 30
const TOTAL_SLOTS    = (PILL_END_MIN - PILL_START_MIN) / SLOT_MIN // 26

const DONE_STATUSES = new Set(['done', 'cancelled', 'forwarded'])

/** Refresh "now" every 60 s. */
const NOW_POLL_MS = 60_000

function getNowMinutes(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

/** "3:00 PM" */
function formatTime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const h12 = h % 12 || 12
  const ampm = h < 12 ? 'AM' : 'PM'
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`
}

// ── Component ──────────────────────────────────────────────────────────────

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

  // ── Derive sparkline slots ─────────────────────────────────────────────
  // For each 30-min bucket, find the first task that overlaps it.
  const slots = Array.from({ length: TOTAL_SLOTS }, (_, i) => {
    const slotStart = PILL_START_MIN + i * SLOT_MIN
    const slotEnd   = slotStart + SLOT_MIN

    for (const task of tasks) {
      const tb = parseTimeBlock(task.timeBlock)
      if (!tb) continue
      // Overlaps if task starts before slot ends AND ends after slot starts
      if (tb.start < slotEnd && tb.end > slotStart) {
        return task
      }
    }
    return null
  })

  // ── Derive next/current task ───────────────────────────────────────────
  // Show the earliest task whose end time is still in the future — this
  // includes tasks that are currently happening (started but not finished).
  const nextTask = tasks
    .filter((t) => {
      if (DONE_STATUSES.has(t.status)) return false
      const tb = parseTimeBlock(t.timeBlock)
      return tb !== null && tb.end > nowMinutes
    })
    .sort((a, b) => parseTimeBlock(a.timeBlock)!.start - parseTimeBlock(b.timeBlock)!.start)[0] ?? null
  const nextTb = nextTask ? parseTimeBlock(nextTask.timeBlock) : null

  // ── Render ─────────────────────────────────────────────────────────────
  const nowSlot = Math.floor((nowMinutes - PILL_START_MIN) / SLOT_MIN)

  return (
    <button
      type="button"
      className="topbar-pill"
      title="Timeline — click to open"
      aria-label="Open timeline panel"
      data-testid="toggle-daily-notes-panel"
      onClick={onClick}
    >
      {/* Calendar icon — same as plain toggle */}
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

      {/* Sparkline */}
      {tasks.length > 0 && (
        <div className="topbar-pill-sparkline" aria-hidden="true">
          {slots.map((task, i) => {
            const isNowSlot = i === nowSlot
            const isEmpty   = task === null
            const isDone    = task !== null && DONE_STATUSES.has(task.status)
            const isMeeting = task !== null && task.isNote
            const isPast    = task !== null && (() => {
              const tb = parseTimeBlock(task.timeBlock)
              return tb !== null && tb.end <= nowMinutes
            })()

            // Color
            let bg: string
            if (isEmpty || isNowSlot) {
              bg = 'var(--border-default)'
            } else if (isMeeting) {
              bg = 'var(--sc-blue)'
            } else {
              bg = 'var(--sc-green)'
            }

            // Height: 10px for task, 3px for empty, 12px for now-slot
            const height = isNowSlot ? 12 : (isEmpty ? 3 : 10)
            const opacity = (isDone || isPast) && !isNowSlot ? 0.3 : 1

            return (
              <div
                key={i}
                className={`topbar-pill-spark-bar${isNowSlot ? ' topbar-pill-spark-now' : ''}`}
                style={{ background: bg, height, opacity }}
              />
            )
          })}
        </div>
      )}

      {/* Next task */}
      {nextTask && nextTb && (
        <>
          <div className="topbar-pill-divider" aria-hidden="true" />
          <div className="topbar-pill-next">
            <span className="topbar-pill-next-time">{formatTime(nextTb.start)}</span>
            <span className="topbar-pill-next-name">{nextTask.text}</span>
          </div>
        </>
      )}

    </button>
  )
}
