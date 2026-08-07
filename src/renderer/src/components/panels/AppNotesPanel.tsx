import { useCallback, useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import type { AppNoteRecord } from '../../../../shared/app-note-types'
import { registerEmacsMonacoKeybindings } from '../../editor/emacs-monaco-keybindings'
import { ensureAtelierMonacoThemes, monacoThemeId } from '../../editor/atelier-monaco-theme'

ensureAtelierMonacoThemes()

type OpenNoteTab = { id: string; noteId: string; isDirty: boolean }

function modelUriForNote(noteId: string): monaco.Uri {
  return monaco.Uri.parse(`inmemory://app-notes/${noteId}`)
}

function noteLabel(note: AppNoteRecord | undefined): string {
  const t = note?.title?.trim()
  return t || 'Untitled note'
}

/** In-app notes — Monaco editor + Files-style tabs (no file tree). */
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

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const saveRef = useRef<(() => Promise<void>) | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suppressModelChangeRef = useRef(false)

  const activeTab = openTabs.find((t) => t.id === activeTabId) ?? openTabs[0]
  const boundNoteId = activeTab?.noteId
  const boundNoteContent = notes.find((n) => n.id === boundNoteId)?.content ?? ''

  useEffect(() => {
    monaco.editor.setTheme(monacoThemeId(effectiveTheme))
  }, [effectiveTheme])

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
    const editor = editorRef.current
    const tab = openTabsRef.current.find((t) => t.id === activeTabIdRef.current)
    if (!editor || !tab) return
    await onUpdateNote(tab.noteId, { content: editor.getValue() })
    setOpenTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, isDirty: false } : t)))
  }, [onUpdateNote])
  saveRef.current = saveCurrent

  const editorContainerRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      editorRef.current?.dispose()
      editorRef.current = null
      return
    }
    if (editorRef.current) return
    const editor = monaco.editor.create(node, {
      theme: monacoThemeId(effectiveTheme),
      automaticLayout: true,
      readOnly: false,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      fontSize: 13,
      lineHeight: 21,
      fontFamily: '"SF Mono", "JetBrains Mono", Menlo, Consolas, monospace',
      padding: { top: 10 },
      folding: true,
      wordWrap: 'on',
      suggest: { showWords: false }
    })
    editorRef.current = editor
    registerEmacsMonacoKeybindings(editor)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current?.()
    })
  }, [effectiveTheme])

  useEffect(() => {
    const editor = editorRef.current
    const tab = openTabsRef.current.find((t) => t.id === activeTabId)
    if (!editor || !tab || !boundNoteId) return
    const note = notes.find((n) => n.id === tab.noteId)
    if (!note) return

    const uri = modelUriForNote(note.id)
    let model = monaco.editor.getModel(uri)
    if (!model) {
      model = monaco.editor.createModel(note.content, 'markdown', uri)
    } else {
      const tabDirty = openTabsRef.current.find((t) => t.id === activeTabId)?.isDirty
      if (!tabDirty && model.getValue() !== boundNoteContent) {
        suppressModelChangeRef.current = true
        model.setValue(boundNoteContent)
        suppressModelChangeRef.current = false
      }
    }
    editor.setModel(model)

    const sub = model.onDidChangeContent(() => {
      if (suppressModelChangeRef.current) return
      setOpenTabs((prev) => prev.map((t) => (t.id === activeTabId ? { ...t, isDirty: true } : t)))
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => void saveRef.current?.(), 600)
    })
    return () => sub.dispose()
  }, [activeTabId, boundNoteId, boundNoteContent, notes])

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
        className="file-view"
        data-testid="app-note-editor"
        style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
      >
        <div ref={editorContainerRef} data-testid="monaco-editor" style={{ flex: 1, minHeight: 0 }} />
      </div>
    </div>
  )
}
