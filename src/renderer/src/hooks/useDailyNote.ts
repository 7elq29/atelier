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
  /** 16-task-move-to-date: cross-file move — sends the task to `targetDate`'s note's Backlog, unlike `moveTask` above (same-note section move). */
  moveTaskToDate: (id: string, targetDate: string) => void
  /**
   * fix-move-task-not-found-in-source-note: set when the most recent
   * `moveTaskToDate` call failed (e.g. the renderer's cached task id was
   * stale relative to disk — an external edit changed or removed the task
   * before the move reached the main process). `null` when there's nothing
   * to show. Cleared automatically at the start of the next move attempt —
   * same convention as `DiffPanel`'s `worktreeError`.
   */
  moveError: string | null
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
export function useDailyNote(date: string, configVaultRoot?: string): UseDailyNoteResult {
  const [note, setNote] = useState<DailyNote | null>(null)
  const [loading, setLoading] = useState(true)
  const [exists, setExists] = useState(false)
  const [vaultConfigured, setVaultConfigured] = useState(true)
  const [moveError, setMoveError] = useState<string | null>(null)
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    if (configVaultRoot) {
      if (!cancelled) setVaultConfigured(true)
    } else {
      window.atelier.getVaultRoot().then((root) => {
        if (!cancelled) setVaultConfigured(root !== null)
      })
    }

    window.atelier
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

    window.atelier.watchDailyNote(date).catch(() => {})
    const unsub = window.atelier.onDailyNoteChanged((updatedNote) => {
      if (cancelled) return
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current)
        writeTimerRef.current = null
      }
      setNote(updatedNote)
      setExists(true)
    })

    // UC-18: on window focus regain, re-read the note from disk so external
    // edits made while the app was unfocused (e.g. editing the file directly
    // in Obsidian) show up immediately rather than waiting on the fs.watch
    // debounce round-trip. Skipped entirely if a debounced local write is
    // currently pending — checked at focus time (writeTimerRef.current is a
    // ref precisely so this read is always fresh, not stale from effect
    // setup) — since in that case the pending write + its eventual watcher
    // echo already handle reconciliation; racing a resync against it here
    // would just replay the same "stale local edit briefly flashes over
    // fresher disk state" problem this hook otherwise avoids.
    const onFocus = (): void => {
      if (cancelled) return
      if (writeTimerRef.current !== null) return
      window.atelier
        .readDailyNote(date)
        .then((result) => {
          if (cancelled) return
          setNote(result.note)
          setExists(result.exists)
        })
        .catch(() => {})
    }
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.atelier.unwatchDailyNote().catch(() => {})
      unsub()
      window.removeEventListener('focus', onFocus)
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    }
  }, [date, configVaultRoot])

  const createNote = useCallback(() => {
    window.atelier.createDailyNote(date).then((result) => {
      setNote(result.note)
      setExists(true)
      window.atelier.watchDailyNote(date).catch(() => {})
    })
  }, [date])

  const scheduleWrite = useCallback(
    (updatedNote: DailyNote) => {
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
      writeTimerRef.current = setTimeout(() => {
        window.atelier.writeDailyNote(date, updatedNote).catch(() => {})
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

  // 16-task-move-to-date: a genuinely new, cross-file operation — this is NOT
  // built on `mutate`/`scheduleWrite` (those only ever touch THIS date's
  // file). The main-process `daily-note:move-task` handler reads/rewrites
  // both files directly, so any pending debounced write for this note is
  // flushed and AWAITED first (its timer cancelled) before the move call
  // fires, so the move's fresh-disk-read of the source file can't race a
  // still-in-flight write and resurrect the just-moved task or drop the
  // pending edit.
  const moveTaskToDate = useCallback(
    (id: string, targetDate: string) => {
      setMoveError(null)
      const run = async (): Promise<void> => {
        if (writeTimerRef.current) {
          clearTimeout(writeTimerRef.current)
          writeTimerRef.current = null
          if (note) await window.atelier.writeDailyNote(date, note).catch(() => {})
        }
        const result = await window.atelier.moveTaskToDate(date, id, targetDate)
        setNote(result.sourceNote)
        setExists(true)
      }
      run().catch(async (err) => {
        // fix-move-task-not-found-in-source-note: the move failed — most
        // commonly because the id captured by the renderer (e.g. from a
        // Timeline "Move to..." menu opened before an external Obsidian
        // edit changed/removed the task) is no longer what's on disk. The
        // main process already refused to write anything in that case (see
        // daily-notes-handlers.ts's `daily-note:move-task`), so the source
        // note on disk is untouched and safe to just re-read: this resyncs
        // the renderer's stale copy (picking up whatever id the task now
        // has, or its removal) so the NEXT attempt isn't stale too, instead
        // of leaving the UI frozen on the same bad state that just failed.
        const message = err instanceof Error ? err.message : String(err)
        setMoveError(
          message.includes('task not found in source note')
            ? 'Could not move this task — it changed or was removed before the move completed. Refreshed from disk.'
            : `Failed to move task: ${message}`
        )
        await window.atelier
          .readDailyNote(date)
          .then((result) => {
            setNote(result.note)
            setExists(result.exists)
          })
          .catch(() => {})
      })
    },
    [date, note]
  )

  return {
    note,
    loading,
    exists,
    vaultConfigured,
    createNote,
    updateTask,
    toggleTask,
    addTask,
    deleteTask,
    moveTask,
    moveTaskToDate,
    moveError
  }
}
