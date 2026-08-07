import { useCallback, useEffect, useRef, useState } from 'react'
import type { DailyNoteNotesSliceResult } from '../../../shared/daily-note-types'

const WRITE_DEBOUNCE_MS = 500

function shiftDateKey(key: string, deltaDays: number): string {
  const [y, m, d] = key.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  date.setDate(date.getDate() + deltaDays)
  const yy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

export function formatDailyNoteLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

export { shiftDateKey as shiftDailyNoteDateKey }

export interface UseDailyNoteNotesSliceResult {
  viewDate: string
  setViewDate: (date: string) => void
  notesBody: string
  vaultRelativePath: string
  loading: boolean
  vaultConfigured: boolean
  syncState: 'synced' | 'saving' | 'external'
  createdBanner: boolean
  onEditorChange: (markdown: string) => void
  shiftDate: (deltaDays: number) => void
  jumpToday: () => void
}

export function useDailyNoteNotesSlice(initialDate: string): UseDailyNoteNotesSliceResult {
  const [viewDate, setViewDate] = useState(initialDate)
  const [notesBody, setNotesBody] = useState('')
  const [vaultRelativePath, setVaultRelativePath] = useState('')
  const [loading, setLoading] = useState(true)
  const [vaultConfigured, setVaultConfigured] = useState(true)
  const [syncState, setSyncState] = useState<'synced' | 'saving' | 'external'>('synced')
  const [createdBanner, setCreatedBanner] = useState(false)

  const notesBodyRef = useRef('')
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewDateRef = useRef(viewDate)
  viewDateRef.current = viewDate
  notesBodyRef.current = notesBody

  const applySlice = useCallback((result: DailyNoteNotesSliceResult) => {
    setNotesBody(result.notesBody)
    setVaultRelativePath(result.vaultRelativePath)
    setCreatedBanner(result.created)
    setSyncState('synced')
  }, [])

  const loadSlice = useCallback(async (date: string, createIfMissing: boolean) => {
    setLoading(true)
    try {
      const root = await window.atelier.getVaultRoot()
      if (!root) {
        setVaultConfigured(false)
        return
      }
      setVaultConfigured(true)
      const result = await window.atelier.readDailyNoteNotesSlice(date, createIfMissing)
      applySlice(result)
    } catch {
      setVaultConfigured(false)
    } finally {
      setLoading(false)
    }
  }, [applySlice])

  useEffect(() => {
    let cancelled = false
    void loadSlice(viewDate, true)

    void window.atelier.watchDailyNote(viewDate).catch(() => {})
    const unsub = window.atelier.onDailyNoteChanged(() => {
      if (cancelled) return
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current)
        writeTimerRef.current = null
      }
      void window.atelier
        .readDailyNoteNotesSlice(viewDateRef.current, false)
        .then((result) => {
          if (cancelled) return
          const sameAsLocal = result.notesBody === notesBodyRef.current
          applySlice(result)
          if (!sameAsLocal) setSyncState('external')
        })
        .catch(() => {})
    })

    const onFocus = (): void => {
      if (cancelled || writeTimerRef.current) return
      void window.atelier
        .readDailyNoteNotesSlice(viewDateRef.current, false)
        .then((result) => {
          if (cancelled) return
          if (result.notesBody !== notesBodyRef.current) {
            applySlice(result)
            setSyncState('external')
          }
        })
        .catch(() => {})
    }
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      void window.atelier.unwatchDailyNote().catch(() => {})
      unsub()
      window.removeEventListener('focus', onFocus)
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    }
  }, [viewDate, loadSlice, applySlice])

  const scheduleWrite = useCallback((date: string, body: string) => {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    setSyncState('saving')
    writeTimerRef.current = setTimeout(() => {
      void window.atelier.writeDailyNoteNotesSlice(date, body).then(() => {
        setSyncState('synced')
      })
    }, WRITE_DEBOUNCE_MS)
  }, [])

  const onEditorChange = useCallback(
    (markdown: string) => {
      setNotesBody(markdown)
      notesBodyRef.current = markdown
      scheduleWrite(viewDateRef.current, markdown)
    },
    [scheduleWrite]
  )

  const shiftDate = useCallback((deltaDays: number) => {
    setViewDate((prev) => shiftDateKey(prev, deltaDays))
  }, [])

  const jumpToday = useCallback(() => {
    void window.atelier.getDefaultDate().then((d) => setViewDate(d))
  }, [])

  return {
    viewDate,
    setViewDate,
    notesBody,
    vaultRelativePath,
    loading,
    vaultConfigured,
    syncState,
    createdBanner,
    onEditorChange,
    shiftDate,
    jumpToday
  }
}
