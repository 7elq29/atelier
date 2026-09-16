import { useCallback, useEffect, useState } from 'react'
import type { AppNoteRecord } from '../../../shared/app-note-types'

export function useAppNotes(): {
  notes: AppNoteRecord[]
  reload: () => Promise<void>
  createNote: (title?: string) => Promise<AppNoteRecord>
  updateNote: (id: string, patch: { title?: string; content?: string }) => Promise<AppNoteRecord>
  deleteNote: (id: string, permanently?: boolean) => Promise<void>
} {
  const [notes, setNotes] = useState<AppNoteRecord[]>([])

  const reload = useCallback(async () => {
    try {
      setNotes(await window.atelier.listAppNotes())
    } catch {
      setNotes([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const createNote = useCallback(async (title?: string) => {
    const note = await window.atelier.createAppNote(title)
    setNotes((prev) => [...prev, note])
    return note
  }, [])

  const updateNote = useCallback(async (id: string, patch: { title?: string; content?: string }) => {
    const note = await window.atelier.updateAppNote(id, patch)
    setNotes((prev) => prev.map((n) => (n.id === id ? note : n)))
    return note
  }, [])

  const deleteNote = useCallback(async (id: string, permanently = false) => {
    setNotes((prev) => prev.filter((n) => n.id !== id))
    await window.atelier.deleteAppNote(id, permanently)
  }, [])

  return { notes, reload, createNote, updateNote, deleteNote }
}
