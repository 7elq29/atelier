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
import TranscriptSearchBar from './components/chat/TranscriptSearchBar'
import Composer, { type ComposerHandle } from './components/chat/Composer'
import SdkToastStack from './components/chat/SdkToastStack'
import ExportMenu from './components/chat/ExportMenu'
import TabBar, { type SessionTab } from './components/panels/TabBar'
import {
  applyStripTabSelect,
  createSplit,
  isChatTabVisible,
  isSplitLayoutVisible,
  isTabHiddenFromStrip,
  isTerminalTabVisible,
  isWorkspaceSplittableTab,
  resolveTabVisibility,
  splitDirectionForEdge,
  stripActiveTab,
  tabContentClass
} from './workspace-split/workspace-split-logic'
import type { WorkspaceSplitState } from './workspace-split/workspace-split-types'
import { WorkspaceSplitDivider } from './workspace-split/WorkspaceSplitDivider'
import { WorkspaceSplitDropOverlay } from './workspace-split/WorkspaceSplitDropOverlay'
import { WorkspaceSplitDragGhost } from './workspace-split/WorkspaceSplitDragGhost'
import { useWorkspaceTabDrag } from './workspace-split/useWorkspaceTabDrag'
import { WorkspaceSplitPaneClose } from './workspace-split/WorkspaceSplitPaneClose'
import AppNotesPanel from './components/panels/AppNotesPanel'
import DailyNoteEditorPanel from './components/panels/DailyNoteEditorPanel'
import WeeklyPlanWizardPanel from './components/panels/WeeklyPlanWizardPanel'
import WeeklyPlanViewPanel from './components/panels/WeeklyPlanViewPanel'
import PortsPanel from './components/panels/PortsPanel'
import TerminalWithToolbox from './components/panels/TerminalWithToolbox'
import TitleBar from './components/TitleBar'
import SessionDisconnectedPanel from './components/SessionDisconnectedPanel'
import { SessionWorkspacePanels } from './components/session/SessionWorkspacePanels'
import { SessionChatSurface } from './components/session/SessionChatSurface'
import { SessionMessagesHydrator } from './components/session/SessionMessagesHydrator'
import { getSessionMessages, hasSessionMessages } from './stores/session-messages-store'
import { useConfig } from './hooks/useConfig'
import { defaultClaudeModelFromConfig, defaultClaudeEffortFromConfig, type AtelierConfig } from '../../shared/config'
import { useSessions } from './hooks/useSessions'
import { useSessionWorkspace } from './hooks/useSessionWorkspace'
import { useSessionBookmarks } from './hooks/useSessionBookmarks'
import { truncateContextPath } from './utils/truncateContextPath'
import { useAppNotes } from './hooks/useAppNotes'
import { useAppBookmarks } from './hooks/useAppBookmarks'
import {
  COLLAPSED_SIDEBAR_WIDTH,
  useAppPanelWidths
} from './hooks/useAppPanelWidths'
import type { DailyTask } from '../../shared/daily-note-types'
import { buildComposerSendText, formatReviewComposerNote, parseReviewComposerNote } from '../../shared/review-pane-types'
import type { ReviewComposerComment, ReviewPaneTarget } from '../../shared/review-pane-types'
import type {
  WeeklyPlanStatus,
  WeeklyPlanViewResult,
  WeeklyPlanWizardContext,
  WeeklyPlanWizardData
} from '../../shared/weekly-plan-types'
import type {
  ImageAttachment,
  MessageSearchHit,
  ModelSelection,
  SessionRecord,
  SessionStatus
} from '../../shared/session-types'
import { FTS_SNIPPET_START, FTS_SNIPPET_END, parseStructuredContent } from '../../shared/chat-content'
import { isClaudePlanPath } from '../../shared/claude-plan-path'
import { findPlanCapEdition } from '../../shared/plan-cap-editions'
import { resolveSessionFilePath, collectFilePathCandidates, sessionFileLinkWorkspaceRoot, remapSessionFilePathToWorktree } from './components/chat/file-path-links'
import type { SessionWorkspacePayload } from '../../shared/session-workspace-types'
import type { DiffSummary, DiffFileChange } from '../../shared/panel-types'
import type {
  CreateSessionBookmarkInput,
  SessionBookmark
} from '../../shared/session-bookmarks'

function filePathCandidatesForSession(ws: SessionWorkspacePayload | undefined): string[] {
  if (!ws) return []
  return collectFilePathCandidates({
    capPaths: ws.sessionChangesCap.items.filter((i) => i.kind === 'file').map((i) => i.path),
    filesList: ws.filesList,
    diffPaths: ws.diff.files.map((f) => f.path)
  })
}

function revealPathInDiffSummary(path: string, diff?: DiffSummary | null): string {
  if (!diff?.isRepo) return path
  const norm = path.replace(/\\/g, '/')
  const exact = diff.files.find((f) => f.path === norm)
  if (exact) return exact.path
  const base = norm.split('/').filter(Boolean).pop()
  if (!base) return path
  const matches = diff.files.filter((f) => f.path === base || f.path.endsWith(`/${base}`))
  return matches.length === 1 ? matches[0]!.path : path
}

function resolveOpenFilePath(
  rawPath: string,
  session: SessionRecord | null | undefined,
  candidates: readonly string[] = []
): string {
  const trimmed = rawPath.trim()
  if (!trimmed) return trimmed
  if (session) {
    const remapped = remapSessionFilePathToWorktree(trimmed, session)
    if (remapped !== trimmed) return remapped
  }
  if (trimmed.startsWith('/') || trimmed.startsWith('~')) return trimmed
  const workspaceRoot = session ? sessionFileLinkWorkspaceRoot(session) : ''
  if (!workspaceRoot) return trimmed
  return resolveSessionFilePath(trimmed, workspaceRoot, workspaceRoot, candidates) ?? trimmed
}

function findPreviousPlanMarkdown(messages: { content: string }[]): string | undefined {
  const plans = messages
    .map((m) => parseStructuredContent(m.content))
    .filter((p) => p?.kind === 'plan_proposed')
  if (plans.length < 2) return undefined
  const prev = plans[plans.length - 2]
  return prev?.kind === 'plan_proposed' ? prev.plan : undefined
}

function nextTerminalSuggestedName(sessions: SessionRecord[], projectPath: string): string {
  const base = truncateContextPath(projectPath) ?? 'Terminal'
  const names = new Set(sessions.filter((s) => s.mode === 'terminal').map((s) => s.name))
  if (!names.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`
    if (!names.has(candidate)) return candidate
  }
  return base
}

function shellHostForPty(ptyId: string, hosts: Record<string, string | null>): string | null {
  const sessionId = ptyId.replace(/:tab-terminal$/, '').replace(/:companion$/, '')
  return hosts[sessionId] ?? null
}

function resolveEffectiveTheme(theme: 'system' | 'light' | 'dark'): 'light' | 'dark' {
  if (theme !== 'system') return theme
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Claude-code sessions that show the main gate (no tabs/composer/panels until connected). */
function claudeCodeSessionDisconnected(
  session: SessionRecord | null | undefined,
  sessionId: string | null,
  statuses: Record<string, SessionStatus>
): boolean {
  if (!session || session.mode !== 'claude-code' || !sessionId) return false
  if (session.closedAt) return true
  const status = statuses[sessionId]
  return status === 'startup-idle' || status === 'connecting'
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
  const sessionBookmarks = useSessionBookmarks()
  const appNotes = useAppNotes()
  const appBookmarks = useAppBookmarks()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [fileQuickOpenOpen, setFileQuickOpenOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsInitialPane, setSettingsInitialPane] = useState<
    'theme' | 'fonts' | 'notifications' | 'vault' | 'agent' | 'sessions' | 'profiles'
  >('theme')
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
  const [activeWeeklyPlanOpen, setActiveWeeklyPlanOpen] = useState(false)
  const [weeklyPlanStatus, setWeeklyPlanStatus] = useState<WeeklyPlanStatus | null>(null)
  const [weeklyPlanContext, setWeeklyPlanContext] = useState<
    (WeeklyPlanWizardContext & { initialData: WeeklyPlanWizardData }) | null
  >(null)
  const [weeklyPlanExistsHint, setWeeklyPlanExistsHint] = useState<string | null>(null)
  const [weeklyPlanViewDoc, setWeeklyPlanViewDoc] = useState<WeeklyPlanViewResult | null>(null)
  const composerRefs = useRef<Map<string, ComposerHandle>>(new Map())
  /** Launch-local caret positions; deliberately never persisted to disk. */
  const noteCursorPositionsRef = useRef(new Map<string, number>())
  /** Picker overrides until the next session-list refresh picks up persisted model columns. */
  const [modelSelectionBySession, setModelSelectionBySession] = useState<Record<string, ModelSelection>>({})
  const [activeTab, setActiveTab] = useState<SessionTab>('chat')
  const [visitedTabs, setVisitedTabs] = useState<Set<SessionTab>>(new Set(['chat']))
  const [workspaceSplitBySession, setWorkspaceSplitBySession] = useState<
    Record<string, WorkspaceSplitState>
  >({})
  const [revealChangePath, setRevealChangePath] = useState<string | undefined>()
  const [revealChangeSeq, setRevealChangeSeq] = useState(0)
  const [revealCommitHash, setRevealCommitHash] = useState<string | undefined>()
  const [revealCommitSeq, setRevealCommitSeq] = useState(0)
  const [revealFilePath, setRevealFilePath] = useState<string | undefined>()
  const [revealFileSeq, setRevealFileSeq] = useState(0)
  const [revealFileDiffPath, setRevealFileDiffPath] = useState<string | undefined>()
  const [revealFileDiffSeq, setRevealFileDiffSeq] = useState(0)
  const [injectDiffBySession, setInjectDiffBySession] = useState<
    Record<string, { file: DiffFileChange; seq: number }>
  >({})
  /** Per-session FIFO queue while that session is busy (message-queue). */
  const [queuedMessagesBySession, setQueuedMessagesBySession] = useState<Record<string, string[]>>({})
  const [reviewCommentsBySession, setReviewCommentsBySession] = useState<
    Record<string, ReviewComposerComment[]>
  >({})
  const reviewCommentIdSeq = useRef(0)
  const queuedMessagesBySessionRef = useRef(queuedMessagesBySession)
  queuedMessagesBySessionRef.current = queuedMessagesBySession

  // Claude-code chat composers stay mounted per visited session (draft + git cap).
  const [aliveChatComposers, setAliveChatComposers] = useState<Set<string>>(() => new Set())

  const effectiveTheme = resolveEffectiveTheme(config.theme)

  const fileQuickOpenChordAtRef = useRef<number | null>(null)
  const fileQuickOpenOpenRef = useRef(false)
  const handleInterruptRef = useRef<(sessionId: string) => Promise<void>>(async () => {})
  const activeSessionRef = useRef<SessionRecord | null>(null)
  const activeAppNoteIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (activeSessionId) void sessionBookmarks.hydrate(activeSessionId)
  }, [activeSessionId, sessionBookmarks.hydrate])

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
  const [reviewTarget, setReviewTarget] = useState<ReviewPaneTarget | null>(null)
  // Cross-session content-search palette jump target (10b-enrichment-full-
  // text-search): set when a content-match palette item runs, consumed by
  // the effect below once that message's row actually exists in the DOM
  // (which may be a render or two after `selectSession` resolves).
  const [pendingJumpMessageId, setPendingJumpMessageId] = useState<number | null>(null)
  const [terminalShellHostBySessionId, setTerminalShellHostBySessionId] = useState<Record<string, string | null>>({})

  useEffect(() => {
    setReviewTarget(null)
  }, [activeSessionId])

  useEffect(() => {
    if (!reviewTarget) return
    requestAnimationFrame(() => {
      if (reviewTarget.capFilePath) {
        document
          .querySelector<HTMLElement>(
            `[data-testid="chat-changes-file"][data-path="${CSS.escape(reviewTarget.capFilePath)}"]`
          )
          ?.scrollIntoView({ block: 'nearest' })
        return
      }
      const highlighted =
        reviewTarget.kind === 'plan'
          ? document.querySelector<HTMLElement>('.plan-card.response-review-selected')
          : document.querySelector<HTMLElement>('.msg-wrap.response-review-selected')
      highlighted?.scrollIntoView({ block: 'nearest' })
    })
  }, [reviewTarget])

  useEffect(() => {
    window.atelier.getDefaultDate().then(setDate)
  }, [])

  const refreshWeeklyPlanStatus = useCallback(async () => {
    const status = await window.atelier.getWeeklyPlanStatus()
    setWeeklyPlanStatus(status)
  }, [])

  useEffect(() => {
    if (!loaded) return
    void refreshWeeklyPlanStatus()
  }, [loaded, refreshWeeklyPlanStatus])

  const handleConfigUpdate = useCallback(
    (partial: Partial<AtelierConfig>): Promise<AtelierConfig> => {
      return updateConfig(partial).then((saved) => {
        if (partial.vault !== undefined) {
          setWeeklyPlanExistsHint(null)
          void refreshWeeklyPlanStatus()
        }
        return saved
      })
    },
    [updateConfig, refreshWeeklyPlanStatus]
  )

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
        // Modal-close always takes priority — if any overlay is open, close it.
        if (anyModalOpenRef.current) {
          setPaletteOpen(false)
          setSettingsOpen(false)
          setNewSessionOpen(false)
          setFileQuickOpenOpen(false)
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

  const evictSessionRendererState = useCallback(
    (id: string) => {
      sessionWorkspace.evictSession(id)
      sessionBookmarks.evict(id)
      setQueuedMessagesBySession((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      setModelSelectionBySession((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
      setInjectDiffBySession((prev) => {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      })
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
      void window.atelier.ptyKill(id)
      void window.atelier.ptyKillTmuxSession(id)
      void window.atelier.ptyKillTmuxSession(`${id}:tab-terminal`)
      void window.atelier.ptyKillTmuxSession(`${id}:companion`)
      setAliveChatComposers((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      composerRefs.current.delete(id)
    },
    [sessionBookmarks, sessionWorkspace]
  )

  const performCloseSession = useCallback(
    (id: string) => {
      if (activeSessionId === id) setActiveSessionId(null)
      evictSessionRendererState(id)
      void sessions.closeSession(id)
    },
    [activeSessionId, evictSessionRendererState, sessions]
  )

  const performDeleteSession = useCallback(
    (id: string) => {
      if (activeSessionId === id) setActiveSessionId(null)
      void sessions.deleteSession(id).catch(() => undefined)
      evictSessionRendererState(id)
    },
    [activeSessionId, evictSessionRendererState, sessions]
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
    setActiveWeeklyPlanOpen(false)
    setWeeklyPlanViewDoc(null)
    setWeeklyPlanExistsHint(null)
    setActiveSessionId(session.id)
    setActiveTab('chat')
    setVisitedTabs(new Set(['chat']))
    const startupIdle =
      session.mode === 'claude-code' &&
      !session.closedAt &&
      (sessions.statuses[session.id] === 'startup-idle' ||
        (await window.atelier.isSessionStartupIdle(session.id)))
    const connecting = sessions.statuses[session.id] === 'connecting'
    const disconnectedGate = startupIdle || Boolean(session.closedAt) || connecting
    if (session.mode === 'claude-code' && !disconnectedGate) {
      void window.atelier.touchSessionActive(session.id)
    }
    // Reload transcript + reconnect for active sessions missing cached messages
    // (common after app relaunch). Closed / startup-idle / connecting: no reconnect on select —
    // user must wait or use Reconnect on the disconnected gate.
    if (!disconnectedGate && !hasSessionMessages(session.id)) {
      await sessions.resumeSession(session.id)
    }
    if (!disconnectedGate) {
      sessionWorkspace.hydrateSnapshot(session.id)
    }
  }

  const reconnectSessionById = useCallback(
    async (sessionId: string): Promise<void> => {
      const session = allSessions.find((s) => s.id === sessionId)
      if (!session) return
      if (sessionId !== activeSessionId) {
        await selectSession(session)
      }
      if (session.closedAt) {
        await sessions.resumeSession(sessionId)
        return
      }
      if (!hasSessionMessages(sessionId)) {
        await sessions.loadSessionMessages(sessionId)
      }
      await sessions.reconnectSession(sessionId)
    },
    [activeSessionId, allSessions, selectSession, sessions]
  )

  const handleSessionReconnect = useCallback(async (): Promise<void> => {
    if (!activeSessionId) return
    await reconnectSessionById(activeSessionId)
  }, [activeSessionId, reconnectSessionById])

  const openLocalTerminal = useCallback(async () => {
    const home = await window.atelier.getHomedir()
    const created = await sessions.createSession({
      mode: 'terminal',
      hostId: 'local',
      projectPath: home,
      suggestedName: nextTerminalSuggestedName(allSessions, home)
    })
    await selectSession(created)
  }, [allSessions, sessions])

  const selectAppNote = useCallback((noteId: string) => {
    setActiveDailyNoteDate(null)
    setActiveWeeklyPlanOpen(false)
    setWeeklyPlanViewDoc(null)
    setWeeklyPlanExistsHint(null)
    setActiveAppNoteId(noteId)
  }, [])

  const selectDailyNote = useCallback(() => {
    setActiveAppNoteId(null)
    setActiveWeeklyPlanOpen(false)
    setWeeklyPlanViewDoc(null)
    setWeeklyPlanExistsHint(null)
    // Navigate immediately — do not await IPC while a chat turn is streaming
    // (main process busy → click feels dead until getDefaultDate returns).
    const now = new Date()
    const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const d = activeDailyNoteDate ?? date ?? localToday
    setActiveDailyNoteDate(d)
    if (!activeDailyNoteDate && !date) {
      void window.atelier.getDefaultDate().then((mainDate) => {
        setActiveDailyNoteDate((prev) => (prev === localToday ? mainDate : prev))
      })
    }
  }, [activeDailyNoteDate, date])

  const toggleDailyNotesPanel = useCallback(async () => {
    if (date) {
      setDate(null)
      return
    }
    const d = await window.atelier.getDefaultDate()
    setDate(d)
  }, [date])

  const startWeeklyPlanWizard = useCallback(async () => {
    if (weeklyPlanStatus?.fileExists) return
    const vaultRoot = await window.atelier.getVaultRoot()
    if (!vaultRoot) {
      setWeeklyPlanExistsHint('Set your Obsidian vault path in Settings to use Weekly plan.')
      return
    }
    try {
      const ctx = await window.atelier.loadWeeklyPlanContext()
      setActiveAppNoteId(null)
      setActiveDailyNoteDate(null)
      setActiveSessionId(null)
      setWeeklyPlanExistsHint(null)
      setWeeklyPlanViewDoc(null)
      setWeeklyPlanContext(ctx)
      setActiveWeeklyPlanOpen(true)
    } catch {
      setWeeklyPlanExistsHint('Set your Obsidian vault path in Settings to use Weekly plan.')
    }
  }, [weeklyPlanStatus?.fileExists])

  const onWeeklyPlanRowClick = useCallback(async () => {
    if (!weeklyPlanStatus?.fileExists) return
    try {
      const doc = await window.atelier.readWeeklyPlanNote(weeklyPlanStatus.isoWeek)
      setActiveAppNoteId(null)
      setActiveDailyNoteDate(null)
      setActiveSessionId(null)
      setActiveWeeklyPlanOpen(false)
      setWeeklyPlanContext(null)
      setWeeklyPlanExistsHint(null)
      setWeeklyPlanViewDoc(doc)
    } catch (err) {
      setWeeklyPlanExistsHint(
        `Could not open weekly plan: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }, [weeklyPlanStatus])

  const createAppNote = useCallback(async () => {
    const note = await appNotes.createNote()
    setActiveDailyNoteDate(null)
    setActiveWeeklyPlanOpen(false)
    setWeeklyPlanViewDoc(null)
    setActiveAppNoteId(note.id)
  }, [appNotes])

  const deleteAppNote = useCallback(
    async (noteId: string) => {
      const other = appNotes.notes.filter((n) => n.id !== noteId)
      if (activeAppNoteId === noteId) {
        setActiveAppNoteId(other[0]?.id ?? null)
      }
      noteCursorPositionsRef.current.delete(`app:${noteId}`)
      await appNotes.deleteNote(noteId)
    },
    [activeAppNoteId, appNotes]
  )

  const activeSession = activeSessionId
    ? allSessions.find((s) => s.id === activeSessionId) ?? null
    : null
  const activeAppNote = activeAppNoteId
    ? appNotes.notes.find((n) => n.id === activeAppNoteId) ?? null
    : null

  const selectTab = useCallback(
    (tab: SessionTab): void => {
      if (claudeCodeSessionDisconnected(activeSession, activeSessionId, sessions.statuses)) return
      const sessionId = activeSessionId
      const split = sessionId ? workspaceSplitBySession[sessionId] ?? null : null
      const { split: nextSplit } = applyStripTabSelect(tab, split)
      if (sessionId && nextSplit !== split) {
        setWorkspaceSplitBySession((prev) => {
          if (!nextSplit) {
            const { [sessionId]: _, ...rest } = prev
            return rest
          }
          return { ...prev, [sessionId]: nextSplit }
        })
      }
      setActiveTab(tab)
      setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
    },
    [activeSession, activeSessionId, sessions.statuses, workspaceSplitBySession]
  )

  const activeWorkspaceSplit = activeSessionId ? workspaceSplitBySession[activeSessionId] ?? null : null
  const stripTab = stripActiveTab(activeTab, activeWorkspaceSplit)
  const splitLayoutVisible = isSplitLayoutVisible(activeWorkspaceSplit)
  const hiddenStripTabs = useMemo(() => {
    if (!activeWorkspaceSplit) return undefined
    const hidden = new Set<SessionTab>()
    if (isTabHiddenFromStrip('diff', activeWorkspaceSplit)) hidden.add('diff')
    if (isTabHiddenFromStrip('files', activeWorkspaceSplit)) hidden.add('files')
    if (isTabHiddenFromStrip('chat', activeWorkspaceSplit)) hidden.add('chat')
    if (isTabHiddenFromStrip('terminal', activeWorkspaceSplit)) hidden.add('terminal')
    if (isTabHiddenFromStrip('ports', activeWorkspaceSplit)) hidden.add('ports')
    return hidden.size > 0 ? hidden : undefined
  }, [activeWorkspaceSplit])

  /** Closing one pane dismisses the split and leaves the other tab fullscreen. */
  const handleWorkspaceSplitPaneClose = useCallback(
    (tab: SessionTab) => {
      if (!activeSessionId) return
      const split = workspaceSplitBySession[activeSessionId] ?? null
      if (!split) return
      const remaining = tab === split.primaryTab ? split.secondaryTab : split.primaryTab
      setWorkspaceSplitBySession((prev) => {
        const { [activeSessionId]: _removed, ...rest } = prev
        return rest
      })
      setActiveTab(remaining)
      setVisitedTabs((prev) => (prev.has(remaining) ? prev : new Set(prev).add(remaining)))
    },
    [activeSessionId, workspaceSplitBySession]
  )

  const handleWorkspaceSplitDrop = useCallback(
    (edge: 'left' | 'right' | 'top' | 'bottom', tab: SessionTab) => {
      if (!activeSessionId || !isWorkspaceSplittableTab(tab)) return
      const split = workspaceSplitBySession[activeSessionId] ?? null
      if (split && (tab === split.primaryTab || tab === split.secondaryTab)) return
      const anchorTab = split?.fullscreenTab
        ? split.primaryTab
        : split
          ? split.primaryTab
          : activeTab
      if (!isWorkspaceSplittableTab(anchorTab)) return
      const insertBefore = edge === 'left' || edge === 'top'
      const primaryTab = insertBefore ? tab : anchorTab
      const secondaryTab = insertBefore ? anchorTab : tab
      const next = createSplit(
        primaryTab,
        secondaryTab,
        split?.splitRatio ?? 0.5,
        splitDirectionForEdge(edge)
      )
      if (!next) return
      setWorkspaceSplitBySession((prev) => ({ ...prev, [activeSessionId]: next }))
      setActiveTab(primaryTab)
      setVisitedTabs((prev) => {
        const nextVisited = new Set(prev)
        nextVisited.add(primaryTab)
        nextVisited.add(secondaryTab)
        return nextVisited
      })
    },
    [activeSessionId, activeTab, workspaceSplitBySession]
  )

  const workspaceTabDrag = useWorkspaceTabDrag(handleWorkspaceSplitDrop)

  const handleWorkspaceSplitRatioChange = useCallback(
    (ratio: number) => {
      if (!activeSessionId) return
      setWorkspaceSplitBySession((prev) => {
        const split = prev[activeSessionId]
        if (!split) return prev
        return { ...prev, [activeSessionId]: { ...split, splitRatio: ratio } }
      })
    },
    [activeSessionId]
  )

  // Switching sessions always closes/clears the in-conversation search bar —
  // matches (and their indices) are only meaningful for the transcript
  // they were found in (10b-enrichment-full-text-search).
  useEffect(() => {
    setTranscriptSearchOpen(false)
    setTranscriptSearchQuery('')
    setActiveMatchIndex(0)
    setMatchCount(0)
  }, [activeSessionId])

  const activeWeeklyPlanSurface = activeWeeklyPlanOpen || weeklyPlanViewDoc !== null
  const activeWorkspacePath =
    activeSession && !activeAppNote && !activeDailyNoteDate && !activeWeeklyPlanSurface
      ? (activeSession.worktreePath ?? activeSession.projectPath)
      : null
  const sessionMainInForeground =
    Boolean(activeSession) && !activeAppNote && !activeDailyNoteDate && !activeWeeklyPlanOpen
  const activeWorkspaceLabel = truncateContextPath(activeWorkspacePath)
  activeSessionRef.current = activeSession
  activeAppNoteIdRef.current = activeAppNoteId

  const openChangedFileInDiff = useCallback(
    (path: string) => {
      const session = activeSessionId ? allSessions.find((s) => s.id === activeSessionId) : null
      if (claudeCodeSessionDisconnected(session, activeSessionId, sessions.statuses)) return
      setRevealChangePath(path)
      setRevealChangeSeq((n) => n + 1)
      selectTab('diff')
    },
    [activeSessionId, allSessions, sessions.statuses, selectTab]
  )

  const openChangedFileInFilesWithDiff = useCallback(
    (path: string) => {
      const session = activeSessionId ? allSessions.find((s) => s.id === activeSessionId) : null
      if (claudeCodeSessionDisconnected(session, activeSessionId, sessions.statuses)) return
      const ws = activeSessionId ? sessionWorkspace.workspaceBySession[activeSessionId] : undefined
      const absolutePath = resolveOpenFilePath(path, session, filePathCandidatesForSession(ws))
      setRevealFileDiffPath(absolutePath)
      setRevealFileDiffSeq((n) => n + 1)
      selectTab('files')
    },
    [activeSessionId, allSessions, sessions.statuses, sessionWorkspace.workspaceBySession, selectTab]
  )

  const handleSessionTabHintShortcut = useCallback(
    (tab: SessionTab) => {
      if (tab === 'ports' && !activeSession?.hostname) return
      selectTab(tab)
    },
    [activeSession?.hostname, selectTab]
  )

  const openFileInFiles = useCallback(
    (rawPath: string) => {
      const session = activeSessionId ? allSessions.find((s) => s.id === activeSessionId) : null
      if (claudeCodeSessionDisconnected(session, activeSessionId, sessions.statuses)) return
      const ws = activeSessionId ? sessionWorkspace.workspaceBySession[activeSessionId] : undefined
      const absolutePath = resolveOpenFilePath(rawPath, session, filePathCandidatesForSession(ws))
      setRevealFilePath(absolutePath)
      setRevealFileSeq((n) => n + 1)
      selectTab('files')
    },
    [activeSessionId, allSessions, sessions.statuses, sessionWorkspace.workspaceBySession, selectTab]
  )

  const toggleActiveBookmark = useCallback(
    (bookmark: CreateSessionBookmarkInput, bookmarked: boolean) => {
      if (!activeSessionId) return
      if (bookmarked) {
        void sessionBookmarks.remove(activeSessionId, bookmark.kind, bookmark.target)
      } else {
        void sessionBookmarks.add(activeSessionId, bookmark)
      }
    },
    [activeSessionId, sessionBookmarks.add, sessionBookmarks.remove]
  )

  const openSessionBookmark = useCallback(
    async (bookmark: SessionBookmark) => {
      if (bookmark.kind === 'link') {
        void window.atelier.openExternal(bookmark.target)
        return
      }
      const session = activeSessionId ? allSessions.find((s) => s.id === activeSessionId) : null
      if (claudeCodeSessionDisconnected(session, activeSessionId, sessions.statuses)) return
      if (!session) return

      const ws = sessionWorkspace.workspaceBySession[session.id]
      const absolutePath = resolveOpenFilePath(
        bookmark.target,
        session,
        filePathCandidatesForSession(ws)
      )
      const result = await window.atelier.filesRead(absolutePath, session.hostname ?? null)

      setActiveTab('chat')
      setReviewTarget({
        sourceId: -1,
        kind: 'file',
        content:
          result.kind === 'binary'
            ? `Binary preview is unavailable for ${bookmark.label || bookmark.target}.`
            : result.content,
        capFilePath: absolutePath
      })
      window.atelier.log('info', 'bookmark:file opened in review panel', {
        sessionId: session.id,
        path: absolutePath,
        fileKind: result.kind
      })
    },
    [
      activeSessionId,
      allSessions,
      sessions.statuses,
      sessionWorkspace.workspaceBySession
    ]
  )

  useEffect(() => {
    if (!activeSession || activeSession.mode !== 'terminal') return
    setAliveTerminals((prev) => {
      if (prev.has(activeSession.id)) return prev
      const next = new Map(prev)
      next.set(activeSession.id, { cwd: activeSession.projectPath, hostname: activeSession.hostname })
      return next
    })
  }, [activeSession?.id, activeSession?.mode, activeSession?.projectPath])

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
    if (session.id !== activeSessionId) {
      await selectSession(session)
    }
    await sessions.loadSessionMessages(session.id, { includeMessageId: messageId })
    setPendingJumpMessageId(messageId)
  }

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
        run: () => {
          setSettingsInitialPane('theme')
          setSettingsOpen(true)
        }
      },
      {
        id: 'toggle-sidebar-collapse',
        label: 'Toggle sidebar collapse',
        category: 'Action',
        run: () => updateConfig({ sidebarCollapsed: !config.sidebarCollapsed })
      },
      {
        id: 'toggle-daily-notes-panel',
        label: 'Toggle daily notes tracker panel',
        category: 'Action',
        run: () => void toggleDailyNotesPanel()
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
    [config.theme, config.sidebarCollapsed, allSessions, toggleDailyNotesPanel]
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
    const reviewComments = reviewCommentsBySession[sessionId] ?? []
    const mergedText = buildComposerSendText(text, reviewComments)
    if (!mergedText && !image) return
    if (sessions.rateLimitBySession[sessionId]?.sendBlocked) return
    const busy = sessions.busyBySession[sessionId] ?? false
    if (busy && !image) {
      // Session is in flight — queue for automatic dispatch when busy → idle.
      // Image attachments can't be queued (queued-strip only shows text).
      setQueuedMessagesBySession((prev) => ({
        ...prev,
        [sessionId]: [...(prev[sessionId] ?? []), mergedText]
      }))
      if (reviewComments.length > 0) {
        setReviewCommentsBySession((prev) => ({ ...prev, [sessionId]: [] }))
      }
      return
    }
    const session = allSessions.find((s) => s.id === sessionId)
    const model = modelSelectionForSession(sessionId, session, modelSelectionBySession, config)
    await sessions.sendMessage(sessionId, mergedText, model, image)
    if (reviewComments.length > 0) {
      setReviewCommentsBySession((prev) => ({ ...prev, [sessionId]: [] }))
    }
  }

  async function handleInterrupt(sessionId: string): Promise<void> {
    const result = await sessions.interrupt(sessionId)
    if (result.action === 'withdrawn') {
      composerRefs.current.get(sessionId)?.setValue(result.restoredText)
    }
  }
  handleInterruptRef.current = handleInterrupt

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

  const openChangedFileFromCap = useCallback(
    async (path: string, opensInFilesTab: boolean) => {
      const session = activeSessionId ? allSessions.find((s) => s.id === activeSessionId) : null
      if (claudeCodeSessionDisconnected(session, activeSessionId, sessions.statuses)) return
      if (!session || !activeSessionId) return
      const ws = sessionWorkspace.workspaceBySession[activeSessionId]
      const workspacePath = session.worktreePath ?? session.projectPath
      const pathCandidates = filePathCandidatesForSession(ws)
      const activeMessages = getSessionMessages(activeSessionId)
      if (isClaudePlanPath(path)) {
        const edition = findPlanCapEdition(activeMessages, path)
        if (edition) {
          const planMessages = activeMessages.filter(
            (m) => parseStructuredContent(m.content)?.kind === 'plan_proposed'
          )
          setActiveTab('chat')
          setReviewTarget({
            sourceId: planMessages[planMessages.length - 1]?.id ?? -1,
            kind: 'plan',
            content: edition.current,
            previousContent: edition.previous,
            capFilePath: path
          })
          return
        }
        const absPath = resolveOpenFilePath(path, session, pathCandidates)
        const result = await window.atelier.filesRead(absPath, session?.hostname ?? null)
        if (result.kind !== 'text' && result.kind !== 'html') return
        const planMessages = activeMessages.filter(
          (m) => parseStructuredContent(m.content)?.kind === 'plan_proposed'
        )
        setActiveTab('chat')
        setReviewTarget({
          sourceId: planMessages[planMessages.length - 1]?.id ?? -1,
          kind: 'plan',
          content: result.content,
          previousContent: findPreviousPlanMarkdown(activeMessages),
          capFilePath: path
        })
        return
      }
      if (opensInFilesTab) {
        const result = await window.atelier.capOutsideFileDiff(activeSessionId, workspacePath, path)
        // No diff means no baseline to compare against, not "nothing to show" — a click that opens
        // nothing at all reads as a broken row.
        if (!result) {
          openFileInFiles(path)
          return
        }
        setActiveTab('chat')
        setReviewTarget({
          sourceId: -1,
          kind: 'file',
          content: result.pair.modified,
          previousContent: result.pair.original,
          capFilePath: path
        })
        return
      }
      const file = await window.atelier.capGitFileDiff(activeSessionId, workspacePath, path)
      if (!file) {
        openFileInFiles(path)
        return
      }
      const pair = await window.atelier.gitWorkingTreeFilePair(
        workspacePath,
        file.path,
        file.status,
        session.hostname ?? null
      )
      if (!pair) {
        openFileInFiles(path)
        return
      }
      setActiveTab('chat')
      setReviewTarget({
        sourceId: -1,
        kind: 'file',
        content: pair.modified,
        previousContent: pair.original,
        capFilePath: path
      })
    },
    [
      activeSessionId,
      allSessions,
      openFileInFiles,
      sessions.statuses,
      sessionWorkspace.workspaceBySession
    ]
  )

  const activeSessionDisconnected = claudeCodeSessionDisconnected(
    activeSession,
    activeSessionId,
    sessions.statuses
  )

  const reloadSessionPanelsForPathChange = useCallback((id: string) => {
    sessionWorkspace.evictSession(id)
    setAliveTabTerminals((prev) => {
      const ptyId = `${id}:tab-terminal`
      if (!prev.has(ptyId)) return prev
      const next = new Map(prev)
      next.delete(ptyId)
      return next
    })
    setAliveTerminals((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
    void window.atelier.ptyKill(`${id}:tab-terminal`)
    void window.atelier.ptyKill(`${id}:companion`)
    void window.atelier.ptyKillTmuxSession(`${id}:tab-terminal`)
    void window.atelier.ptyKillTmuxSession(`${id}:companion`)
  }, [sessionWorkspace])

  const handleSetProjectPath = useCallback(
    async (id: string, projectPath: string) => {
      reloadSessionPanelsForPathChange(id)
      await sessions.setProjectPath(id, projectPath)
    },
    [reloadSessionPanelsForPathChange, sessions]
  )

  const handleRefreshWorkspace = useCallback((sessionId: string) => {
    void window.atelier.refreshSessionWorkspace(sessionId, false)
  }, [])

  const openFileQuickOpen = useCallback(() => {
    if (activeSession?.mode === 'claude-code' && !activeAppNote) {
      setFileQuickOpenOpen(true)
    }
  }, [activeSession?.mode, activeAppNote])

  const handleJumpHandled = useCallback(() => {
    setPendingJumpMessageId(null)
  }, [])

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

  // Register claude-code chat composers on first connected visit; keep mounted across session/note switches.
  useEffect(() => {
    if (!activeSessionId || !activeSession || activeSession.mode !== 'claude-code') return
    if (sessions.statuses[activeSessionId] === 'startup-idle' || activeSession?.closedAt) return
    setAliveChatComposers((prev) => {
      if (prev.has(activeSessionId)) return prev
      const next = new Set(prev)
      next.add(activeSessionId)
      return next
    })
  }, [activeSessionId, activeSession, sessions.statuses])

  const activeDiffChangedCount =
    activeSessionId && sessionWorkspace.workspaceBySession[activeSessionId]?.diff.isRepo
      ? sessionWorkspace.workspaceBySession[activeSessionId]!.diff.files.length
      : null

  const appendToActiveComposer = useCallback((note: string) => {
    const sid = activeSessionIdRef.current
    if (!sid) return
    const composer = composerRefs.current.get(sid)
    const parsed = parseReviewComposerNote(note)
    if (parsed) {
      reviewCommentIdSeq.current += 1
      const comment: ReviewComposerComment = {
        id: `review-composer-comment-${reviewCommentIdSeq.current}`,
        ...parsed,
        composerNote: note
      }
      setReviewCommentsBySession((prev) => ({
        ...prev,
        [sid]: [...(prev[sid] ?? []), comment]
      }))
      return
    }
    const prev = composer?.getValue() ?? ''
    composer?.setValue(prev ? `${prev}\n\n${note}` : note)
  }, [])

  const updateReviewCommentBody = useCallback((sessionId: string, commentId: string, body: string) => {
    setReviewCommentsBySession((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? []).map((c) => {
        if (c.id !== commentId) return c
        const composerNote = formatReviewComposerNote(c.prefix, c.sourceLineLabel, c.quote, body)
        return { ...c, body, composerNote }
      })
    }))
  }, [])

  const deleteReviewComment = useCallback((sessionId: string, commentId: string) => {
    setReviewCommentsBySession((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? []).filter((c) => c.id !== commentId)
    }))
  }, [])

  const deleteReviewCommentByNote = useCallback((composerNote: string) => {
    const sid = activeSessionIdRef.current
    if (!sid) return
    setReviewCommentsBySession((prev) => ({
      ...prev,
      [sid]: (prev[sid] ?? []).filter((c) => c.composerNote !== composerNote)
    }))
  }, [])

  const replaceInActiveComposer = useCallback((oldNote: string, newNote: string) => {
    const sid = activeSessionIdRef.current
    if (!sid) return
    const composer = composerRefs.current.get(sid)
    const prev = composer?.getValue() ?? ''
    const oldParsed = parseReviewComposerNote(oldNote)
    const newParsed = parseReviewComposerNote(newNote)
    if (oldParsed && newParsed) {
      setReviewCommentsBySession((prevState) => ({
        ...prevState,
        [sid]: (prevState[sid] ?? []).map((c) =>
          c.composerNote === oldNote
            ? {
                ...c,
                ...newParsed,
                composerNote: newNote
              }
            : c
        )
      }))
      return
    }
    if (!prev.includes(oldNote)) return
    composer?.setValue(prev.replace(oldNote, newNote))
  }, [])

  const composerDockVisible = Boolean(
    !activeAppNote &&
    !activeDailyNoteDate &&
    !activeWeeklyPlanSurface &&
    activeSession?.mode === 'claude-code' &&
    !activeSessionDisconnected &&
    isChatTabVisible(activeTab, activeWorkspaceSplit)
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
  const sidebarExpanded = !config.sidebarCollapsed
  const dailyNotesOpen = date !== null
  const { sidebarWidth, dailyNotesWidth, resizing, startSidebarResize, startDailyNotesResize } =
    useAppPanelWidths(appBodyRef, { dailyNotesOpen, sidebarExpanded })

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
   * ESC / Stop while busy delegates to `handleInterrupt`, which withdraws a
   * not-yet-executed prompt (restores composer text + removes the user row) or
   * interrupts a running turn without restoring the prompt.
   */
  const chatSessionInterruptEnabledRef = useRef(false)
  // ESC interrupts the active chat session's in-flight turn (same as Stop),
  // but only while the chat tab is foreground — not from sidebar, daily
  // notes, other tabs, or modals.
  const chatSessionInterruptEnabled = Boolean(
    activeSessionId &&
      activeSession?.mode === 'claude-code' &&
      !activeAppNote &&
      !activeDailyNoteDate &&
      !activeWeeklyPlanSurface &&
      !activeSessionDisconnected &&
      isChatTabVisible(activeTab, activeWorkspaceSplit)
  )
  chatSessionInterruptEnabledRef.current = chatSessionInterruptEnabled
  const transcriptSearchOpenRef = useRef(false)
  transcriptSearchOpenRef.current = transcriptSearchOpen

  useEffect(() => {
    function handleChatEscape(e: KeyboardEvent): void {
      if (e.key !== 'Escape') return
      if (anyModalOpenRef.current) return
      if (!chatSessionInterruptEnabledRef.current) return
      if (transcriptSearchOpenRef.current) return
      const sid = activeSessionIdRef.current
      if (!sid || !busyBySessionRef.current[sid]) return
      e.preventDefault()
      void handleInterruptRef.current(sid)
    }
    window.addEventListener('keydown', handleChatEscape)
    return () => window.removeEventListener('keydown', handleChatEscape)
  }, [])

  // A layout effect, not a plain effect: it must remove `inert` before the
  // newly-active session panel's passive autofocus runs. A `.focus()` call
  // inside an inert container is a no-op when command-palette navigation
  // closes the overlay and switches sessions in the same tick.
  useLayoutEffect(() => {
    const el = appBodyRef.current
    if (!el) return
    if (anyModalOpen) {
      el.setAttribute('inert', '')
    } else {
      el.removeAttribute('inert')
    }
  }, [anyModalOpen])

  const showIntegratedTitleBar = window.atelier.platform === 'darwin'

  return (
    <div className="app-root">
      {showIntegratedTitleBar ? <TitleBar /> : null}
      <div id="app" className={'app-body' + (resizing ? ' app-body--resizing-panels' : '')} ref={appBodyRef}>
        <div
          className="sidebar-shell"
          data-testid="sidebar-shell"
          style={{ width: sidebarExpanded ? sidebarWidth : COLLAPSED_SIDEBAR_WIDTH }}
        >
          <Sidebar
          collapsed={config.sidebarCollapsed}
          onToggleCollapse={() => updateConfig({ sidebarCollapsed: !config.sidebarCollapsed })}
          activeSessions={sessions.activeSessions}
          historySessions={sessions.historySessions}
          activeSessionId={activeSessionId}
          onSelectSession={(s) => void selectSession(s)}
          onOpenSettings={() => {
            setSettingsInitialPane('theme')
            setSettingsOpen(true)
          }}
          onNewSession={() => setNewSessionOpen(true)}
          onRename={(id, name) => void sessions.renameSession(id, name)}
          onTogglePin={(id, pinned) => void sessions.setPinned(id, pinned)}
          onClose={(id) => performCloseSession(id)}
          onDelete={(id) => handleDeleteSession(id)}
          onFork={(id) => void sessions.forkSession(id).then((forked) => void selectSession(forked))}
          onRestart={(id) =>
            void sessions.restartSession(id).then((restarted) => {
              evictSessionRendererState(id)
              void selectSession(restarted)
            })
          }
          onReconnectSession={(id) => void reconnectSessionById(id)}
          groups={sessions.groups}
          statuses={sessions.statuses}
          staleSessionIds={sessions.staleSessionIds}
          onSetColor={(id, color) => void sessions.setColor(id, color)}
          onSetNotes={(id, notes) => void sessions.setNotes(id, notes)}
          onSetProjectPath={(id, projectPath) => void handleSetProjectPath(id, projectPath)}
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
          weeklyPlanWeekLabel={weeklyPlanStatus?.weekDateRange ?? '…'}
          weeklyPlanFileExists={weeklyPlanStatus?.fileExists ?? false}
          activeWeeklyPlan={activeWeeklyPlanSurface}
          onSelectWeeklyPlanRow={() => void onWeeklyPlanRowClick()}
          onStartWeeklyPlan={() => void startWeeklyPlanWizard()}
          onSelectAppNote={selectAppNote}
          onSelectDailyNote={() => void selectDailyNote()}
          dailyNotesPanelOpen={date !== null}
          onToggleDailyNotesPanel={() => void toggleDailyNotesPanel()}
          onCreateAppNote={() => void createAppNote()}
          onRenameAppNote={(id, title) => void appNotes.updateNote(id, { title })}
          onDeleteAppNote={(id) => void deleteAppNote(id)}
          bookmarks={appBookmarks.bookmarks}
          onCreateBookmark={(input) => void appBookmarks.createBookmark(input)}
          onUpdateBookmark={(id, patch) => void appBookmarks.updateBookmark(id, patch)}
          onDeleteBookmark={(id) => void appBookmarks.deleteBookmark(id)}
          onOpenBookmark={(url) => void window.atelier.openExternal(url)}
          />
        </div>

        {sidebarExpanded ? (
          <div
            className="app-panel-resize-handle"
            data-testid="sidebar-resize-handle"
            onMouseDown={startSidebarResize}
          />
        ) : null}

        <div className="main-area">
          <div
            className={`topbar${activeAppNote || activeDailyNoteDate ? ' topbar--note-editor' : ''}`}
          >
            <div className="topbar-title-group">
              <span
                className="title"
                data-testid="main-title"
                title={
                  activeSession &&
                  !activeAppNote &&
                  !activeDailyNoteDate &&
                  !activeWeeklyPlanOpen &&
                  !weeklyPlanViewDoc
                    ? activeSession.name
                    : undefined
                }
              >
                {activeWeeklyPlanOpen ? (
                  'Weekly review & plan'
                ) : weeklyPlanViewDoc ? (
                  'Weekly plan'
                ) : activeDailyNoteDate ? (
                  'Daily note'
                ) : activeAppNote ? (
                  <input
                    className="app-note-title-input"
                    data-testid="app-note-title-input"
                    value={activeAppNote.title}
                    placeholder="Untitled note"
                    onChange={(e) => void appNotes.updateNote(activeAppNote.id, { title: e.target.value })}
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
            {activeSession && !activeAppNote && !activeDailyNoteDate && !activeWeeklyPlanSurface && activeSession.mode === 'claude-code' && !activeSessionDisconnected && (
              <>
                <TabBar
                  activeTab={stripTab}
                  onSelect={selectTab}
                  showPorts={Boolean(activeSession.hostname)}
                  diffChangedCount={activeDiffChangedCount}
                  hiddenTabs={hiddenStripTabs}
                  onTabPress={workspaceTabDrag.trackTabPress}
                  didDragTab={workspaceTabDrag.didDrag}
                />
                <div className="topbar-spacer" />
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
              </>
            )}
          </div>

          {/* Content area below topbar — position:relative anchors terminal + composer keep-alive layers */}
          <div
            data-main-content
            style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}
          >
            {/* Anchors the inset:0 keep-alive layers to the surface above the composer
                dock, so a buffered panel can't paint over the composer in a split. */}
            <div
              className="main-surface"
              data-testid="main-surface"
              data-split-direction={
                splitLayoutVisible && activeWorkspaceSplit ? activeWorkspaceSplit.direction : undefined
              }
              style={
                activeWorkspaceSplit
                  ? ({ '--workspace-split-ratio': activeWorkspaceSplit.splitRatio } as React.CSSProperties)
                  : undefined
              }
            >
            {/* Terminal keep-alive layer: terminal-mode AND tab-terminal sessions stay
                mounted here permanently. Switching sessions only toggles CSS visibility —
                no xterm dispose/recreate, no tmux detach/reattach. Tab-bar lives inside
                the 56px topbar above this wrapper, so top:0 here is already below it. */}
            {(aliveTerminals.size > 0 || aliveTabTerminals.size > 0) && (
              <div className="terminal-cache-layer">
                {[...aliveTerminals.entries()].map(([ptyId, info]) => {
                  const isActive =
                    sessionMainInForeground &&
                    activeSession?.mode === 'terminal' &&
                    activeSession.id === ptyId
                  return (
                    <div key={ptyId} className={`terminal-cache-entry${isActive ? ' active' : ''}`}>
                      <TerminalWithToolbox
                        ptyId={ptyId}
                        cwd={info.cwd}
                        hostname={info.hostname}
                        shellRemoteHost={shellHostForPty(ptyId, terminalShellHostBySessionId)}
                        active={isActive}
                      />
                    </div>
                  )
                })}
                {[...aliveTabTerminals.entries()].map(([ptyId, info]) => {
                  const sessionId = ptyId.replace(/:tab-terminal$/, '')
                  const isActive =
                    sessionMainInForeground &&
                    activeSession?.mode === 'claude-code' &&
                    activeSession.id === sessionId &&
                    isTerminalTabVisible(activeTab, activeWorkspaceSplit) &&
                    !activeSessionDisconnected
                  // The real terminal overlays its tab slot from this layer, so it has to
                  // take the pane geometry itself or it would cover the whole split.
                  const terminalVisibility = isActive
                    ? resolveTabVisibility('terminal', activeTab, activeWorkspaceSplit)
                    : 'hidden'
                  const paneClass =
                    terminalVisibility === 'split-primary' || terminalVisibility === 'split-secondary'
                      ? ` ${tabContentClass(terminalVisibility).replace('tab-content ', '')}`
                      : ''
                  return (
                    <div
                      key={`${ptyId}:${info.cwd}`}
                      className={`terminal-cache-entry${isActive ? ' active' : ''}${paneClass}`}
                    >
                      <WorkspaceSplitPaneClose
                        tab="terminal"
                        visibility={terminalVisibility}
                        onClose={handleWorkspaceSplitPaneClose}
                      />
                      <TerminalWithToolbox
                        ptyId={ptyId}
                        cwd={info.cwd}
                        hostname={info.hostname}
                        shellRemoteHost={shellHostForPty(ptyId, terminalShellHostBySessionId)}
                        active={isActive}
                      />
                    </div>
                  )
                })}
              </div>
            )}

            {/* Diff/Files keep-alive layer: buffered per visited session, same as the
                terminal layer above. It lives outside the main-area branch below so that
                opening a note, a weekly plan, or a terminal session only toggles CSS
                visibility instead of unmounting the panels and losing their open
                editor tabs, diff selection, and scroll position. */}
            <div className="panel-cache-layer">
              <SessionWorkspacePanels
                sessionIds={workspacePanelSessionIds}
                allSessions={allSessions}
                workspaceBySession={sessionWorkspace.workspaceBySession}
                sessionProfiles={config.sessionProfiles}
                activeSessionId={activeSessionId}
                activeTab={activeTab}
                workspaceSplit={activeWorkspaceSplit}
                onCloseSplitPane={handleWorkspaceSplitPaneClose}
                activeSessionDisconnected={activeSessionDisconnected}
                sessionMainInForeground={sessionMainInForeground}
                effectiveTheme={effectiveTheme}
                revealChangePath={revealChangePath}
                revealChangeSeq={revealChangeSeq}
                revealCommitHash={revealCommitHash}
                revealCommitSeq={revealCommitSeq}
                revealFilePath={revealFilePath}
                revealFileSeq={revealFileSeq}
                revealFileDiffPath={revealFileDiffPath}
                revealFileDiffSeq={revealFileDiffSeq}
                injectDiffBySession={injectDiffBySession}
                onRevealChangeHandled={() => setRevealChangePath(undefined)}
                onRevealCommitHandled={() => setRevealCommitHash(undefined)}
                onRevealFileHandled={() => setRevealFilePath(undefined)}
                onRevealFileDiffHandled={() => setRevealFileDiffPath(undefined)}
                onAddComment={appendToActiveComposer}
                onOpenFileQuickOpen={openFileQuickOpen}
                onRefreshWorkspace={handleRefreshWorkspace}
                refreshingBySession={sessionWorkspace.refreshingBySession}
              />
            </div>

          {weeklyPlanExistsHint ? (
            <div className="weekly-plan-exists-hint" data-testid="weekly-plan-exists-hint">
              {weeklyPlanExistsHint}
            </div>
          ) : null}

          {activeWeeklyPlanOpen && weeklyPlanContext ? (
            <WeeklyPlanWizardPanel
              context={weeklyPlanContext}
              onClose={() => {
                setActiveWeeklyPlanOpen(false)
                setWeeklyPlanContext(null)
              }}
              onCreated={() => void refreshWeeklyPlanStatus()}
            />
          ) : weeklyPlanViewDoc ? (
            <WeeklyPlanViewPanel
              doc={weeklyPlanViewDoc}
              effectiveTheme={effectiveTheme}
              onClose={() => setWeeklyPlanViewDoc(null)}
            />
          ) : activeDailyNoteDate ? (
            <DailyNoteEditorPanel
              key={activeDailyNoteDate}
              initialDate={activeDailyNoteDate}
              effectiveTheme={effectiveTheme}
              onViewDateChange={setActiveDailyNoteDate}
              cursorPositions={noteCursorPositionsRef.current}
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
              cursorPositions={noteCursorPositionsRef.current}
            />
          ) : activeSession ? (
            activeSession.mode === 'terminal' ? (
              <div className="terminal-only-main" data-testid="terminal-only-session" />
            ) : (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div
                  className={`session-workspace-tabs${
                    splitLayoutVisible && activeWorkspaceSplit
                      ? ` session-workspace-tabs--split session-workspace-tabs--split-${activeWorkspaceSplit.direction}`
                      : ''
                  }`}
                  style={
                    splitLayoutVisible && activeWorkspaceSplit
                      ? ({ '--workspace-split-ratio': activeWorkspaceSplit.splitRatio } as React.CSSProperties)
                      : undefined
                  }
                  data-testid="session-workspace-tabs"
                >
                  <div
                    className={tabContentClass(resolveTabVisibility('chat', activeTab, activeWorkspaceSplit))}
                    data-tab="chat"
                  >
                    <WorkspaceSplitPaneClose
                      tab="chat"
                      visibility={resolveTabVisibility('chat', activeTab, activeWorkspaceSplit)}
                      onClose={handleWorkspaceSplitPaneClose}
                    />
                    <div className="chat-tab-wrap" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
                      {activeSessionDisconnected ? (
                        <SessionDisconnectedPanel
                          onReconnect={() => void handleSessionReconnect()}
                          connecting={
                            !activeSession.closedAt && sessions.statuses[activeSession.id] === 'connecting'
                          }
                          connectStatusLabel={
                            activeSessionId
                              ? sessionWorkspace.connectProgressBySession[activeSessionId]?.label ?? null
                              : null
                          }
                        />
                      ) : (
                        <>
                          <SessionMessagesHydrator
                            sessionId={activeSession.id}
                            enabled={!activeSessionDisconnected}
                            loadSessionMessages={sessions.loadSessionMessages}
                          />
                          <SdkToastStack toasts={sessions.sdkToastsBySession[activeSession.id] ?? []} />
                          <SessionChatSurface
                            session={activeSession}
                            pendingJumpMessageId={pendingJumpMessageId}
                            onJumpHandled={handleJumpHandled}
                            transcriptSearchOpen={transcriptSearchOpen}
                            transcriptSearchQuery={transcriptSearchQuery}
                            activeMatchIndex={activeMatchIndex}
                            onMatchCount={setMatchCount}
                            onOpenFileInFiles={openFileInFiles}
                            filePathCandidates={filePathCandidatesForSession(
                              sessionWorkspace.workspaceBySession[activeSession.id]
                            )}
                            bookmarks={sessionBookmarks.bookmarksBySession[activeSession.id] ?? []}
                            onToggleBookmark={toggleActiveBookmark}
                            sdkChrome={sessions.sdkChromeBySession[activeSession.id] ?? null}
                            backgroundTasks={sessions.backgroundTasksBySession[activeSession.id] ?? []}
                            onRespondToPrompt={(requestId, decision) =>
                              void sessions.respondToPrompt(activeSession.id, requestId, decision)
                            }
                            reviewTarget={reviewTarget}
                            onReviewMessage={(message) =>
                              setReviewTarget({
                                sourceId: message.id,
                                kind: 'response',
                                content: message.content
                              })
                            }
                            onReviewPlan={(message, planMarkdown, previousPlanMarkdown) =>
                              setReviewTarget({
                                sourceId: message.id,
                                kind: 'plan',
                                content: planMarkdown,
                                previousContent: previousPlanMarkdown
                              })
                            }
                            onCloseReview={() => setReviewTarget(null)}
                            effectiveTheme={effectiveTheme}
                            onAddComment={appendToActiveComposer}
                            onUpdateComment={replaceInActiveComposer}
                            onDeleteComment={deleteReviewCommentByNote}
                            reviewComments={reviewCommentsBySession[activeSession.id] ?? []}
                            busy={sessions.busyBySession[activeSession.id] ?? false}
                          />
                          {import.meta.env.DEV && (sessions.hookLogBySession[activeSession.id]?.length ?? 0) > 0 && (
                            <div className="sdk-debug-log" data-testid="sdk-debug-log">
                              {(sessions.hookLogBySession[activeSession.id] ?? []).map((line, i) => (
                                <span key={i} className="line">
                                  {line}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </div>

                  {!activeSessionDisconnected && (
                    <>
                      {/* SessionWorkspacePanels renders from the panel-cache-layer above,
                          so it survives note/terminal switches instead of unmounting here. */}
                      <div
                        className={`${tabContentClass(
                          resolveTabVisibility('terminal', activeTab, activeWorkspaceSplit)
                        )} terminal-tab-slot`}
                        data-tab="terminal"
                      >
                        {/* TerminalPanel lives in the terminal-cache-layer above this session subtree.
                            This empty div keeps the tab layout slot; the cache entry overlays it. */}
                      </div>

                      {Boolean(activeSession.hostname) && (
                        <div
                          className={tabContentClass(resolveTabVisibility('ports', activeTab, activeWorkspaceSplit))}
                          data-tab="ports"
                        >
                          {visitedTabs.has('ports') && (
                            <PortsPanel sessionId={activeSession.id} sshHost={activeSession.hostname as string} />
                          )}
                        </div>
                      )}
                      {splitLayoutVisible && activeWorkspaceSplit ? (
                        <WorkspaceSplitDivider
                          splitRatio={activeWorkspaceSplit.splitRatio}
                          direction={activeWorkspaceSplit.direction}
                          onSplitRatioChange={handleWorkspaceSplitRatioChange}
                        />
                      ) : null}
                      <WorkspaceSplitDropOverlay activeEdge={workspaceTabDrag.activeEdge} />
                    </>
                  )}
                </div>
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
          {aliveChatComposers.size > 0 ? (
            <div className="composer-cache" data-testid="composer-cache">
              {[...aliveChatComposers].map((sessionId) => {
                const session = allSessions.find((s) => s.id === sessionId)
                if (!session || session.mode !== 'claude-code') return null
                const composerActive = composerDockVisible && activeSessionId === sessionId
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
                      active={composerActive}
                      onSend={(text, image) => void handleSend(sessionId, text, image)}
                      onInterrupt={() => void handleInterrupt(sessionId)}
                      busy={sessions.busyBySession[sessionId] ?? false}
                      sessionId={sessionId}
                      projectPath={session.projectPath}
                      worktreePath={session.worktreePath}
                      harnessCwd={sessions.harnessCwdBySession[sessionId] ?? null}
                      hostname={session.hostname}
                      gitWorkspacePath={session.worktreePath ?? session.projectPath}
                      diffSummary={ws?.diff}
                      sessionChangesCap={ws?.sessionChangesCap}
                      sessionBookmarks={sessionBookmarks.bookmarksBySession[sessionId] ?? []}
                      mentionFilePaths={mentionPaths}
                      onOpenChangedFile={openChangedFileFromCap}
                      onOpenBookmark={openSessionBookmark}
                      onFork={() => void sessions.forkSession(sessionId).then((forked) => setActiveSessionId(forked.id))}
                      modelSelection={modelSelectionForSession(sessionId, session, modelSelectionBySession, config)}
                      onModelSelectionChange={(selection) => {
                        setModelSelectionBySession((prev) => ({ ...prev, [sessionId]: selection }))
                        void window.atelier.setSessionModelSelection(sessionId, selection)
                      }}
                      liveSlashCommands={sessions.commandsBySession[sessionId] ?? []}
                      liveModels={sessions.modelsBySession[sessionId] ?? []}
                      mode={session.permissionMode}
                      onCycleMode={() => void sessions.cycleMode(sessionId)}
                      queuedMessages={queuedMessagesBySession[sessionId] ?? []}
                      reviewComments={reviewCommentsBySession[sessionId] ?? []}
                      onUpdateReviewCommentBody={(commentId, body) =>
                        updateReviewCommentBody(sessionId, commentId, body)
                      }
                      onDeleteReviewComment={(commentId) => deleteReviewComment(sessionId, commentId)}
                      onCancelQueued={(index) =>
                        setQueuedMessagesBySession((prev) => ({
                          ...prev,
                          [sessionId]: (prev[sessionId] ?? []).filter((_, i) => i !== index)
                        }))
                      }
                      tokenUsage={sessions.tokenUsageBySession[sessionId]}
                      promptSuggestion={sessions.promptSuggestionBySession[sessionId]}
                      rateLimit={sessions.rateLimitBySession[sessionId] ?? null}
                      sdkChrome={sessions.sdkChromeBySession[sessionId] ?? null}
                      onAddLocalMessage={(content) => sessions.addLocalMessage(sessionId, content)}
                      onValidateModel={(model) => sessions.validateModel(sessionId, model)}
                      harnessDisconnected={
                        sessions.statuses[sessionId] === 'startup-idle' || Boolean(session.closedAt)
                      }
                    />
                  </div>
                )
              })}
            </div>
          ) : null}
          </div>
        </div>

        {dailyNotesOpen && date ? (
          <>
            <div
              className="app-panel-resize-handle"
              data-testid="daily-notes-resize-handle"
              onMouseDown={startDailyNotesResize}
            />
            <div
              className="daily-notes-panel-shell"
              data-testid="daily-notes-panel-shell"
              style={{ width: dailyNotesWidth }}
            >
              <DailyNotesSidebar
                date={date}
                onClose={() => void toggleDailyNotesPanel()}
                vaultRoot={config.vault.root || undefined}
                onCreateSessionFromTask={handleCreateSessionFromTask}
              />
            </div>
          </>
        ) : null}
      </div>

      <WorkspaceSplitDragGhost tab={workspaceTabDrag.dragTab} position={workspaceTabDrag.ghost} />

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

      <KeyboardHintsOverlay
        disabled={anyModalOpen}
        scanRootId="app"
        onSessionTabShortcut={handleSessionTabHintShortcut}
      />

      <NewSessionModal
        isOpen={newSessionOpen}
        hosts={sessions.hosts}
        config={config}
        onClose={() => {
          setNewSessionOpen(false)
          setPendingTaskSessionLink(null)
        }}
        onManageProfiles={() => {
          setNewSessionOpen(false)
          setSettingsInitialPane('profiles')
          setSettingsOpen(true)
        }}
        onCreate={async (opts) => {
          const created = await sessions.createSession({
            ...opts,
            suggestedName: pendingTaskSessionLink?.taskText.trim() || opts.suggestedName
          })
          let session = created
          if (pendingTaskSessionLink) {
            session = await sessions.linkDailyTask(
              created.id,
              pendingTaskSessionLink.noteDate,
              pendingTaskSessionLink.taskGid
            )
            setPendingTaskSessionLink(null)
          }
          await selectSession(session)
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
        onClose={() => {
          setSettingsOpen(false)
          void refreshWeeklyPlanStatus()
        }}
        config={config}
        onUpdate={handleConfigUpdate}
        authStatus={sessions.authStatus}
        initialPane={settingsInitialPane}
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
