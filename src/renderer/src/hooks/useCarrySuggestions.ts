import { useCallback, useEffect, useState } from 'react'
import type { DailyNoteCarrySuggestionsResult } from '../../../shared/daily-note-types'
import { dismissCarrySuggestion, listDismissedCarryKeys } from '../components/daily-notes/carry-dismiss'

export function useCarrySuggestions(viewDate: string, vaultConfigured: boolean): {
  sourceDate: string | null
  tasks: DailyNoteCarrySuggestionsResult['tasks']
  loading: boolean
  refresh: () => Promise<void>
  dismiss: (sourceDate: string, gid: string) => void
  completeOnSource: (sourceDate: string, taskId: string) => Promise<void>
  moveToDate: (sourceDate: string, taskId: string, targetDate: string) => Promise<string | null>
} {
  const [sourceDate, setSourceDate] = useState<string | null>(null)
  const [tasks, setTasks] = useState<DailyNoteCarrySuggestionsResult['tasks']>([])
  const [loading, setLoading] = useState(true)
  const [dismissedRevision, setDismissedRevision] = useState(0)

  const refresh = useCallback(async () => {
    if (!vaultConfigured) {
      setSourceDate(null)
      setTasks([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const dismissed = listDismissedCarryKeys(viewDate)
      const result = await window.atelier.getDailyNoteCarrySuggestions(viewDate, dismissed)
      setSourceDate(result.sourceDate)
      setTasks(result.tasks)
    } finally {
      setLoading(false)
    }
  }, [viewDate, vaultConfigured, dismissedRevision])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const dismiss = useCallback((fromDate: string, gid: string) => {
    dismissCarrySuggestion(viewDate, fromDate, gid)
    setDismissedRevision((n) => n + 1)
  }, [viewDate])

  const completeOnSource = useCallback(
    async (fromDate: string, taskId: string) => {
      await window.atelier.toggleDailyNoteCarryTask(fromDate, taskId)
      await refresh()
    },
    [refresh]
  )

  const moveToDate = useCallback(
    async (fromDate: string, taskId: string, targetDate: string): Promise<string | null> => {
      try {
        await window.atelier.moveTaskToDate(fromDate, taskId, targetDate)
        await refresh()
        return null
      } catch (err) {
        return err instanceof Error ? err.message : String(err)
      }
    },
    [refresh]
  )

  return { sourceDate, tasks, loading, refresh, dismiss, completeOnSource, moveToDate }
}
