import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle
} from '@atomic-editor/editor'
import '@atomic-editor/editor/styles.css'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import {
  dailyNoteImagePasteExtension,
  dailyNoteWikiEmbedImagePreview
} from '../../editor/dailyNoteImagePaste'
import { noteEditorLayoutExtensions } from '../../editor/noteEditorExtensions'
import {
  formatDailyNoteLabel,
  useDailyNoteNotesSlice
} from '../../hooks/useDailyNoteNotesSlice'
import {
  focusNoteAtRememberedCursor,
  rememberNoteCursor,
  type NoteCursorPositions
} from '../../editor/note-cursor-memory'
import { openExternalLink } from './Linkify'

export default function DailyNoteEditorPanel({
  initialDate,
  effectiveTheme,
  onViewDateChange,
  cursorPositions,
  headerHost
}: {
  initialDate: string
  effectiveTheme: 'light' | 'dark'
  onViewDateChange?: (date: string) => void
  cursorPositions: NoteCursorPositions
  headerHost: HTMLElement | null
}): JSX.Element {
  const slice = useDailyNoteNotesSlice(initialDate)
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null)
  const saveRef = useRef<(() => void) | null>(null)
  const viewDateRef = useRef(slice.viewDate)
  viewDateRef.current = slice.viewDate
  const noteKey = `daily:${slice.viewDate}`

  useEffect(() => {
    onViewDateChange?.(slice.viewDate)
  }, [slice.viewDate, onViewDateChange])

  saveRef.current = () => {
    const md = editorHandleRef.current?.getMarkdown()
    if (md !== undefined) slice.onEditorChange(md)
  }

  const extensions = useMemo(
    () => [
      ...noteEditorLayoutExtensions,
      rememberNoteCursor(noteKey, cursorPositions),
      dailyNoteImagePasteExtension(async (payload) => {
        const result = await window.atelier.pasteDailyNoteImage(viewDateRef.current, payload)
        return result.embedMarkdown
      }),
      dailyNoteWikiEmbedImagePreview((fileName) =>
        window.atelier.readDailyNoteAttachmentDataUrl(viewDateRef.current, fileName)
      ),
      Prec.high(
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              saveRef.current?.()
              return true
            }
          }
        ])
      )
    ],
    [cursorPositions, noteKey]
  )

  useEffect(() => {
    if (slice.loading || !slice.vaultConfigured) return
    return focusNoteAtRememberedCursor(editorHandleRef, noteKey, cursorPositions)
  }, [cursorPositions, noteKey, slice.editorMountKey, slice.loading, slice.vaultConfigured])

  if (!slice.vaultConfigured) {
    return (
      <div
        className="daily-note-unconfigured"
        data-testid="daily-note-editor"
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          color: 'var(--text-tertiary)',
          textAlign: 'center'
        }}
      >
        No vault configured. Set a vault root in Settings → Vault (or ATELIER_VAULT_ROOT for dev/tests).
      </div>
    )
  }

  const syncLabel =
    slice.syncState === 'saving' ? 'Saving…' : slice.syncState === 'external' ? 'Updated from vault' : 'Synced'
  const headerControls = (
    <div className="daily-note-header-controls">
      <div className="daily-date-nav" aria-label="Daily note date">
        <button
          type="button"
          aria-label="Previous day"
          title="Previous day"
          data-testid="daily-note-prev-day"
          onClick={() => slice.shiftDate(-1)}
        >
          ←
        </button>
        <span className="daily-date-label" data-testid="daily-note-date-label">
          {formatDailyNoteLabel(slice.viewDate)}
        </span>
        <button
          type="button"
          aria-label="Next day"
          title="Next day"
          data-testid="daily-note-next-day"
          onClick={() => slice.shiftDate(1)}
        >
          →
        </button>
      </div>
      <span
        className={`daily-sync-chip${slice.syncState === 'synced' ? ' synced' : slice.syncState === 'external' ? ' external' : ''}`}
        data-testid="daily-note-sync-chip"
        role="status"
        aria-live="polite"
        aria-label={syncLabel}
        title={syncLabel}
      >
        <span className="daily-sync-dot" aria-hidden="true" />
        <span className="daily-sync-label">{syncLabel}</span>
      </span>
    </div>
  )

  return (
    <div
      className="files-panel daily-note-editor-panel"
      data-testid="daily-note-editor-panel"
      data-effective-theme={effectiveTheme}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {headerHost ? createPortal(headerControls, headerHost) : null}

      <div className="daily-note-atomic-host" data-testid="daily-note-editor" style={{ flex: 1, minHeight: 0 }}>
        {slice.loading ? (
          <div className="daily-note-loading">Loading…</div>
        ) : (
          <AtomicCodeMirrorEditor
            key={`${slice.viewDate}:${slice.editorMountKey}`}
            documentId={`${slice.viewDate}:${slice.editorMountKey}`}
            markdownSource={slice.notesBody}
            onMarkdownChange={slice.onEditorChange}
            onLinkClick={openExternalLink}
            editorHandleRef={editorHandleRef}
            extensions={extensions}
            blurEditorOnMount
          />
        )}
      </div>
    </div>
  )
}
