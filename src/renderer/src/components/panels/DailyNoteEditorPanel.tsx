import { useEffect, useMemo, useRef } from 'react'
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
import { openExternalLink } from './Linkify'

export default function DailyNoteEditorPanel({
  initialDate,
  effectiveTheme,
  onViewDateChange
}: {
  initialDate: string
  effectiveTheme: 'light' | 'dark'
  onViewDateChange?: (date: string) => void
}): JSX.Element {
  const slice = useDailyNoteNotesSlice(initialDate)
  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null)
  const saveRef = useRef<(() => void) | null>(null)
  const viewDateRef = useRef(slice.viewDate)
  viewDateRef.current = slice.viewDate

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
    []
  )

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

  return (
    <div
      className="files-panel daily-note-editor-panel"
      data-testid="daily-note-editor-panel"
      data-effective-theme={effectiveTheme}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div className="daily-note-scope-bar">
        <span className="daily-note-live-badge">Live preview</span>
        <span>
          Editing vault slice <strong>{slice.notesSectionHeading}</strong> through end of file — Timeline / Trackers stay in Obsidian.
        </span>
        {slice.createdBanner && (
          <span className="daily-note-created-banner" data-testid="daily-note-created-banner">
            Created from Obsidian template
          </span>
        )}
        <span className="daily-note-vault-path" data-testid="daily-note-vault-path" title={slice.vaultRelativePath}>
          {slice.vaultRelativePath || '—'}
        </span>
        <span
          className={`daily-sync-chip${slice.syncState === 'synced' ? ' synced' : slice.syncState === 'external' ? ' external' : ''}`}
          data-testid="daily-note-sync-chip"
        >
          {syncLabel}
        </span>
      </div>

      <div className="daily-note-editor-toolbar">
        <div className="daily-date-nav" aria-label="Daily note date">
          <button type="button" title="Previous day" data-testid="daily-note-prev-day" onClick={() => slice.shiftDate(-1)}>
            ←
          </button>
          <button type="button" title="Today" data-testid="daily-note-today" onClick={() => slice.jumpToday()}>
            Today
          </button>
          <button type="button" title="Next day" data-testid="daily-note-next-day" onClick={() => slice.shiftDate(1)}>
            →
          </button>
          <span className="daily-date-label" data-testid="daily-note-date-label">
            {formatDailyNoteLabel(slice.viewDate)}
          </span>
        </div>
        <span className="daily-note-section-heading" data-testid="daily-note-section-heading">
          {slice.notesSectionHeading}
        </span>
      </div>

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
