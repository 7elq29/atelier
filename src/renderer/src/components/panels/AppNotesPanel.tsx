import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle
} from '@atomic-editor/editor'
import '@atomic-editor/editor/styles.css'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { AppNoteRecord } from '../../../../shared/app-note-types'
import { noteEditorLayoutExtensions } from '../../editor/noteEditorExtensions'
import {
  focusNoteAtRememberedCursor,
  rememberNoteCursor,
  type NoteCursorPositions
} from '../../editor/note-cursor-memory'
import { openExternalLink } from './Linkify'

/** In-app notes — Atomic Editor live-preview markdown (single note at a time). */
export default function AppNotesPanel({
  notes,
  activeNoteId,
  effectiveTheme,
  onUpdateNote,
  onDirty,
  cursorPositions
}: {
  notes: AppNoteRecord[]
  activeNoteId: string
  effectiveTheme: 'light' | 'dark'
  onUpdateNote: (id: string, patch: { title?: string; content?: string }) => Promise<void>
  onDirty?: (id: string) => void
  onSelectNote: (noteId: string) => void
  cursorPositions: NoteCursorPositions
}): JSX.Element {
  const activeNoteIdRef = useRef(activeNoteId)
  activeNoteIdRef.current = activeNoteId

  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null)
  const saveRef = useRef<(() => Promise<void>) | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const boundNote = notes.find((n) => n.id === activeNoteId)
  const boundNoteContent = boundNote?.content ?? ''
  const noteKey = `app:${activeNoteId}`

  const saveCurrent = useCallback(async () => {
    const noteId = activeNoteIdRef.current
    const content = editorHandleRef.current?.getMarkdown()
    if (content === undefined) return
    await onUpdateNote(noteId, { content })
  }, [onUpdateNote])
  saveRef.current = saveCurrent

  const noteEditorExtensions = useMemo(
    () => [
      ...noteEditorLayoutExtensions,
      rememberNoteCursor(noteKey, cursorPositions),
      Prec.high(
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void saveRef.current?.().catch(() => undefined)
              return true
            }
          }
        ])
      )
    ],
    [cursorPositions, noteKey]
  )

  const handleMarkdownChange = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    onDirty?.(activeNoteIdRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      void saveRef.current?.().catch(() => undefined)
    }, 600)
  }, [onDirty])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  useEffect(
    () => focusNoteAtRememberedCursor(editorHandleRef, noteKey, cursorPositions),
    [cursorPositions, noteKey]
  )

  return (
    <div
      className="files-panel app-notes-panel"
      data-testid="app-notes-panel"
      data-effective-theme={effectiveTheme}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div
        className="file-view app-notes-editor-surface"
        data-testid="app-note-editor"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
      >
        {boundNote ? (
          <div className="app-notes-atomic-host" data-testid="atomic-note-editor" style={{ flex: 1, minHeight: 0 }}>
            <AtomicCodeMirrorEditor
              key={activeNoteId}
              documentId={activeNoteId}
              markdownSource={boundNoteContent}
              editorHandleRef={editorHandleRef}
              onMarkdownChange={handleMarkdownChange}
              onLinkClick={openExternalLink}
              extensions={noteEditorExtensions}
              blurEditorOnMount
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
