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

function normalizeNotesBody(body: string): string {
  return body.replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

function notesBodiesEquivalent(a: string, b: string): boolean {
  return normalizeNotesBody(a) === normalizeNotesBody(b)
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
  notesSectionHeading: string
  loading: boolean
  vaultConfigured: boolean
  syncState: 'synced' | 'saving' | 'external'
  createdBanner: boolean
  editorMountKey: number
  onEditorChange: (markdown: string) => void
  shiftDate: (deltaDays: number) => void
  jumpToday: () => void
}

export function useDailyNoteNotesSlice(initialDate: string): UseDailyNoteNotesSliceResult {
  const [viewDate, setViewDate] = useState(initialDate)
  const [notesBody, setNotesBody] = useState('')
  const [vaultRelativePath, setVaultRelativePath] = useState('')
  const [notesSectionHeading, setNotesSectionHeading] = useState('## 📝 Notes')
  const [loading, setLoading] = useState(true)
  const [vaultConfigured, setVaultConfigured] = useState(true)
  const [syncState, setSyncState] = useState<'synced' | 'saving' | 'external'>('synced')
  const [createdBanner, setCreatedBanner] = useState(false)
  const [editorMountKey, setEditorMountKey] = useState(0)

  const notesBodyRef = useRef('')
  const lastWrittenNotesBodyRef = useRef<string | null>(null)
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writeInFlightRef = useRef(false)
  const viewDateRef = useRef(viewDate)
  viewDateRef.current = viewDate
  notesBodyRef.current = notesBody

  const applySlice = useCallback((result: DailyNoteNotesSliceResult, opts?: { remountEditor?: boolean }) => {
    setNotesBody(result.notesBody)
    notesBodyRef.current = result.notesBody
    lastWrittenNotesBodyRef.current = result.notesBody
    setVaultRelativePath(result.vaultRelativePath)
    setNotesSectionHeading(result.notesSectionHeading)
    setCreatedBanner(result.created)
    setSyncState('synced')
    if (opts?.remountEditor) setEditorMountKey((k) => k + 1)
  }, [])

  const reconcileVaultSlice = useCallback(
    (result: DailyNoteNotesSliceResult): void => {
      const local = notesBodyRef.current
      const lastWritten = lastWrittenNotesBodyRef.current

      if (lastWritten !== null && !notesBodiesEquivalent(local, lastWritten)) {
        // Local edits not yet on disk — never stomp or remount over the caret.
        return
      }

      if (notesBodiesEquivalent(result.notesBody, local)) {
        notesBodyRef.current = result.notesBody
        lastWrittenNotesBodyRef.current = result.notesBody
        setSyncState('synced')
        return
      }

      applySlice(result, { remountEditor: true })
      setSyncState('external')
    },
    [applySlice]
  )

  useEffect(() => {
    setEditorMountKey(0)
    lastWrittenNotesBodyRef.current = null
  }, [viewDate])

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

    const vaultSyncBlocked = (): boolean =>
      writeTimerRef.current !== null || writeInFlightRef.current

    void loadSlice(viewDate, true)

    void window.atelier.watchDailyNote(viewDate).catch(() => {})
    const unsub = window.atelier.onDailyNoteChanged(() => {
      if (cancelled || vaultSyncBlocked()) return
      void window.atelier
        .readDailyNoteNotesSlice(viewDateRef.current, false)
        .then((result) => {
          if (cancelled || vaultSyncBlocked()) return
          reconcileVaultSlice(result)
        })
        .catch(() => {})
    })

    const onFocus = (): void => {
      if (cancelled || vaultSyncBlocked()) return
      void window.atelier
        .readDailyNoteNotesSlice(viewDateRef.current, false)
        .then((result) => {
          if (cancelled || vaultSyncBlocked()) return
          reconcileVaultSlice(result)
        })
        .catch(() => {})
    }
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      void window.atelier.unwatchDailyNote(viewDate).catch(() => {})
      unsub()
      window.removeEventListener('focus', onFocus)
      if (writeTimerRef.current) {
        clearTimeout(writeTimerRef.current)
        writeTimerRef.current = null
        const body = notesBodyRef.current
        const date = viewDateRef.current
        void window.atelier.writeDailyNoteNotesSlice(date, body).catch(() => {})
      }
    }
  }, [viewDate, loadSlice, applySlice, reconcileVaultSlice])

  const scheduleWrite = useCallback((date: string, body: string) => {
    if (writeTimerRef.current) clearTimeout(writeTimerRef.current)
    setSyncState('saving')
    writeTimerRef.current = setTimeout(() => {
      writeTimerRef.current = null
      writeInFlightRef.current = true
      void window.atelier
        .writeDailyNoteNotesSlice(date, body)
        .then(() => {
          lastWrittenNotesBodyRef.current = body
          setSyncState('synced')
        })
        .finally(() => {
          writeInFlightRef.current = false
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
    notesSectionHeading,
    loading,
    vaultConfigured,
    syncState,
    createdBanner,
    editorMountKey,
    onEditorChange,
    shiftDate,
    jumpToday
  }
}
