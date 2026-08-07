import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import CommandPalette, { type PaletteItem } from './components/CommandPalette'
import FileQuickOpenPalette from './components/FileQuickOpenPalette'
import KeyboardHintsOverlay from './components/KeyboardHintsOverlay'
import OnboardingWizard from './components/OnboardingWizard'
import Sidebar from './components/Sidebar'
import NewSessionModal from './components/NewSessionModal'
import SettingsPanel from './components/SettingsPanel'
import DailyNotesSidebar from './components/daily-notes/DailyNotesSidebar'
import { DeleteSessionLinkedTaskDialog, TaskSessionReplaceDialog } from './components/daily-notes/TaskSessionLinkDialogs'
import ChatTranscript from './components/chat/ChatTranscript'
import TranscriptSearchBar from './components/chat/TranscriptSearchBar'
import Composer, { type ComposerHandle } from './components/chat/Composer'
import TrackerRail from './components/chat/TrackerRail'
import SdkToastStack from './components/chat/SdkToastStack'
import ExportMenu from './components/chat/ExportMenu'
import TabBar, { type SessionTab } from './components/panels/TabBar'
import DiffPanel from './components/panels/DiffPanel'
import FilesPanel from './components/panels/FilesPanel'
import AppNotesPanel from './components/panels/AppNotesPanel'
import DailyNoteEditorPanel from './components/panels/DailyNoteEditorPanel'
import PortsPanel from './components/panels/PortsPanel'
import TerminalPanel from './components/panels/TerminalPanel'
import CompanionTerminalDrawer from './components/panels/CompanionTerminalDrawer'
import SessionDisconnectedPanel from './components/SessionDisconnectedPanel'
import { useConfig } from './hooks/useConfig'
import { defaultClaudeModelFromConfig, defaultClaudeEffortFromConfig, type AtelierConfig } from '../../shared/config'
import { useSessions } from './hooks/useSessions'
import { useSessionWorkspace } from './hooks/useSessionWorkspace'
import { truncateContextPath } from './utils/truncateContextPath'
import { useAppNotes } from './hooks/useAppNotes'
import type { DailyTask } from '../../shared/daily-note-types'
import type {
  ImageAttachment,
  MessageSearchHit,
  ModelSelection,
  SessionRecord,
  SessionStatus
} from '../../shared/session-types'
import { FTS_SNIPPET_START, FTS_SNIPPET_END } from '../../shared/chat-content'

function nextTerminalSuggestedName(sessions: SessionRecord[]): string {
  const names = new Set(sessions.filter((s) => s.mode === 'terminal').map((s) => s.name))
  if (!names.has('Terminal')) return 'Terminal'
  for (let i = 2; i < 1000; i++) {
    const candidate = `Terminal ${i}`
    if (!names.has(candidate)) return candidate
  }
  return 'Terminal'
}

function resolveEffectiveTheme(theme: 'system' | 'light' | 'dark'): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Claude-code sessions that show the disconnected gate (no tabs until Reconnect). */
function claudeCodeSessionDisconnected(
  session: SessionRecord | null | undefined,
  sessionId: string | null,
  statuses: Record<string, SessionStatus>
): boolean {
  if (!session || session.mode !== 'claude-code' || !sessionId) return false
  if (session.closedAt) return true
  return statuses[sessionId] === 'startup-idle'
}

function defaultModelSelection(config: AtelierConfig): ModelSelection {
  return {
    model: defaultClaudeModelFromConfig(config),
    effort: defaultClaudeEffortFromConfig(config)
  }
}

function modelSelectionForSession(
  sessionId: string,
  session: SessionRecord | undefined,
  overrides: Record<string, ModelSelection>,
  config: AtelierConfig
): ModelSelection {
  return overrides[sessionId] ?? session?.modelSelection ?? defaultModelSelection(config)
}

/**
 * App shell + global nav/settings chrome (08) with the real session
 * lifecycle (02-session-lifecycle) wired in: sidebar backed by SQLite via
 * useSessions(), New Session flow (local + remote/devpod), a minimal
 * transcript + composer so create/resume/fork can be verified end-to-end,
 * plus the Daily Notes / Obsidian-integration sidebar (09) docked to the
 * right of the main area.
 */
export default function App(): JSX.Element {
  const [date, setDate] = useState<string | null>(null)
  const { config, loaded, updateConfig } = useConfig()
  const sessions = useSessions()
  const sessionWorkspace = useSessionWorkspace()
  const appNotes = useAppNotes()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [fileQuickOpenOpen, setFileQuickOpenOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newSessionOpen, setNewSessionOpen] = useState(false)
  const [pendingTaskSessionLink, setPendingTaskSessionLink] = useState<{
    noteDate: string
    taskGid: string
    taskText: string
  } | null>(null)
  const [replaceLinkedDialogOpen, setReplaceLinkedDialogOpen] = useState(false)
  const [deleteLinkedPrompt, setDeleteLinkedPrompt] = useState<{ sessionId: string; sessionName: string } | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeAppNoteId, setActiveAppNoteId] = useState<string | null>(null)
  const [activeDailyNoteDate, setActiveDailyNoteDate] = useState<string | null>(null)
  const composerRefs = useRef<Map<string, ComposerHandle>>(new Map())
  /** Picker overrides until the next session-list refresh picks up persisted model columns. */
  const [modelSelectionBySession, setModelSelectionBySession] = useState<Record<string, ModelSelection>>({})
  const [activeTab, setActiveTab] = useState<SessionTab>('chat')
  const [visitedTabs, setVisitedTabs] = useState<Set<SessionTab>>(new Set(['chat']))
  const [revealChangePath, setRevealChangePath] = useState<string | undefined>()
  const [revealChangeSeq, setRevealChangeSeq] = useState(0)
  const [revealCommitHash, setRevealCommitHash] = useState<string | undefined>()
  const [revealCommitSeq, setRevealCommitSeq] = useState(0)
  const [revealFilePath, setRevealFilePath] = useState<string | undefined>()
  const [revealFileSeq, setRevealFileSeq] = useState(0)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [drawerHeight, setDrawerHeight] = useState(240)
  /** Per-session FIFO queue while that session is busy (message-queue). */
  const [queuedMessagesBySession, setQueuedMessagesBySession] = useState<Record<string, string[]>>({})
  const queuedMessagesBySessionRef = useRef(queuedMessagesBySession)
  queuedMessagesBySessionRef.current = queuedMessagesBySession

  // Claude-code chat composers stay mounted per visited session (draft + git cap).
  const [aliveChatComposers, setAliveChatComposers] = useState<Set<string>>(() => new Set())

  const effectiveTheme = resolveEffectiveTheme(config.theme)

  const fileQuickOpenChordAtRef = useRef<number | null>(null)
  const fileQuickOpenOpenRef = useRef(false)
  const activeSessionRef = useRef<SessionRecord | null>(null)
  const activeAppNoteIdRef = useRef<string | null>(null)

  // Terminal keep-alive: maps ptyId → {cwd, hostname} for terminal-mode sessions
  // that have been visited. These TerminalPanels stay mounted permanently (only CSS
  // visibility changes on switch) so xterm + the tmux pty client are never torn down
  // and re-created between session switches.
  const [aliveTerminals, setAliveTerminals] = useState<Map<string, { cwd: string; hostname: string | null | undefined }>>(new Map())

  // Tab-terminal keep-alive: same idea for claude-code sessions' terminal tab.
  // Keyed by ptyId (`${sessionId}:tab-terminal`). Since the tab-bar lives inside
  // the 56px topbar (above the content wrapper), these entries use the same
  // terminal-cache-layer with top:0 and appear correctly below the tab-bar.
  const [aliveTabTerminals, setAliveTabTerminals] = useState<Map<string, { cwd: string; hostname: string | null | undefined }>>(new Map())

  // ── In-conversation "Find in conversation" (10b-enrichment-full-text-search) ──
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false)
  const [transcriptSearchQuery, setTranscriptSearchQuery] = useState('')
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  const [matchCount, setMatchCount] = useState(0)
  // Cross-session content-search palette jump target (10b-enrichment-full-
  // text-search): set when a content-match palette item runs, consumed by
  // the effect below once that message's row actually exists in the DOM
  // (which may be a render or two after `selectSession` resolves).
  const [pendingJumpMessageId, setPendingJumpMessageId] = useState<number | null>(null)
  const [terminalShellHostBySessionId, setTerminalShellHostBySessionId] = useState<Record<string, string | null>>({})

  useEffect(() => {
    window.atelier.getDefaultDate().then(setDate)
  }, [])

  useEffect(() => {
    return window.atelier.onPtyShellContext(({ id, remoteHost }) => {
      setTerminalShellHostBySessionId((prev) => {
        if (prev[id] === remoteHost) return prev
        return { ...prev, [id]: remoteHost }
      })
    })
  }, [])

  // Theme: really flips `data-theme` on <html> — this is the one source of
  // truth every CSS custom property in tokens.css keys off of.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolveEffectiveTheme(config.theme))
  }, [config.theme])

  // Three independent font-size CSS custom properties, each in its own
  // effect keyed on its own config field only — changing one can never touch
  // the others, by construction (not just by convention).
  useEffect(() => {
    document.documentElement.style.setProperty('--font-terminal-size', `${config.fontSizes.terminal}px`)
  }, [config.fontSizes.terminal])
  useEffect(() => {
    document.documentElement.style.setProperty('--font-interface-size', `${config.fontSizes.interface}px`)
  }, [config.fontSizes.interface])
  useEffect(() => {
    document.documentElement.style.setProperty('--font-agent-message-size', `${config.fontSizes.agentMessage}px`)
  }, [config.fontSizes.agentMessage])

  // Keyboard-only trigger for the command palette + a global Escape to close
  // whichever overlay is open. CommandPalette also closes itself on Escape
  // via its own input's onKeyDown (its input auto-focuses on open), but
  // Settings and New Session don't auto-focus anything inside themselves —
  // focus stays on whatever sidebar button opened them — so an
  // Escape-closes-modal handler scoped to those dialogs never actually saw
  // the keydown. Closing all three here, globally, fixes that without
  // depending on where focus happens to be.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.code === 'KeyX') {
          fileQuickOpenChordAtRef.current = Date.now()
          return
        }
        if (e.code === 'KeyF' && fileQuickOpenChordAtRef.current != null) {
          const elapsed = Date.now() - fileQuickOpenChordAtRef.current
          fileQuickOpenChordAtRef.current = null
          if (elapsed <= 1500) {
            const session = activeSessionRef.current
            if (session?.mode === 'claude-code' && !activeAppNoteIdRef.current) {
              e.preventDefault()
              setFileQuickOpenOpen(true)
            }
          }
          return
        }
      }
      if (e.metaKey && !e.altKey && !e.ctrlKey && e.code === 'KeyK') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (e.altKey && e.code === 'KeyX') {
        e.preventDefault()
        setPaletteOpen(true)
        return
      }
      if (e.key === 'Escape') {
        if (fileQuickOpenOpenRef.current) {
          setFileQuickOpenOpen(false)
          return
        }
        // Modal-close always takes priority over interrupt — if any overlay
        // is open, close it and don't also fire the interrupt path.
        if (anyModalOpenRef.current) {
          setPaletteOpen(false)
          setSettingsOpen(false)
          setNewSessionOpen(false)
          setFileQuickOpenOpen(false)
          return
        }
        // No overlay open: if the active session is busy, ESC interrupts it
        // (same action as clicking Stop) and restores the last-submitted text
        // back to the composer — matching Claude Code CLI's ESC behaviour.
        const sid = activeSessionIdRef.current
        if (sid && busyBySessionRef.current[sid]) {
          void sessions.interrupt(sid)
          const restore = lastSubmittedTextBySessionRef.current[sid]
          if (restore) {
            composerRefs.current.get(sid)?.setValue(restore)
          }
          return
        }
        // Idle session or no session: still close any modals that happen to
        // be open (redundant when anyModalOpen is false, but harmless).
        setPaletteOpen(false)
        setSettingsOpen(false)
        setNewSessionOpen(false)
        setReplaceLinkedDialogOpen(false)
        setPendingTaskSessionLink(null)
        setDeleteLinkedPrompt(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const allSessions = useMemo(
    () => [...sessions.activeSessions, ...sessions.historySessions],
    [sessions.activeSessions, sessions.historySessions]
  )

  const performCloseSession = useCallback(
    (id: string) => {
      if (activeSessionId === id) setActiveSessionId(null)
      sessionWorkspace.evictSession(id)
      void sessions.closeSession(id)
    },
    [activeSessionId, sessions, sessionWorkspace]
  )

  const performDeleteSession = useCallback(
    (id: string) => {
      if (activeSessionId === id) setActiveSessionId(null)
      void sessions.deleteSession(id)
      setTerminalShellHostBySessionId((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      setAliveTerminals((prev) => {
        if (!prev.has(id)) return prev
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      setAliveTabTerminals((prev) => {
        const ptyId = `${id}:tab-terminal`
        if (!prev.has(ptyId)) return prev
        const next = new Map(prev)
        next.delete(ptyId)
        return next
      })
      void window.atelier.ptyKillTmuxSession(id)
      void window.atelier.ptyKillTmuxSession(`${id}:tab-terminal`)
      void window.atelier.ptyKillTmuxSession(`${id}:companion`)
      sessionWorkspace.evictSession(id)
      setAliveChatComposers((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      composerRefs.current.delete(id)
    },
    [activeSessionId, sessions, sessionWorkspace]
  )

  const handleDeleteSession = useCallback(
    (id: string) => {
      const session = allSessions.find((s) => s.id === id)
      if (session?.linkedDailyTaskGid && session.linkedDailyNoteDate) {
        setDeleteLinkedPrompt({ sessionId: id, sessionName: session.name })
        return
      }
      performDeleteSession(id)
    },
    [allSessions, performDeleteSession]
  )

  const handleCreateSessionFromTask = useCallback(
    (task: DailyTask) => {
      if (!date) return
      const pending = { noteDate: date, taskGid: task.gid, taskText: task.text }
      if (task.linkedSessionId) {
        setPendingTaskSessionLink(pending)
        setReplaceLinkedDialogOpen(true)
      } else {
        setPendingTaskSessionLink(pending)
        setNewSessionOpen(true)
      }
    },
    [date]
  )

  async function selectSession(session: SessionRecord): Promise<void> {
    setActiveAppNoteId(null)
    setActiveDailyNoteDate(null)
    setActiveSessionId(session.id)
    setActiveTab('chat')
    setVisitedTabs(new Set(['chat']))
    setDrawerOpen(false)
    const startupIdle =
      session.mode === 'claude-code' &&
      !session.closedAt &&
      (sessions.statuses[session.id] === 'startup-idle' ||
        (await window.atelier.isSessionStartupIdle(session.id)))
    const disconnectedGate = startupIdle || Boolean(session.closedAt)
    if (session.mode === 'claude-code' && !disconnectedGate) {
      void window.atelier.touchSessionActive(session.id)
    }
    // Reload transcript + reconnect for active sessions missing cached messages
    // (common after app relaunch). Closed / startup-idle: no reconnect on select —
    // user must click Reconnect on the disconnected gate.
    if (!disconnectedGate && !sessions.messagesBySession[session.id]) {
      await sessions.resumeSession(session.id)
    }
    sessionWorkspace.hydrateSnapshot(session.id)
  }

  const handleSessionReconnect = useCallback(async (): Promise<void> => {
    if (!activeSessionId) return
    const session = allSessions.find((s) => s.id === activeSessionId)
    if (session?.closedAt) {
      await sessions.resumeSession(activeSessionId)
      return
    }
    if (!sessions.messagesBySession[activeSessionId]) {
      await sessions.loadSessionMessages(activeSessionId)
    }
    await sessions.reconnectSession(activeSessionId)
  }, [activeSessionId, allSessions, sessions])

  const openLocalTerminal = useCallback(async () => {
    const home = await window.atelier.getHomedir()
    const created = await sessions.createSession({
      mode: 'terminal',
      hostId: 'local',
      projectPath: home,
      suggestedName: nextTerminalSuggestedName(allSessions)
    })
    await selectSession(created)
  }, [allSessions, sessions])

  const selectAppNote = useCallback((noteId: string) => {
    setActiveDailyNoteDate(null)
    setActiveAppNoteId(noteId)
  }, [])

  const selectDailyNote = useCallback(async () => {
    setActiveAppNoteId(null)
    const d = activeDailyNoteDate ?? (await window.atelier.getDefaultDate())
    setActiveDailyNoteDate(d)
  }, [activeDailyNoteDate])

  const createAppNote = useCallback(async () => {
    const note = await appNotes.createNote()
    setActiveDailyNoteDate(null)
    setActiveAppNoteId(note.id)
  }, [appNotes])

  const deleteAppNote = useCallback(
    async (noteId: string) => {
      const other = appNotes.notes.filter((n) => n.id !== noteId)
      if (activeAppNoteId === noteId) {
        setActiveAppNoteId(other[0]?.id ?? null)
      }
      await appNotes.deleteNote(noteId)
    },
    [activeAppNoteId, appNotes]
  )

  function selectTab(tab: SessionTab): void {
    if (claudeCodeSessionDisconnected(activeSession, activeSessionId, sessions.statuses)) return
    setActiveTab(tab)
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
  }

  // Switching sessions always closes/clears the in-conversation search bar —
  // matches (and their indices) are only meaningful for the transcript
  // they were found in (10b-enrichment-full-text-search).
  useEffect(() => {
    setTranscriptSearchOpen(false)
    setTranscriptSearchQuery('')
    setActiveMatchIndex(0)
    setMatchCount(0)
  }, [activeSessionId])

  // Register terminal-mode sessions in the keep-alive map the first time they
  // become active. After registration the TerminalPanel never unmounts, so
  // switching away and back is a CSS visibility toggle with no pty re-spawn.
  const activeSession = activeSessionId
    ? allSessions.find((s) => s.id === activeSessionId) ?? null
    : null
  const activeAppNote = activeAppNoteId
    ? appNotes.notes.find((n) => n.id === activeAppNoteId) ?? null
    : null
  const activeWorkspacePath =
    activeSession && !activeAppNote && !activeDailyNoteDate
      ? (activeSession.worktreePath ?? activeSession.projectPath)
      : null
  const activeWorkspaceLabel = truncateContextPath(activeWorkspacePath)
  activeSessionRef.current = activeSession
  activeAppNoteIdRef.current = activeAppNoteId

  const openChangedFileInDiff = useCallback(
    (path: string) => {
      const session = activeSessionId ? allSessions.find((s) => s.id === activeSessionId) : null
      if (claudeCodeSessionDisconnected(session, activeSessionId, sessions.statuses)) return
      setRevealChangePath(path)
      setRevealChangeSeq((n) => n + 1)
      setActiveTab('diff')
      setVisitedTabs((prev) => (prev.has('diff') ? prev : new Set(prev).add('diff')))
    },
    [activeSessionId, allSessions, sessions.statuses]
  )

  const openCommitInDiff = useCallback(
    (hash: string) => {
      const session = activeSessionId ? allSessions.find((s) => s.id === activeSessionId) : null
      if (claudeCodeSessionDisconnected(session, activeSessionId, sessions.statuses)) return
      setRevealCommitHash(hash)
      setRevealCommitSeq((n) => n + 1)
      setActiveTab('diff')
      setVisitedTabs((prev) => (prev.has('diff') ? prev : new Set(prev).add('diff')))
    },
    [activeSessionId, allSessions, sessions.statuses]
  )

  const openFileInFiles = useCallback(
    (absolutePath: string) => {
      const session = activeSessionId ? allSessions.find((s) => s.id === activeSessionId) : null
      if (claudeCodeSessionDisconnected(session, activeSessionId, sessions.statuses)) return
      setRevealFilePath(absolutePath)
      setRevealFileSeq((n) => n + 1)
      setActiveTab('files')
      setVisitedTabs((prev) => (prev.has('files') ? prev : new Set(prev).add('files')))
    },
    [activeSessionId, allSessions, sessions.statuses]
  )

  useEffect(() => {
    if (!activeSession || activeSession.mode !== 'terminal') return
    setAliveTerminals((prev) => {
      if (prev.has(activeSession.id)) return prev
      const next = new Map(prev)
      next.set(activeSession.id, { cwd: activeSession.projectPath, hostname: activeSession.hostname })
      return next
    })
  }, [activeSession?.id, activeSession?.mode])

  // Tab-terminal + composer registration when main finishes workspace preload.
  useEffect(() => {
    for (const sessionId of sessionWorkspace.readySessionIds) {
      const ws = sessionWorkspace.workspaceBySession[sessionId]
      if (!ws) continue
      setAliveTabTerminals((prev) => {
        const ptyId = ws.tabTerminalPtyId
        if (prev.has(ptyId)) return prev
        const next = new Map(prev)
        next.set(ptyId, { cwd: ws.workspacePath, hostname: ws.hostname })
        return next
      })
      setAliveChatComposers((prev) => {
        if (prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.add(sessionId)
        return next
      })
    }
  }, [sessionWorkspace.readySessionIds, sessionWorkspace.workspaceBySession])

  function toggleTranscriptSearch(): void {
    setTranscriptSearchOpen((open) => {
      const next = !open
      if (!next) {
        setTranscriptSearchQuery('')
        setActiveMatchIndex(0)
      }
      return next
    })
  }

  function handleTranscriptSearchQueryChange(query: string): void {
    setTranscriptSearchQuery(query)
    setActiveMatchIndex(0)
  }

  function navigateTranscriptMatches(direction: 1 | -1): void {
    setActiveMatchIndex((i) => {
      if (matchCount === 0) return 0
      return (i + direction + matchCount) % matchCount
    })
  }

  // Cross-session content-search jump (10b-enrichment-full-text-search):
  // opens (or switches to) `sessionId`'s transcript, then requests a
  // scroll+flash on `messageId` once its row is actually rendered.
  async function jumpToMessage(session: SessionRecord, messageId: number): Promise<void> {
    await selectSession(session)
    setPendingJumpMessageId(messageId)
  }

  // Consumes `pendingJumpMessageId` the moment the target row exists in the
  // real DOM: real `scrollIntoView` (not a mocked scroll) plus a brief
  // `.msg-jump-highlight` flash so the destination is visually obvious.
  const activeMessagesForJump = activeSessionId ? sessions.messagesBySession[activeSessionId] ?? [] : []
  useEffect(() => {
    if (pendingJumpMessageId == null) return
    const el = document.querySelector<HTMLElement>(`[data-testid="transcript-message"][data-message-id="${pendingJumpMessageId}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center' })
    el.classList.add('msg-jump-highlight')
    const timer = setTimeout(() => el.classList.remove('msg-jump-highlight'), 1600)
    setPendingJumpMessageId(null)
    return () => clearTimeout(timer)
  }, [pendingJumpMessageId, activeMessagesForJump.length])

  // "Focus jumped to that session": move real DOM focus to the row, not just
  // a CSS highlight — provable from Playwright via document.activeElement.
  useEffect(() => {
    if (!activeSessionId) return
    const row = document.querySelector<HTMLElement>(
      `[data-testid="session-row"][data-session-id="${activeSessionId}"]`
    )
    row?.focus()
  }, [activeSessionId, allSessions.length])

  const paletteItems: PaletteItem[] = useMemo(
    () => [
      {
        id: 'toggle-theme',
        label: 'Toggle theme',
        category: 'Action',
        run: () => {
          const effective = resolveEffectiveTheme(config.theme)
          updateConfig({ theme: effective === 'dark' ? 'light' : 'dark' })
        }
      },
      {
        id: 'open-settings',
        label: 'Open Settings',
        category: 'Action',
        run: () => setSettingsOpen(true)
      },
      {
        id: 'toggle-sidebar-collapse',
        label: 'Toggle sidebar collapse',
        category: 'Action',
        run: () => updateConfig({ sidebarCollapsed: !config.sidebarCollapsed })
      },
      {
        id: 'new-session',
        label: 'New Session',
        category: 'Action',
        run: () => setNewSessionOpen(true)
      },
      ...allSessions.map((session) => ({
        id: `session-${session.id}`,
        label: session.name,
        category: 'Session',
        run: () => void selectSession(session)
      }))
    ],
    [config.theme, config.sidebarCollapsed, allSessions]
  )

  // Cross-session content search (10b-enrichment-full-text-search): the
  // command palette's "Session" results extended to also match message
  // *content*, not just session name (the mock only ever defined name
  // matching — see CommandPalette.tsx's doc comment for why this reuses the
  // exact same `cp-item` row rather than adding a new palette page/modal).
  // Backed by `window.atelier.searchMessages` -> SQLite FTS5. Stripped of
  // its `FTS_SNIPPET_START/END` markers here since `PaletteItem.label` is
  // plain text, not markup.
  async function searchSessionContent(query: string): Promise<PaletteItem[]> {
    const hits: MessageSearchHit[] = await window.atelier.searchMessages(query)
    return hits
      .map((hit): PaletteItem | null => {
        const session = allSessions.find((s) => s.id === hit.sessionId)
        if (!session) return null
        const snippet = hit.snippet.split(FTS_SNIPPET_START).join('').split(FTS_SNIPPET_END).join('')
        return {
          id: `session-content-${hit.sessionId}-${hit.messageId}`,
          label: `${snippet} — in ${hit.sessionName}`,
          category: 'Session',
          run: () => void jumpToMessage(session, hit.messageId)
        }
      })
      .filter((item): item is PaletteItem => item !== null)
  }

  function handleOnboardingFinish(identity: { name: string; email: string }): void {
    updateConfig({ onboardingCompleted: true, gitIdentity: identity })
  }

  function handleOnboardingSkip(): void {
    updateConfig({ onboardingCompleted: true })
  }

  async function handleSend(sessionId: string, text: string, image?: ImageAttachment): Promise<void> {
    if (!text.trim() && !image) return
    if (sessions.rateLimitBySession[sessionId]?.sendBlocked) return
    lastSubmittedTextBySessionRef.current[sessionId] = text.trim()
    const session = allSessions.find((s) => s.id === sessionId)
    const model = modelSelectionForSession(sessionId, session, modelSelectionBySession, config)
    await sessions.sendMessage(sessionId, text.trim(), model, image)
  }

  async function handleInterrupt(sessionId: string): Promise<void> {
    await sessions.interrupt(sessionId)
  }

  // Drain per-session queues when that session transitions busy → idle (message-queue).
  useEffect(() => {
    for (const [sessionId, queue] of Object.entries(queuedMessagesBySessionRef.current)) {
      if (queue.length === 0) continue
      const busy = sessions.busyBySession[sessionId] ?? false
      if (busy) continue
      const [next, ...rest] = queue
      setQueuedMessagesBySession((prev) => ({ ...prev, [sessionId]: rest }))
      const session = allSessions.find((s) => s.id === sessionId)
      const model = modelSelectionForSession(sessionId, session, modelSelectionBySession, config)
      void sessions.sendMessage(sessionId, next, model)
      break
    }
  }, [sessions.busyBySession, allSessions, modelSelectionBySession, sessions, config])

  async function handleExport(format: 'markdown' | 'json'): Promise<void> {
    if (!activeSessionId) return
    await sessions.exportTranscript(activeSessionId, format)
  }

  const activeMessages = activeSessionId ? sessions.messagesBySession[activeSessionId] ?? [] : []
  const activeSessionDisconnected = claudeCodeSessionDisconnected(
    activeSession,
    activeSessionId,
    sessions.statuses
  )

  const workspacePanelSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const id of aliveChatComposers) ids.add(id)
    for (const id of sessionWorkspace.readySessionIds) ids.add(id)
    if (activeSessionId && activeSession?.mode === 'claude-code' && !activeSessionDisconnected) {
      ids.add(activeSessionId)
    }
    return [...ids]
  }, [
    aliveChatComposers,
    sessionWorkspace.readySessionIds,
    activeSessionId,
    activeSession?.mode,
    sessions.statuses,
    activeSessionDisconnected
  ])

  // Register claude-code chat composers on first connected visit; keep mounted across session switches.
  useEffect(() => {
    if (!activeSessionId || !activeSession || activeSession.mode !== 'claude-code') return
    if (sessions.statuses[activeSessionId] === 'startup-idle' || activeSession?.closedAt) return
    if (sessionWorkspace.readySessionIds.has(activeSessionId)) return
    setAliveChatComposers((prev) => {
      if (prev.has(activeSessionId)) return prev
      const next = new Set(prev)
      next.add(activeSessionId)
      return next
    })
  }, [activeSessionId, activeSession, sessions.statuses, sessionWorkspace.readySessionIds])

  const appendToActiveComposer = useCallback((note: string) => {
    const sid = activeSessionIdRef.current
    if (!sid) return
    const composer = composerRefs.current.get(sid)
    const prev = composer?.getValue() ?? ''
    composer?.setValue(prev ? `${prev}\n\n${note}` : note)
  }, [])

  const composerDockVisible = Boolean(
    !activeAppNote &&
    !activeDailyNoteDate &&
    activeSession?.mode === 'claude-code' &&
    !activeSessionDisconnected &&
    activeTab === 'chat'
  )

  const showOnboarding = loaded && !config.onboardingCompleted

  // Every overlay in this app (Onboarding, Command Palette, Settings, New
  // Session) is a `.modal-backdrop`/`.modal-dialog` rendered as a *sibling*
  // of `#app`, not an ancestor — so none of them naturally contain focus.
  // None of them install a focus trap either, which meant Tab could escape
  // any open modal into the sidebar/topbar underneath (still visually
  // dimmed, but fully live), and pressing Enter on a focused background
  // button would actually activate it — e.g. opening a second modal on top
  // of the first, or (worst case) escaping the mandatory first-run
  // onboarding gate entirely via keyboard. Confirmed via manual Playwright
  // probes for all four overlays before this fix.
  //
  // Rather than build a bespoke focus trap per dialog, `#app` (sidebar +
  // main area — the entire surface every overlay sits in front of) is made
  // genuinely unfocusable/unclickable via the `inert` DOM attribute whenever
  // any overlay is open. React 18's JSX typings don't know `inert`, so it's
  // set imperatively via a ref.
  const anyModalOpen =
    showOnboarding ||
    paletteOpen ||
    settingsOpen ||
    newSessionOpen ||
    fileQuickOpenOpen ||
    replaceLinkedDialogOpen ||
    deleteLinkedPrompt !== null
  const appBodyRef = useRef<HTMLDivElement>(null)

  // Refs used inside the stable global ESC keydown handler (registered once
  // with [] deps) to read current render-cycle values without re-registering
  // the listener on every render.
  const activeSessionIdRef = useRef<string | null>(null)
  activeSessionIdRef.current = activeSessionId
  const busyBySessionRef = useRef<Record<string, boolean>>({})
  busyBySessionRef.current = sessions.busyBySession
  const anyModalOpenRef = useRef(false)
  anyModalOpenRef.current = anyModalOpen
  fileQuickOpenOpenRef.current = fileQuickOpenOpen
  /**
   * Text of the most recently submitted message — saved in `handleSend`
   * before `composerText` is cleared, so an ESC press during a busy turn
   * can restore it to the composer (matching Claude Code CLI's behaviour:
   * ESC while the turn is running both interrupts AND returns the prompt).
   * Only meaningful while the session is busy; the value doesn't need to
   * be cleared on turn completion because the interrupt branch only runs
   * when `busyBySession[sid]` is true.
   */
  const lastSubmittedTextBySessionRef = useRef<Record<string, string>>({})
  // A layout effect, not a plain effect: it must remove `inert` *before* the
  // "focus jumped to that session" effect below (declared earlier, but a
  // passive effect) tries to call `.focus()` on a session row — a `.focus()`
  // call on an element still inside an inert container is a no-op, which
  // broke the command palette's "Enter jumps focus to that session" behavior
  // when closing the palette and jumping sessions in the same tick.
  useLayoutEffect(() => {
    const el = appBodyRef.current
    if (!el) return
    if (anyModalOpen) {
      el.setAttribute('inert', '')
    } else {
      el.removeAttribute('inert')
    }
  }, [anyModalOpen])

  return (
    <div className="app-root">
      <div id="app" className="app-body" ref={appBodyRef}>
        <Sidebar
          collapsed={config.sidebarCollapsed}
          onToggleCollapse={() => updateConfig({ sidebarCollapsed: !config.sidebarCollapsed })}
          activeSessions={sessions.activeSessions}
          historySessions={sessions.historySessions}
          activeSessionId={activeSessionId}
          onSelectSession={(s) => void selectSession(s)}
          onOpenSettings={() => setSettingsOpen(true)}
          onNewSession={() => setNewSessionOpen(true)}
          onRename={(id, name) => void sessions.renameSession(id, name)}
          onTogglePin={(id, pinned) => void sessions.setPinned(id, pinned)}
          onClose={(id) => performCloseSession(id)}
          onDelete={(id) => handleDeleteSession(id)}
          onFork={(id) => void sessions.forkSession(id).then((forked) => setActiveSessionId(forked.id))}
          onRestart={(id) => void sessions.restartSession(id).then((forked) => setActiveSessionId(forked.id))}
          groups={sessions.groups}
          statuses={sessions.statuses}
          staleSessionIds={sessions.staleSessionIds}
          messagesBySession={sessions.messagesBySession}
          onSetColor={(id, color) => void sessions.setColor(id, color)}
          onSetNotes={(id, notes) => void sessions.setNotes(id, notes)}
          onAddTag={(id, tag) => void sessions.addTag(id, tag)}
          onRemoveTag={(id, tag) => void sessions.removeTag(id, tag)}
          onReorderSessions={(groupId, orderedIds) => void sessions.reorderSessions(groupId, orderedIds)}
          onCreateGroup={(name) => void sessions.createGroup(name)}
          onRenameGroup={(id, name) => void sessions.renameGroup(id, name)}
          onSetGroupCollapsed={(id, collapsed) => void sessions.setGroupCollapsed(id, collapsed)}
          onDeleteGroup={(id) => void sessions.deleteGroup(id)}
          onReorderGroups={(orderedIds) => void sessions.reorderGroups(orderedIds)}
          worktreeProgressBySession={sessions.worktreeProgressBySession}
          onOpenLocalTerminal={() => void openLocalTerminal()}
          terminalShellHostBySessionId={terminalShellHostBySessionId}
          appNotes={appNotes.notes}
          activeAppNoteId={activeAppNoteId}
          activeDailyNote={activeDailyNoteDate !== null}
          onSelectAppNote={selectAppNote}
          onSelectDailyNote={() => void selectDailyNote()}
          onCreateAppNote={() => void createAppNote()}
          onRenameAppNote={(id, title) => void appNotes.updateNote(id, { title })}
          onDeleteAppNote={(id) => void deleteAppNote(id)}
        />

        <div className="main-area">
          <div className="topbar">
            <div className="topbar-title-group">
              <span className="title" data-testid="main-title">
                {activeDailyNoteDate ? (
                  'Daily note'
                ) : activeAppNote ? (
                  <input
                    className="input app-note-title-input"
                    data-testid="app-note-title-input"
                    value={activeAppNote.title}
                    placeholder="Untitled note"
                    onChange={(e) => void appNotes.updateNote(activeAppNote.id, { title: e.target.value })}
                    style={{
                      fontSize: 'inherit',
                      fontWeight: 'inherit',
                      border: 'none',
                      background: 'transparent',
                      padding: '2px 4px',
                      minWidth: 120,
                      maxWidth: 'min(480px, 50vw)'
                    }}
                  />
                ) : activeSession ? (
                  activeSession.name
                ) : (
                  'Atelier'
                )}
              </span>
              {activeWorkspaceLabel && (
                <span
                  className="topbar-workspace"
                  data-testid="topbar-workspace"
                  title={activeWorkspacePath ?? undefined}
                >
                  {activeWorkspaceLabel}
                </span>
              )}
            </div>
            {activeSession && !activeAppNote && !activeDailyNoteDate && activeSession.mode === 'claude-code' && !activeSessionDisconnected && (
              <>
                <TabBar activeTab={activeTab} onSelect={selectTab} showPorts={Boolean(activeSession.hostname)} />
                <div className="topbar-spacer" />
                {sessions.statuses[activeSession.id] === 'connecting' && (
                  <span className="topbar-chip connecting-pill" data-testid="connecting-pill">
                    <span className="spinner" />
                    Connecting…
                  </span>
                )}
                <span className="topbar-chip" data-testid="cost-chip">
                  ${activeSession.totalCostUsd.toFixed(2)}
                </span>
                <ExportMenu onExport={(format) => void handleExport(format)} />
                <TranscriptSearchBar
                  open={transcriptSearchOpen}
                  query={transcriptSearchQuery}
                  matchCount={matchCount}
                  onQueryChange={handleTranscriptSearchQueryChange}
                  onNavigate={navigateTranscriptMatches}
                  onToggle={toggleTranscriptSearch}
                  onClose={toggleTranscriptSearch}
                />
                <button className="btn btn-sm" data-testid="toggle-companion-drawer" onClick={() => setDrawerOpen((o) => !o)}>
                  ▤ Terminal
                </button>
              </>
            )}
          </div>

          {/* Content area below topbar — position:relative anchors the terminal keep-alive layer */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
            {/* Terminal keep-alive layer: terminal-mode AND tab-terminal sessions stay
                mounted here permanently. Switching sessions only toggles CSS visibility —
                no xterm dispose/recreate, no tmux detach/reattach. Tab-bar lives inside
                the 56px topbar above this wrapper, so top:0 here is already below it. */}
            {(aliveTerminals.size > 0 || aliveTabTerminals.size > 0) && (
              <div className="terminal-cache-layer">
                {[...aliveTerminals.entries()].map(([ptyId, info]) => {
                  const isActive = activeSession?.mode === 'terminal' && activeSession.id === ptyId
                  return (
                    <div key={ptyId} className={`terminal-cache-entry${isActive ? ' active' : ''}`}>
                      <TerminalPanel ptyId={ptyId} cwd={info.cwd} hostname={info.hostname} active={isActive} />
                    </div>
                  )
                })}
                {[...aliveTabTerminals.entries()].map(([ptyId, info]) => {
                  const sessionId = ptyId.replace(/:tab-terminal$/, '')
                  const isActive =
                    activeSession?.mode === 'claude-code' &&
                    activeSession.id === sessionId &&
                    activeTab === 'terminal' &&
                    !activeSessionDisconnected
                  return (
                    <div key={ptyId} className={`terminal-cache-entry${isActive ? ' active' : ''}`}>
                      <TerminalPanel ptyId={ptyId} cwd={info.cwd} hostname={info.hostname} active={isActive} />
                    </div>
                  )
                })}
              </div>
            )}

          {activeDailyNoteDate ? (
            <DailyNoteEditorPanel
              key={activeDailyNoteDate}
              initialDate={activeDailyNoteDate}
              effectiveTheme={effectiveTheme}
              onViewDateChange={setActiveDailyNoteDate}
            />
          ) : activeAppNote ? (
            <AppNotesPanel
              notes={appNotes.notes}
              activeNoteId={activeAppNote.id}
              effectiveTheme={effectiveTheme}
              onUpdateNote={async (id, patch) => {
                await appNotes.updateNote(id, patch)
              }}
              onSelectNote={selectAppNote}
            />
          ) : activeSession ? (
            activeSession.mode === 'terminal' ? (
              <div className="terminal-only-main" data-testid="terminal-only-session" />
            ) : activeSessionDisconnected ? (
              <SessionDisconnectedPanel
                onReconnect={() => void handleSessionReconnect()}
                connecting={sessions.statuses[activeSession.id] === 'connecting'}
              />
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                  <div className={`tab-content${activeTab === 'chat' ? '' : ' hidden'}`} data-tab="chat">
                    <div className="chat-tab-wrap" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
                      <SdkToastStack toasts={sessions.sdkToastsBySession[activeSession.id] ?? []} />
                      <div className="chat-body-row">
                        <div className="chat-main-col">
                          <ChatTranscript
                            messages={activeMessages}
                            onRespond={(requestId, decision) => void sessions.respondToPrompt(activeSession.id, requestId, decision)}
                            searchQuery={transcriptSearchOpen ? transcriptSearchQuery : ''}
                            activeMatchIndex={activeMatchIndex}
                            onMatchCount={setMatchCount}
                            onOpenPlanFile={openFileInFiles}
                            sdkChrome={sessions.sdkChromeBySession[activeSession.id] ?? null}
                          />
                        </div>
                        <TrackerRail
                          messages={activeMessages}
                          backgroundTasks={sessions.backgroundTasksBySession[activeSession.id] ?? []}
                        />
                      </div>
                      <div className="composer-cache">
                        {[...aliveChatComposers].map((sessionId) => {
                          const session = allSessions.find((s) => s.id === sessionId)
                          if (!session || session.mode !== 'claude-code') return null
                          const composerActive =
                            composerDockVisible && !drawerOpen && activeSessionId === sessionId
                          const ws = sessionWorkspace.workspaceBySession[sessionId]
                          const mentionPaths = ws?.filesList.map((e) => e.relativePath)
                          return (
                            <div
                              key={sessionId}
                              className={`composer-cache-entry${composerActive ? ' active' : ''}`}
                              data-session-id={sessionId}
                            >
                              <Composer
                                ref={(handle) => {
                                  if (handle) composerRefs.current.set(sessionId, handle)
                                  else composerRefs.current.delete(sessionId)
                                }}
                                onSend={(text, image) => void handleSend(sessionId, text, image)}
                                onInterrupt={() => void handleInterrupt(sessionId)}
                                busy={sessions.busyBySession[sessionId] ?? false}
                                projectPath={session.projectPath}
                                worktreePath={session.worktreePath}
                                harnessCwd={sessions.harnessCwdBySession[sessionId] ?? null}
                                hostname={session.hostname}
                                gitWorkspacePath={session.worktreePath ?? session.projectPath}
                                diffSummary={ws?.diff}
                                sessionChangesCap={ws?.sessionChangesCap}
                                mentionFilePaths={mentionPaths}
                                onOpenChangedFile={openChangedFileInDiff}
                                onOpenCommitInDiff={openCommitInDiff}
                                onFork={() => void sessions.forkSession(sessionId).then((forked) => setActiveSessionId(forked.id))}
                                modelSelection={modelSelectionForSession(sessionId, session, modelSelectionBySession, config)}
                                onModelSelectionChange={(selection) => {
                                  setModelSelectionBySession((prev) => ({ ...prev, [sessionId]: selection }))
                                  void window.atelier.setSessionModelSelection(sessionId, selection)
                                }}
                                liveSlashCommands={sessions.commandsBySession[sessionId] ?? []}
                                mode={session.permissionMode}
                                onCycleMode={() => void sessions.cycleMode(sessionId)}
                                queuedMessages={queuedMessagesBySession[sessionId] ?? []}
                                onCancelQueued={(index) =>
                                  setQueuedMessagesBySession((prev) => ({
                                    ...prev,
                                    [sessionId]: (prev[sessionId] ?? []).filter((_, i) => i !== index)
                                  }))
                                }
                                tokenUsage={sessions.tokenUsageBySession[sessionId]}
                                promptSuggestion={sessions.promptSuggestionBySession[sessionId]}
                                rateLimit={sessions.rateLimitBySession[sessionId] ?? null}
                                onAddLocalMessage={(content) => sessions.addLocalMessage(sessionId, content)}
                                onValidateModel={(model) => sessions.validateModel(sessionId, model)}
                              />
                            </div>
                          )
                        })}
                      </div>
                      {import.meta.env.DEV && (sessions.hookLogBySession[activeSession.id]?.length ?? 0) > 0 && (
                        <div className="sdk-debug-log" data-testid="sdk-debug-log">
                          {(sessions.hookLogBySession[activeSession.id] ?? []).map((line, i) => (
                            <span key={i} className="line">
                              {line}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {[...workspacePanelSessionIds].map((sessionId) => {
                    const session = allSessions.find((s) => s.id === sessionId)
                    const ws = sessionWorkspace.workspaceBySession[sessionId]
                    if (!session || session.mode !== 'claude-code') return null
                    const panelsVisible = activeSessionId === sessionId && !activeSessionDisconnected
                    const workspacePath = session.worktreePath ?? session.projectPath
                    return (
                      <div
                        key={`workspace-panels-${sessionId}`}
                        style={{ display: panelsVisible ? 'contents' : 'none' }}
                      >
                        <div className={`tab-content${activeTab === 'diff' ? '' : ' hidden'}`} data-tab="diff">
                          <DiffPanel
                            workspacePath={workspacePath}
                            repoRoot={session.projectPath}
                            hostname={session.hostname}
                            effectiveTheme={effectiveTheme}
                            panelScopeKey={session.id}
                            active={panelsVisible && activeTab === 'diff'}
                            workspaceDiff={ws?.diff}
                            onRefreshWorkspace={() => void window.atelier.refreshSessionWorkspace(sessionId, true)}
                            revealChangePath={panelsVisible ? revealChangePath : undefined}
                            revealChangeSeq={panelsVisible ? revealChangeSeq : 0}
                            onRevealChangeHandled={() => setRevealChangePath(undefined)}
                            revealCommitHash={panelsVisible ? revealCommitHash : undefined}
                            revealCommitSeq={panelsVisible ? revealCommitSeq : 0}
                            onRevealCommitHandled={() => setRevealCommitHash(undefined)}
                            onAddComment={appendToActiveComposer}
                          />
                        </div>

                        <div className={`tab-content${activeTab === 'files' ? '' : ' hidden'}`} data-tab="files">
                          <FilesPanel
                            projectPath={workspacePath}
                            hostname={session.hostname}
                            effectiveTheme={effectiveTheme}
                            active={panelsVisible && activeTab === 'files'}
                            initialFilesTree={ws?.filesTree}
                            revealFilePath={panelsVisible ? revealFilePath : undefined}
                            revealFileSeq={panelsVisible ? revealFileSeq : 0}
                            onRevealFileHandled={() => setRevealFilePath(undefined)}
                            onAddComment={appendToActiveComposer}
                          />
                        </div>
                      </div>
                    )
                  })}

                  <div className={`tab-content${activeTab === 'terminal' ? '' : ' hidden'}`} data-tab="terminal">
                    {/* TerminalPanel lives in the terminal-cache-layer above this session subtree.
                        This empty div keeps the tab layout slot; the cache entry overlays it. */}
                  </div>

                  {Boolean(activeSession.hostname) && (
                    <div className={`tab-content${activeTab === 'ports' ? '' : ' hidden'}`} data-tab="ports">
                      {visitedTabs.has('ports') && (
                        <PortsPanel sessionId={activeSession.id} sshHost={activeSession.hostname as string} />
                      )}
                    </div>
                  )}
                </div>

                {drawerOpen && (
                  <CompanionTerminalDrawer
                    sessionId={activeSession.id}
                    cwd={activeSession.worktreePath ?? activeSession.projectPath}
                    hostname={activeSession.hostname}
                    height={drawerHeight}
                    onHeightChange={setDrawerHeight}
                    onClose={() => setDrawerOpen(false)}
                  />
                )}
              </div>
            )
          ) : (
            <div className="empty-main" data-testid="main-empty-state">
              <div>No session selected</div>
              <div className="preview-stack">
                <div className="preview-block" data-testid="interface-preview">
                  Interface text preview
                </div>
                <div className="preview-block agent-message-preview" data-testid="agent-message-preview">
                  Agent message preview — this is what assistant replies will look like.
                </div>
                <div className="preview-block terminal-preview" data-testid="terminal-preview">
                  $ echo &quot;terminal preview&quot;
                </div>
              </div>
            </div>
          )}
          </div>
        </div>

        {date && (
          <DailyNotesSidebar
            date={date}
            onClose={() => setDate(null)}
            vaultRoot={config.vault.root || undefined}
            onCreateSessionFromTask={handleCreateSessionFromTask}
          />
        )}
      </div>

      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
        searchContent={searchSessionContent}
      />

      {activeSession?.mode === 'claude-code' && !activeAppNote && (
        <FileQuickOpenPalette
          isOpen={fileQuickOpenOpen}
          onClose={() => setFileQuickOpenOpen(false)}
          workspaceRoot={activeSession.worktreePath ?? activeSession.projectPath}
          hostname={activeSession.hostname}
          onOpenFile={(path) => {
            setFileQuickOpenOpen(false)
            openFileInFiles(path)
          }}
        />
      )}

      <KeyboardHintsOverlay disabled={anyModalOpen} scanRootId="app" />

      <NewSessionModal
        isOpen={newSessionOpen}
        hosts={sessions.hosts}
        config={config}
        onClose={() => {
          setNewSessionOpen(false)
          setPendingTaskSessionLink(null)
        }}
        onCreate={async (opts) => {
          const created = await sessions.createSession({
            ...opts,
            suggestedName: pendingTaskSessionLink?.taskText.trim() || opts.suggestedName
          })
          if (pendingTaskSessionLink) {
            await sessions.linkDailyTask(
              created.id,
              pendingTaskSessionLink.noteDate,
              pendingTaskSessionLink.taskGid
            )
            setPendingTaskSessionLink(null)
          }
          setActiveSessionId(created.id)
        }}
      />

      {replaceLinkedDialogOpen && pendingTaskSessionLink && (
        <TaskSessionReplaceDialog
          taskText={pendingTaskSessionLink.taskText}
          onCancel={() => {
            setReplaceLinkedDialogOpen(false)
            setPendingTaskSessionLink(null)
          }}
          onConfirm={() => {
            setReplaceLinkedDialogOpen(false)
            setNewSessionOpen(true)
          }}
        />
      )}

      {deleteLinkedPrompt && (
        <DeleteSessionLinkedTaskDialog
          sessionName={deleteLinkedPrompt.sessionName}
          onCancel={() => setDeleteLinkedPrompt(null)}
          onDeleteOnly={() => {
            const { sessionId } = deleteLinkedPrompt
            setDeleteLinkedPrompt(null)
            performDeleteSession(sessionId)
          }}
          onDeleteAndComplete={() => {
            const { sessionId } = deleteLinkedPrompt
            setDeleteLinkedPrompt(null)
            void sessions.completeLinkedDailyTask(sessionId).finally(() => {
              performDeleteSession(sessionId)
            })
          }}
        />
      )}

      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        onUpdate={updateConfig}
        authStatus={sessions.authStatus}
        onReplayOnboarding={() => {
          setSettingsOpen(false)
          updateConfig({ onboardingCompleted: false })
        }}
      />

      <OnboardingWizard
        isOpen={showOnboarding}
        initialGitIdentity={config.gitIdentity}
        onFinish={handleOnboardingFinish}
        onSkip={handleOnboardingSkip}
      />
    </div>
  )
}
