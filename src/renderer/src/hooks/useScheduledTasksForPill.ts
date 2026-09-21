/**
 * Lightweight read-only hook that tracks today's scheduled (day-plan + timeBlock)
 * tasks for the topbar timeline pill. Uses the same IPC primitives as useDailyNote
 * but skips all write/debounce/mutation machinery.
 */
import { useState, useEffect } from 'react'
import type { DailyTask } from '../../../shared/daily-note-types'

function isScheduled(t: DailyTask): boolean {
  return t.section === 'day-plan' && !!t.timeBlock
}

export function useScheduledTasksForPill(date: string | null): DailyTask[] {
  const [tasks, setTasks] = useState<DailyTask[]>([])

  useEffect(() => {
    if (!date) {
      setTasks([])
      return
    }

    // Initial load
    void window.atelier.readDailyNote(date).then((result) => {
      setTasks((result.note?.tasks ?? []).filter(isScheduled))
    })

    // Live updates when the file changes externally (or via the open panel)
    const unsub = window.atelier.onDailyNoteChanged((note) => {
      if (note.date === date) {
        setTasks(note.tasks.filter(isScheduled))
      }
    })

    return unsub
  }, [date])

  return tasks
}
