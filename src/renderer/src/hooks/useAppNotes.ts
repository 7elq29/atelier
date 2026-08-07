import { useCallback, useEffect, useState } from 'react'
import type { AppNoteRecord } from '../../../shared/app-note-types'

export function useAppNotes(): {
  notes: AppNoteRecord[]
  createNote: (title?: string) => Promise<AppNoteRecord>
  updateNote: (id: string, patch: { title?: string; content?: string }) => Promise<AppNoteRecord>
  deleteNote: (id: string) => Promise<void>
} {
  const [notes, setNotes] = useState<AppNoteRecord[]>([])

  useEffect(() => {
    void window.atelier.listAppNotes().then(setNotes)
  }, [])

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

  const deleteNote = useCallback(async (id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id))
    await window.atelier.deleteAppNote(id)
  }, [])

  return { notes, createNote, updateNote, deleteNote }
}
