import { useState, useEffect, useCallback, useRef } from 'react'
import type { DailyTask, DailyNote, TaskSection } from '../../../shared/daily-note-types'

const WRITE_DEBOUNCE_MS = 500

export interface UseDailyNoteResult {
  note: DailyNote | null
  loading: boolean
  exists: boolean
  vaultConfigured: boolean
  createNote: () => void
  updateTask: (id: string, patch: Partial<DailyTask>) => void
  toggleTask: (id: string) => void
  addTask: (text: string, section: TaskSection, timeBlock?: string) => void
  deleteTask: (id: string) => void
  moveTask: (id: string, section: 'day-plan' | 'unscheduled', timeBlock?: string) => void
}

/**
 * Loads and syncs a single day's daily note.
 *
 * Unlike Playground's equivalent hook, task ids here are stable UUIDs
 * (`gid`, see shared/daily-note-types.ts + main/daily-note-io.ts) rather than
 * line-number-derived, so no id-reconciliation pass is needed across
 * re-parses — the same id always refers to the same task, even across a
 * watcher-triggered reparse that lands mid-interaction.
 *
 * The tombstone diff that prevents deleted tasks from resurrecting lives in
 * the main process (daily-notes-handlers.ts), applied on every write. This
 * hook still cancels a pending debounced write when an external change
 * arrives, purely to avoid a stale in-memory edit flashing back onto screen
 * before the next write reconciles it — not required for correctness of the
 * delete-doesn't-resurrect guarantee itself.
 */
export function useDailyNote(date: string): UseDailyNoteResult {
  const [note, setNote] = useState<DailyNote | null>(null)
  const [loading, setLoading] = useState(true)
  const [exists, setExists] = useState(false)
  const [vaultConfigured, setVaultConfigured] = useState(true)
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    window.gardenia.getVaultRoot().then((root) => {
      if (!cancelled) setVaultConfigured(root !== null)
    })

    window.gardenia
      .readDailyNote(date)
      .then((result) => {
        if (cancelled) return
        setNote(result.note)
        setExists(result.exists)
        setLoading(false)
      })
      .catch(() => {
        if (!cancelled) setLoading(false)
      })

    window.gardenia.watchDailyNote(date).catch(() => {})
    const unsub = window.gardenia.onDailyNoteChanged((updatedNote) => {
      if (cancelled) return
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current)
        writeTimerRef.current = null
      }
      setNote(updatedNote)
      setExists(true)
    })

    return () => {
      cancelled = true
      window.gardenia.unwatchDailyNote().catch(() => {})
      unsub()
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    }
  }, [date])

  const createNote = useCallback(() => {
    window.gardenia.createDailyNote(date).then((result) => {
      setNote(result.note)
      setExists(true)
      window.gardenia.watchDailyNote(date).catch(() => {})
    })
  }, [date])

  const scheduleWrite = useCallback(
    (updatedNote: DailyNote) => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
      writeTimerRef.current = setTimeout(() => {
        window.gardenia.writeDailyNote(date, updatedNote).catch(() => {})
      }, WRITE_DEBOUNCE_MS)
    },
    [date]
  )

  const mutate = useCallback(
    (fn: (prev: DailyNote) => DailyNote) => {
      setNote((prev) => {
        if (!prev) return prev
        const updated = fn(prev)
        scheduleWrite(updated)
        return updated
      })
    },
    [scheduleWrite]
  )

  const updateTask = useCallback(
    (id: string, patch: Partial<DailyTask>) =>
      mutate((prev) => ({ ...prev, tasks: prev.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
    [mutate]
  )

  const toggleTask = useCallback(
    (id: string) =>
      mutate((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) => {
          if (t.id !== id) return t
          const nextStatus = t.status === 'done' ? ('open' as const) : ('done' as const)
          return { ...t, status: nextStatus, completion: nextStatus === 'done' ? date : undefined }
        })
      })),
    [date, mutate]
  )

  const addTask = useCallback(
    (text: string, section: TaskSection, timeBlock?: string) =>
      mutate((prev) => {
        const gid = crypto.randomUUID()
        const newTask: DailyTask = {
          id: gid,
          gid,
          text,
          status: 'open',
          section,
          tags: section === 'tracker' ? ['#tracker'] : [],
          externalLinks: [],
          isTracker: section === 'tracker',
          isNote: false,
          ...(timeBlock ? { timeBlock } : {})
        }
        return { ...prev, tasks: [...prev.tasks, newTask] }
      }),
    [mutate]
  )

  const deleteTask = useCallback(
    (id: string) => mutate((prev) => ({ ...prev, tasks: prev.tasks.filter((t) => t.id !== id) })),
    [mutate]
  )

  const moveTask = useCallback(
    (id: string, section: 'day-plan' | 'unscheduled', timeBlock?: string) =>
      mutate((prev) => ({
        ...prev,
        tasks: prev.tasks.map((t) => (t.id === id ? { ...t, section, timeBlock } : t))
      })),
    [mutate]
  )

  return { note, loading, exists, vaultConfigured, createNote, updateTask, toggleTask, addTask, deleteTask, moveTask }
}
