import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AtomicCodeMirrorEditor,
  type AtomicCodeMirrorEditorHandle
} from '@atomic-editor/editor'
import '@atomic-editor/editor/styles.css'
import { Prec } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import type { AppNoteRecord } from '../../../../shared/app-note-types'

type OpenNoteTab = { id: string; noteId: string; isDirty: boolean }

function noteLabel(note: AppNoteRecord | undefined): string {
  const t = note?.title?.trim()
  return t || 'Untitled note'
}

/** In-app notes — Atomic Editor live-preview markdown + Files-style tabs. */
export default function AppNotesPanel({
  notes,
  activeNoteId,
  effectiveTheme,
  onUpdateNote,
  onSelectNote
}: {
  notes: AppNoteRecord[]
  activeNoteId: string
  effectiveTheme: 'light' | 'dark'
  onUpdateNote: (id: string, patch: { title?: string; content?: string }) => Promise<void>
  onSelectNote: (noteId: string) => void
}): JSX.Element {
  const [openTabs, setOpenTabs] = useState<OpenNoteTab[]>(() => [{ id: 'tab-1', noteId: activeNoteId, isDirty: false }])
  const [activeTabId, setActiveTabId] = useState('tab-1')
  const nextTabNum = useRef(1)
  const openTabsRef = useRef(openTabs)
  const activeTabIdRef = useRef(activeTabId)
  openTabsRef.current = openTabs
  activeTabIdRef.current = activeTabId

  const editorHandleRef = useRef<AtomicCodeMirrorEditorHandle | null>(null)
  const saveRef = useRef<(() => Promise<void>) | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeTab = openTabs.find((t) => t.id === activeTabId) ?? openTabs[0]
  const boundNoteId = activeTab?.noteId ?? activeNoteId
  const boundNote = notes.find((n) => n.id === boundNoteId)
  const boundNoteContent = boundNote?.content ?? ''

  useEffect(() => {
    setOpenTabs((prev) => {
      const existing = prev.find((t) => t.noteId === activeNoteId)
      if (existing) {
        setActiveTabId(existing.id)
        return prev
      }
      nextTabNum.current += 1
      const tabId = `tab-${nextTabNum.current}`
      setActiveTabId(tabId)
      return [...prev, { id: tabId, noteId: activeNoteId, isDirty: false }]
    })
  }, [activeNoteId])

  const saveCurrent = useCallback(async () => {
    const tab = openTabsRef.current.find((t) => t.id === activeTabIdRef.current)
    if (!tab) return
    const content = editorHandleRef.current?.getMarkdown()
    if (content === undefined) return
    await onUpdateNote(tab.noteId, { content })
    setOpenTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, isDirty: false } : t)))
  }, [onUpdateNote])
  saveRef.current = saveCurrent

  const noteEditorExtensions = useMemo(
    () => [
      Prec.high(
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              void saveRef.current?.()
              return true
            }
          }
        ])
      )
    ],
    []
  )

  const handleMarkdownChange = useCallback(() => {
    setOpenTabs((prev) =>
      prev.map((t) => (t.id === activeTabIdRef.current ? { ...t, isDirty: true } : t))
    )
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => void saveRef.current?.(), 600)
  }, [])

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  function activateTab(tabId: string): void {
    const tab = openTabs.find((t) => t.id === tabId)
    if (!tab) return
    setActiveTabId(tabId)
    onSelectNote(tab.noteId)
  }

  function closeTab(tabId: string, e: React.MouseEvent): void {
    e.stopPropagation()
    const tab = openTabs.find((t) => t.id === tabId)
    if (tab?.isDirty) void saveRef.current?.()
    setOpenTabs((prev) => prev.filter((t) => t.id !== tabId))
    if (activeTabId === tabId) {
      const remaining = openTabs.filter((t) => t.id !== tabId)
      setActiveTabId(remaining[0]?.id ?? activeTabId)
    }
  }

  const showTabBar = openTabs.length > 1

  return (
    <div
      className="files-panel app-notes-panel"
      data-testid="app-notes-panel"
      data-effective-theme={effectiveTheme}
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      {showTabBar && (
        <div className="files-editor-tabs" data-testid="app-notes-editor-tabs">
          {openTabs.map((tab) => {
            const note = notes.find((n) => n.id === tab.noteId)
            return (
              <button
                key={tab.id}
                type="button"
                className={`files-editor-tab${tab.id === activeTabId ? ' active' : ''}${tab.isDirty ? ' dirty' : ''}`}
                data-testid="app-notes-editor-tab"
                data-note-id={tab.noteId}
                onClick={() => activateTab(tab.id)}
              >
                <span className="fname">{noteLabel(note)}</span>
                {tab.isDirty && <span className="files-tab-dirty" aria-hidden />}
                <span
                  className="files-tab-close"
                  data-testid="app-notes-editor-tab-close"
                  role="presentation"
                  onClick={(e) => closeTab(tab.id, e)}
                >
                  ×
                </span>
              </button>
            )
          })}
        </div>
      )}
      <div
        className="file-view app-notes-editor-surface"
        data-testid="app-note-editor"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
      >
        {boundNote ? (
          <div className="app-notes-atomic-host" data-testid="atomic-note-editor" style={{ flex: 1, minHeight: 0 }}>
            <AtomicCodeMirrorEditor
              key={boundNoteId}
              documentId={boundNoteId}
              markdownSource={boundNoteContent}
              editorHandleRef={editorHandleRef}
              onMarkdownChange={handleMarkdownChange}
              extensions={noteEditorExtensions}
              blurEditorOnMount
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
