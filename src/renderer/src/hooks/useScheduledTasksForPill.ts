/**
 * Lightweight read-only hook that tracks today's scheduled (day-plan + timeBlock)
 * tasks for the topbar timeline pill. Uses the same IPC primitives as useDailyNote
 * but skips all write/debounce/mutation machinery.
 *
 * Key design: `date` is null while the panel is closed (App.tsx clears it on close).
 * To keep the pill showing after the panel closes, the hook remembers the last
 * non-null date via a ref and continues using it when `date` becomes null.
 */
import { useState, useEffect, useRef } from 'react'
import type { DailyTask } from '../../../shared/daily-note-types'

function isScheduled(t: DailyTask): boolean {
  return t.section === 'day-plan' && !!t.timeBlock
}

function localToday(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export function useScheduledTasksForPill(date: string | null): DailyTask[] {
  // Persist the last non-null date so the pill stays populated after panel closes.
  // Seed with today so tasks load on mount even if the panel was never opened.
  const lastDateRef = useRef<string | null>(localToday())
  if (date !== null) lastDateRef.current = date
  const effectiveDate = date ?? lastDateRef.current

  const [tasks, setTasks] = useState<DailyTask[]>([])

  useEffect(() => {
    if (!effectiveDate) {
      setTasks([])
      return
    }

    // Initial load
    void window.atelier.readDailyNote(effectiveDate).then((result) => {
      setTasks((result.note?.tasks ?? []).filter(isScheduled))
    })

    // Live updates when the file changes externally (or via the open panel)
    const unsub = window.atelier.onDailyNoteChanged((note) => {
      if (note.date === effectiveDate) {
        setTasks(note.tasks.filter(isScheduled))
      }
    })

    return unsub
  }, [effectiveDate])

  return tasks
}
