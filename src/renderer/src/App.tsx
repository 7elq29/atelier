import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import CommandPalette, { type PaletteItem } from './components/CommandPalette'
import SplitOpenPicker, { type SplitPickerItem } from './components/SplitOpenPicker'
import FileQuickOpenPalette from './components/FileQuickOpenPalette'
import KeyboardHintsOverlay from './components/KeyboardHintsOverlay'
import OnboardingWizard from './components/OnboardingWizard'
import Sidebar from './components/Sidebar'
import NewSessionModal from './components/NewSessionModal'
import SettingsPanel from './components/SettingsPanel'
import DailyNotesSidebar from './components/daily-notes/DailyNotesSidebar'
import {
  DeleteAppNoteDialog,
  DeleteSessionLinkedTaskDialog,
  TaskSessionReplaceDialog
} from './components/daily-notes/TaskSessionLinkDialogs'
import TranscriptSearchBar from './components/chat/TranscriptSearchBar'
import Composer, { type ComposerHandle } from './components/chat/Composer'
import SdkToastStack from './components/chat/SdkToastStack'
import WorkspaceToolRail, { type WorkspaceToolTab } from './components/panels/WorkspaceToolRail'
import {
  createSplit,
  isChatTabVisible,
  isSplitLayoutVisible,
  isTerminalTabVisible,
  isWorkspaceSplittableTab,
  resolveTabVisibility,
  splitDirectionForEdge,
  tabContentClass
} from './workspace-split/workspace-split-logic'
import type { WorkspaceSplitState } from './workspace-split/workspace-split-types'
import type { WorkspaceSecondaryTab } from './workspace-split/workspace-split-types'
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
import type { TerminalPanelHandle } from './components/panels/TerminalPanel'
import type { DiffPanelHandle } from './components/panels/DiffPanel'
import type { FilesPanelHandle } from './components/panels/FilesPanel'
import TitleBar from './components/TitleBar'
import SessionDisconnectedPanel from './components/SessionDisconnectedPanel'
import { SessionWorkspacePanels } from './components/session/SessionWorkspacePanels'
import { SessionChatSurface } from './components/session/SessionChatSurface'
import { SessionMessagesHydrator } from './components/session/SessionMessagesHydrator'
import { getSessionMessages, hasSessionMessages } from './stores/session-messages-store'
import { useConfig } from './hooks/useConfig'
import { defaultClaudeModelFromConfig, defaultClaudeEffortFromConfig, type AtelierConfig } from '../../shared/config'
import { TOKEN_CSS_VARS, type CustomThemeColors } from '../../shared/theme-types'
import { useSessions } from './hooks/useSessions'
import { useSessionWorkspace } from './hooks/useSessionWorkspace'
import { useSessionBookmarks } from './hooks/useSessionBookmarks'
import { useSessionPromptDotsMap } from './hooks/useSessionMessages'
import CollapsedAlertChip from './components/CollapsedAlertChip'
import { sessionLiveWaitingForInput, sessionDotStatus } from './components/Sidebar'
import { truncateContextPath } from './utils/truncateContextPath'
import { sessionWorkspaceLabel } from './utils/sessionWorkspaceLabel'
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
  FileAttachment,
  ModelSelection,
  SessionRecord,
  SessionTab,
  SessionStatus
} from '../../shared/session-types'
import { restorableSessionTab } from '../../shared/session-types'
import { parseStructuredContent } from '../../shared/chat-content'
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
    filesList: ws.filesList ?? undefined,
    filesTree: ws.filesTree ?? undefined,
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

/**
 * A claude-code session whose harness has finished coming up, so the user can
 * actually send something (session-ready-hint). Deliberately not "status is
 * idle": a session started from an initial prompt goes straight to `working`,
 * and it is just as ready to be chatted with.
 */
function sessionReadyToChat(
  session: SessionRecord | undefined,
  status: SessionStatus | undefined
): boolean {
  if (!session || session.mode !== 'claude-code' || session.closedAt) return false
  if (!status) return false
  return status !== 'connecting' && status !== 'creating-worktree' && status !== 'startup-idle' && status !== 'disconnected'
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
  const [todayNoteExists, setTodayNoteExists] = useState<boolean | null>(null)
  const calendarDateRef = useRef<string | null>(null)
  const { config, loaded, updateConfig } = useConfig()
  // Keep a ref to the latest config so IPC callbacks (which close over the
  // initial value) can always read the current persisted state without being
  // re-registered on every render.
  const configRef = useRef(config)
  useEffect(() => { configRef.current = config }, [config])

  // ── Collapsed-sidebar alert chips + sidebar corner-dot (shared state) ────
  const promptDotsBySession = useSessionPromptDotsMap()

  // waitingInputAlertIds state block is declared below allSessions (deps ordering).
  const sessions = useSessions()
  const sessionWorkspace = useSessionWorkspace()
  const sessionBookmarks = useSessionBookmarks()
  const appNotes = useAppNotes()
  const appBookmarks = useAppBookmarks()

  const [paletteOpen, setPaletteOpen] = useState(false)
  const [splitOpenPickerOpen, setSplitOpenPickerOpen] = useState(false)
  const [bufferSwitcherOpen, setBufferSwitcherOpen] = useState(false)
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
  const [deleteAppNotePrompt, setDeleteAppNotePrompt] = useState<{ id: string; title: string } | null>(null)
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [activeAppNoteId, setActiveAppNoteId] = useState<string | null>(null)
  const [appNoteSyncById, setAppNoteSyncById] = useState<
    Record<string, 'synced' | 'saving' | 'error'>
  >({})
  const appNoteSyncVersionRef = useRef(new Map<string, number>())
  const [activeDailyNoteDate, setActiveDailyNoteDate] = useState<string | null>(null)
  const [dailyNoteHeaderHost, setDailyNoteHeaderHost] = useState<HTMLDivElement | null>(null)
  const [activeWeeklyPlanOpen, setActiveWeeklyPlanOpen] = useState(false)
  const [weeklyPlanStatus, setWeeklyPlanStatus] = useState<WeeklyPlanStatus | null>(null)
  const [weeklyPlanContext, setWeeklyPlanContext] = useState<
    (WeeklyPlanWizardContext & { initialData: WeeklyPlanWizardData }) | null
  >(null)
  const [weeklyPlanExistsHint, setWeeklyPlanExistsHint] = useState<string | null>(null)
  const [weeklyPlanViewDoc, setWeeklyPlanViewDoc] = useState<WeeklyPlanViewResult | null>(null)
  const composerRefs = useRef<Map<string, ComposerHandle>>(new Map())
  const filesPanelRefs = useRef<Map<string, FilesPanelHandle>>(new Map())
  const diffPanelRefs = useRef<Map<string, DiffPanelHandle>>(new Map())
  const tabTerminalRefs = useRef<Map<string, TerminalPanelHandle>>(new Map())
  const composerCacheRef = useRef<HTMLDivElement>(null)
  const [activeComposerHeight, setActiveComposerHeight] = useState(0)
  /** Launch-local caret positions; deliberately never persisted to disk. */
  const noteCursorPositionsRef = useRef(new Map<string, number>())
  /** Picker overrides until the next session-list refresh picks up persisted model columns. */
  const [modelSelectionBySession, setModelSelectionBySession] = useState<Record<string, ModelSelection>>({})
  const [activeTab, setActiveTab] = useState<SessionTab>('chat')
  const [visitedTabs, setVisitedTabs] = useState<Set<SessionTab>>(new Set(['chat']))
  /**
   * Last tab per session for this launch (remember-session-tab). The same value
   * is persisted to SQLite, but the session records in memory aren't refetched
   * on a tab click, so this map — not `session.activeTab` — is what a
   * same-launch session switch reads back.
   */
  const sessionTabsRef = useRef<Map<string, SessionTab>>(new Map())
  const [appToast, setAppToast] = useState<string | null>(null)
  /**
   * Sessions created this launch that have not yet finished connecting
   * (session-ready-hint). Only these get the ready announcement — a session
   * reconnecting after a relaunch is resuming work the user already knows about.
   */
  const pendingReadySessionsRef = useRef<Set<string>>(new Set())
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
  const toggleTranscriptSearchRef = useRef<() => void>(() => undefined)
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
    void (async () => {
      const initialDate = await window.atelier.getDefaultDate()
      calendarDateRef.current = initialDate
      const { exists } = await window.atelier.checkDailyNoteExists(initialDate)
      setTodayNoteExists(exists)
      if (exists) setDate(initialDate)
    })()
  }, [])

  const refreshWeeklyPlanStatus = useCallback(async () => {
    const status = await window.atelier.getWeeklyPlanStatus()
    setWeeklyPlanStatus(status)
  }, [])

  useEffect(() => {
    const applyCalendarDay = (nextDate: string): void => {
      if (calendarDateRef.current === nextDate) return
      calendarDateRef.current = nextDate

      // Null means the surface is closed. Preserve that state while retargeting
      // every open "today" surface to the new day.
      setDate((current) => (current === null ? null : nextDate))
      setActiveDailyNoteDate((current) => (current === null ? null : nextDate))

      void (async () => {
        try {
          // Re-check whether the new day's note exists so the badge updates.
          const { exists: noteExists } = await window.atelier.checkDailyNoteExists(nextDate)
          setTodayNoteExists(noteExists)
          // If the panel was open and the new day has no note, close it to avoid the empty state.
          if (!noteExists) setDate(null)

          const status = await window.atelier.getWeeklyPlanStatus()
          setWeeklyPlanStatus(status)

          if (activeWeeklyPlanOpen) {
            if (status.fileExists) {
              const doc = await window.atelier.readWeeklyPlanNote(status.isoWeek)
              setActiveWeeklyPlanOpen(false)
              setWeeklyPlanContext(null)
              setWeeklyPlanViewDoc(doc)
            } else {
              const context = await window.atelier.loadWeeklyPlanContext()
              setWeeklyPlanContext(context)
              setWeeklyPlanViewDoc(null)
            }
          } else if (weeklyPlanViewDoc !== null) {
            if (status.fileExists) {
              setWeeklyPlanViewDoc(await window.atelier.readWeeklyPlanNote(status.isoWeek))
            } else {
              setWeeklyPlanViewDoc(null)
            }
          }
        } catch (err) {
          window.atelier.log('warn', 'calendar day weekly refresh failed', {
            error: err instanceof Error ? err.message : String(err)
          })
        }
      })()
    }

    const unsubscribe = window.atelier.onCalendarDayChanged(({ date: nextDate }) => {
      applyCalendarDay(nextDate)
    })
    const onFocus = (): void => {
      void window.atelier.getDefaultDate().then(applyCalendarDay)
    }
    window.addEventListener('focus', onFocus)

    return () => {
      unsubscribe()
      window.removeEventListener('focus', onFocus)
    }
  }, [activeWeeklyPlanOpen, weeklyPlanViewDoc])

  useEffect(() => {
    if (!loaded) return
    void refreshWeeklyPlanStatus()
  }, [loaded, refreshWeeklyPlanStatus])

  // Track which split pane is active via a body data attribute so CSS can
  // lighten the inactive pane. Uses both focusin (keyboard) and pointerdown
  // (click on non-focusable areas) since focusin alone doesn't fire for clicks
  // on the transcript or tool panel backgrounds.
  useEffect(() => {
    function setActivePanel(target: EventTarget | null): void {
      const el = target as HTMLElement | null
      const panel = el?.closest<HTMLElement>('[data-panel]')?.dataset.panel
      if (panel === 'chat') {
        document.body.dataset.splitActivePanel = 'primary'
      } else if (panel) {
        document.body.dataset.splitActivePanel = 'secondary'
      } else {
        // Fallback: click on the transcript area (no data-panel) — check which
        // split pane container the target lives in.
        const pane = el?.closest<HTMLElement>(
          '.workspace-split-pane--primary, .workspace-split-pane--secondary'
        )
        if (pane?.classList.contains('workspace-split-pane--primary')) {
          document.body.dataset.splitActivePanel = 'primary'
        } else if (pane?.classList.contains('workspace-split-pane--secondary')) {
          document.body.dataset.splitActivePanel = 'secondary'
        }
      }
    }
    const onFocusin = (e: FocusEvent) => setActivePanel(e.target)
    const onPointerdown = (e: PointerEvent) => setActivePanel(e.target)
    document.addEventListener('focusin', onFocusin)
    // Use capture so React components that call stopPropagation() don't prevent this from firing.
    document.addEventListener('pointerdown', onPointerdown, { capture: true })
    return () => {
      document.removeEventListener('focusin', onFocusin)
      document.removeEventListener('pointerdown', onPointerdown, { capture: true })
    }
  }, [])

  const handleConfigUpdate = useCallback(
    (partial: Partial<AtelierConfig>): Promise<AtelierConfig> => {
      return updateConfig(partial).then((saved) => {
        if (partial.vault !== undefined) {
          setWeeklyPlanExistsHint(null)
          void refreshWeeklyPlanStatus()
          void appNotes.reload()
        }
        return saved
      })
    },
    [updateConfig, refreshWeeklyPlanStatus, appNotes.reload]
  )

  useEffect(() => {
    return window.atelier.onPtyShellContext(({ id, remoteHost }) => {
      setTerminalShellHostBySessionId((prev) => {
        if (prev[id] === remoteHost) return prev
        return { ...prev, [id]: remoteHost }
      })
    })
  }, [])

  // Theme: sets `data-theme` on <html> — the single source of truth for all
  // CSS custom properties in tokens.css.  When a custom theme is active we also
  // write its color tokens as inline properties on documentElement (which take
  // precedence over the stylesheet values), removing all of them first so
  // switching themes never leaves stale overrides.
  useEffect(() => {
    const el = document.documentElement
    // Always clear previous custom-property overrides first.
    for (const cssVar of Object.values(TOKEN_CSS_VARS)) {
      el.style.removeProperty(cssVar)
    }
    const activeTheme = (config.customThemes ?? []).find((t) => t.id === config.activeCustomThemeId)
    if (activeTheme) {
      el.setAttribute('data-theme', activeTheme.base)
      for (const [key, cssVar] of Object.entries(TOKEN_CSS_VARS)) {
        const val = activeTheme.colors[key as keyof typeof activeTheme.colors]
        if (val) el.style.setProperty(cssVar, val)
      }
    } else {
      el.setAttribute('data-theme', resolveEffectiveTheme(config.theme))
    }
  }, [config.theme, config.activeCustomThemeId, config.customThemes])

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

  // Detached theme-editor window events ─────────────────────────────────────
  // Live preview: apply colors as the user picks them in the editor window.
  useEffect(() => {
    return window.atelier.onThemeEditorPreview((colors: CustomThemeColors, base: 'light' | 'dark') => {
      const el = document.documentElement
      el.setAttribute('data-theme', base)
      for (const [key, cssVar] of Object.entries(TOKEN_CSS_VARS)) {
        const val = colors[key as keyof CustomThemeColors]
        if (val) el.style.setProperty(cssVar, val)
        else el.style.removeProperty(cssVar)
      }
    })
  }, [])

  // Save: persist the new/edited theme and make it active.
  useEffect(() => {
    return window.atelier.onThemeEditorSaved((theme) => {
      const cfg = configRef.current
      const existing = cfg.customThemes ?? []
      const next = existing.some((t) => t.id === theme.id)
        ? existing.map((t) => (t.id === theme.id ? theme : t))
        : [...existing, theme]
      void updateConfig({ customThemes: next, activeCustomThemeId: theme.id })
    })
  }, [updateConfig])

  // Delete: remove the theme; fall back to the built-in if it was active.
  useEffect(() => {
    return window.atelier.onThemeEditorDeleted((id) => {
      const cfg = configRef.current
      const next = (cfg.customThemes ?? []).filter((t) => t.id !== id)
      const wasActive = cfg.activeCustomThemeId === id
      void updateConfig({ customThemes: next, activeCustomThemeId: wasActive ? null : cfg.activeCustomThemeId })
    })
  }, [updateConfig])

  // Cancel: revert inline CSS to the persisted theme without touching config.
  useEffect(() => {
    return window.atelier.onThemeEditorCancelled(() => {
      const cfg = configRef.current
      const el = document.documentElement
      for (const cssVar of Object.values(TOKEN_CSS_VARS)) el.style.removeProperty(cssVar)
      const active = (cfg.customThemes ?? []).find((t) => t.id === cfg.activeCustomThemeId)
      if (active) {
        el.setAttribute('data-theme', active.base)
        for (const [key, cssVar] of Object.entries(TOKEN_CSS_VARS)) {
          const val = active.colors[key as keyof typeof active.colors]
          if (val) el.style.setProperty(cssVar, val)
        }
      } else {
        el.setAttribute('data-theme', resolveEffectiveTheme(cfg.theme))
      }
    })
  }, [])

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
        if (e.code === 'KeyS') {
          const session = activeSessionRef.current
          if (session?.mode === 'claude-code' && !activeAppNoteIdRef.current) {
            e.preventDefault()
            toggleTranscriptSearchRef.current()
          }
          return
        }
      }
      // Ctrl+X chords: O / 1 / 0 / K (bare second key, Emacs style)
      if (!e.ctrlKey && !e.metaKey && !e.altKey && fileQuickOpenChordAtRef.current != null) {
        const elapsed = Date.now() - fileQuickOpenChordAtRef.current
        if (elapsed <= 1500) {
          if (e.code === 'KeyO') {
            fileQuickOpenChordAtRef.current = null
            const session = activeSessionRef.current
            if (session?.mode === 'claude-code' && !activeAppNoteIdRef.current && !anyModalOpenRef.current) {
              const split = activeWorkspaceSplitRef.current
              const tab = activeTabRef.current
              const ORDER: SessionTab[] = ['chat', 'diff', 'files', 'terminal', 'ports']
              const visible = ORDER.filter((t) => resolveTabVisibility(t, tab, split) !== 'hidden')
              if (visible.length > 1) {
                e.preventDefault()
                const currentPanel = (document.activeElement as HTMLElement | null)
                  ?.closest<HTMLElement>('[data-panel]')
                  ?.dataset.panel as SessionTab | undefined
                const currentIdx = currentPanel ? visible.indexOf(currentPanel) : -1
                const nextPanel = visible[(currentIdx + 1) % visible.length]
                switch (nextPanel) {
                  case 'chat':
                    composerRefs.current.get(session.id)?.focus()
                    break
                  case 'files':
                    filesPanelRefs.current.get(session.id)?.focus()
                    break
                  case 'diff':
                    diffPanelRefs.current.get(session.id)?.focus()
                    break
                  case 'terminal': {
                    const ptyId = `${session.id}:tab-terminal`
                    tabTerminalRefs.current.get(ptyId)?.focus()
                    break
                  }
                }
              }
            }
            return
          }
          if (e.code === 'Digit1') {
            fileQuickOpenChordAtRef.current = null
            const session = activeSessionRef.current
            if (session?.mode === 'claude-code' && !anyModalOpenRef.current) {
              const split = activeWorkspaceSplitRef.current
              if (split && !split.fullscreenTab) {
                const focusedPanel = (document.activeElement as HTMLElement | null)
                  ?.closest<HTMLElement>('[data-panel]')
                  ?.dataset.panel as string | undefined
                if (split.secondaryTab !== 'app-note' && focusedPanel === split.secondaryTab) {
                  // Focused on secondary: fullscreen it (keep only this pane)
                  e.preventDefault()
                  handleWorkspaceToolToggleMaximizeRef.current(split.secondaryTab)
                } else if (focusedPanel === 'chat') {
                  // Focused on primary: close the split so chat is the only pane
                  e.preventDefault()
                  handleWorkspaceSplitPaneCloseRef.current(split.secondaryTab as SessionTab)
                }
              }
            }
            return
          }
          if (e.code === 'Digit2') {
            fileQuickOpenChordAtRef.current = null
            const session = activeSessionRef.current
            if (session?.mode === 'claude-code' && !anyModalOpenRef.current) {
              e.preventDefault()
              setSplitOpenPickerOpen(true)
            }
            return
          }
          if (e.code === 'KeyB') {
            fileQuickOpenChordAtRef.current = null
            if (!anyModalOpenRef.current) {
              e.preventDefault()
              setBufferSwitcherOpen(true)
            }
            return
          }
          if (e.code === 'Digit0') {
            fileQuickOpenChordAtRef.current = null
            const session = activeSessionRef.current
            if (session?.mode === 'claude-code' && !anyModalOpenRef.current) {
              const split = activeWorkspaceSplitRef.current
              if (split && split.secondaryTab !== 'app-note' && split.fullscreenTab === split.secondaryTab) {
                e.preventDefault()
                handleWorkspaceToolToggleMaximizeRef.current(split.secondaryTab)
              }
            }
            return
          }
          if (e.code === 'KeyK') {
            fileQuickOpenChordAtRef.current = null
            const session = activeSessionRef.current
            if (session?.mode === 'claude-code' && !anyModalOpenRef.current) {
              const split = activeWorkspaceSplitRef.current
              if (split) {
                if (split.fullscreenTab === split.secondaryTab) {
                  // Secondary pane is fullscreened — close directly, no focus check needed.
                  e.preventDefault()
                  handleWorkspaceSplitPaneCloseRef.current(split.secondaryTab as SessionTab)
                } else if (!split.fullscreenTab) {
                  // Split is visible — only close if focus is in the secondary pane.
                  const focusedPanel = (document.activeElement as HTMLElement | null)
                    ?.closest<HTMLElement>('[data-panel]')
                    ?.dataset.panel as string | undefined
                  if (focusedPanel === split.secondaryTab) {
                    e.preventDefault()
                    handleWorkspaceSplitPaneCloseRef.current(split.secondaryTab as SessionTab)
                  }
                }
              }
            }
            return
          }
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
          setSplitOpenPickerOpen(false)
          setBufferSwitcherOpen(false)
          setSettingsOpen(false)
          setNewSessionOpen(false)
          setFileQuickOpenOpen(false)
          return
        }
        // Idle session or no session: still close any modals that happen to
        // be open (redundant when anyModalOpen is false, but harmless).
        setPaletteOpen(false)
        setSplitOpenPickerOpen(false)
        setBufferSwitcherOpen(false)
        setSettingsOpen(false)
        setNewSessionOpen(false)
        setReplaceLinkedDialogOpen(false)
        setPendingTaskSessionLink(null)
        setDeleteLinkedPrompt(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [])

  const allSessions = useMemo(
    () => [...sessions.activeSessions, ...sessions.historySessions],
    [sessions.activeSessions, sessions.historySessions]
  )

  // Tracks sessions that transitioned into waiting-input while not active and
  // have not yet been dismissed. This is the same signal as the orange corner
  // dot on session rows — lifted here so the collapsed-sidebar chips and the
  // sidebar row indicator use the same source of truth.
  const [waitingInputAlertIds, setWaitingInputAlertIds] = useState<Set<string>>(() => new Set())
  const prevDotStatusBySessionRef = useRef<Record<string, string>>({})

  useEffect(() => {
    setWaitingInputAlertIds((prev) => {
      let next: Set<string> | null = null
      const touch = (): Set<string> => { if (!next) next = new Set(prev); return next! }
      for (const session of sessions.activeSessions) {
        const dotStatus = sessionDotStatus(
          session, false, sessions.statuses, sessions.staleSessionIds, promptDotsBySession[session.id] ?? null
        )
        const prevStatus = prevDotStatusBySessionRef.current[session.id]
        if (
          dotStatus === 'waiting-input' &&
          sessionLiveWaitingForInput(session, false, sessions.statuses) &&
          prevStatus !== undefined &&
          prevStatus !== 'waiting-input' &&
          session.id !== activeSessionId
        ) {
          touch().add(session.id)
        }
        prevDotStatusBySessionRef.current[session.id] = dotStatus
      }
      for (const id of prev) {
        const session = sessions.activeSessions.find((s) => s.id === id)
        if (!session || !sessionLiveWaitingForInput(session, false, sessions.statuses)) touch().delete(id)
      }
      return next ?? prev
    })
  }, [sessions.activeSessions, sessions.statuses, promptDotsBySession, sessions.staleSessionIds, activeSessionId])

  useEffect(() => {
    if (!activeSessionId) return
    setWaitingInputAlertIds((prev) => {
      if (!prev.has(activeSessionId)) return prev
      const next = new Set(prev)
      next.delete(activeSessionId)
      return next
    })
  }, [activeSessionId])

  const clearWaitingInputAlert = useCallback((sessionId: string) => {
    setWaitingInputAlertIds((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  /**
   * Sessions that need the user's attention while the sidebar is fully hidden.
   * 'blocked' = waiting for permission / approval / plan confirm.
   * 'ready'   = agent finished its turn, waiting for the next message.
   * Only non-active sessions are included — the active session's state is
   * already visible in the main panel.
   */
  const collapsedAlerts = useMemo(() => {
    if (!config.sidebarCollapsed) return null
    const blocked: (typeof allSessions)[0][] = []
    const ready: (typeof allSessions)[0][] = []
    for (const session of allSessions) {
      if (session.deletedAt || session.id === activeSessionId) continue
      const promptDot = promptDotsBySession[session.id] ?? null
      if (promptDot === 'waiting-blocked') {
        blocked.push(session)
      } else if (waitingInputAlertIds.has(session.id)) {
        // Only show "agent ready" when the user hasn't yet seen the response
        // (same transient signal as the orange corner dot on session rows).
        ready.push(session)
      }
    }
    return blocked.length + ready.length > 0 ? { blocked, ready } : null
  }, [config.sidebarCollapsed, allSessions, activeSessionId, promptDotsBySession, waitingInputAlertIds])

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
      sessionTabsRef.current.delete(id)
    },
    [sessionBookmarks, sessionWorkspace]
  )

  /**
   * Switches the workspace tab and remembers it for the session, in memory for
   * this launch and in SQLite for the next one (remember-session-tab). Every
   * user-driven tab change goes through here; restoring a remembered tab on
   * session select deliberately does not, so it can't overwrite what it read.
   */
  const rememberActiveTab = useCallback((sessionId: string | null, tab: SessionTab) => {
    setActiveTab(tab)
    setVisitedTabs((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)))
    if (!sessionId) return
    sessionTabsRef.current.set(sessionId, tab)
    void window.atelier.setSessionActiveTab(sessionId, tab)
  }, [])

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
    // remember-session-tab: come back to the tab this session was left on. Chat
    // stays in `visitedTabs` so its transcript is mounted either way; the
    // restored tab joins it because Ports only mounts once visited.
    const restoredTab = restorableSessionTab(
      sessionTabsRef.current.get(session.id) ?? session.activeTab,
      session.hostname
    )
    setActiveTab(restoredTab)
    setVisitedTabs(new Set<SessionTab>(['chat', restoredTab]))
    setWorkspaceSplitBySession((prev) => {
      if (restoredTab === 'chat') {
        const { [session.id]: _removed, ...rest } = prev
        return rest
      }
      const split = createSplit('chat', restoredTab, prev[session.id]?.splitRatio ?? 0.5, 'row')
      return split ? { ...prev, [session.id]: split } : prev
    })
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

  const checkTodayNoteExists = useCallback(async () => {
    const d = await window.atelier.getDefaultDate()
    const { exists } = await window.atelier.checkDailyNoteExists(d)
    setTodayNoteExists(exists)
  }, [])

  const toggleDailyNotesPanel = useCallback(async () => {
    if (date) {
      setDate(null)
      void checkTodayNoteExists()
      return
    }
    const d = await window.atelier.getDefaultDate()
    if (todayNoteExists === false) {
      await window.atelier.createDailyNote(d)
      setTodayNoteExists(true)
    }
    setDate(d)
  }, [date, todayNoteExists, checkTodayNoteExists])

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
    try {
      const note = await appNotes.createNote()
      setActiveDailyNoteDate(null)
      setActiveWeeklyPlanOpen(false)
      setWeeklyPlanViewDoc(null)
      setActiveAppNoteId(note.id)
    } catch (error) {
      setSettingsInitialPane('vault')
      setSettingsOpen(true)
      setAppToast(error instanceof Error ? error.message : 'Configure an Obsidian vault before creating a note.')
    }
  }, [appNotes])

  const markAppNoteSaving = useCallback((noteId: string): number => {
    const version = (appNoteSyncVersionRef.current.get(noteId) ?? 0) + 1
    appNoteSyncVersionRef.current.set(noteId, version)
    setAppNoteSyncById((prev) => ({ ...prev, [noteId]: 'saving' }))
    return version
  }, [])

  const updateAppNoteWithSync = useCallback(
    async (
      noteId: string,
      patch: { title?: string; content?: string },
      pendingVersion?: number
    ): Promise<void> => {
      const version = pendingVersion ?? markAppNoteSaving(noteId)
      try {
        await appNotes.updateNote(noteId, patch)
        if (appNoteSyncVersionRef.current.get(noteId) === version) {
          setAppNoteSyncById((prev) => ({ ...prev, [noteId]: 'synced' }))
        }
      } catch (error) {
        if (appNoteSyncVersionRef.current.get(noteId) === version) {
          setAppNoteSyncById((prev) => ({ ...prev, [noteId]: 'error' }))
        }
        throw error
      }
    },
    [appNotes, markAppNoteSaving]
  )

  const deleteAppNote = useCallback(
    async (noteId: string, permanently = false) => {
      const other = appNotes.notes.filter((n) => n.id !== noteId)
      if (activeAppNoteId === noteId) {
        setActiveAppNoteId(other[0]?.id ?? null)
      }
      noteCursorPositionsRef.current.delete(`app:${noteId}`)
      appNoteSyncVersionRef.current.delete(noteId)
      setAppNoteSyncById((prev) => {
        const { [noteId]: _removed, ...rest } = prev
        return rest
      })
      await appNotes.deleteNote(noteId, permanently)
    },
    [activeAppNoteId, appNotes]
  )

  const requestDeleteAppNote = useCallback(
    (noteId: string) => {
      const note = appNotes.notes.find((candidate) => candidate.id === noteId)
      if (note) setDeleteAppNotePrompt({ id: note.id, title: note.title || 'Untitled note' })
    },
    [appNotes.notes]
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
      if (!sessionId) return
      if (tab === 'chat') {
        setReviewTarget(null)
        setWorkspaceSplitBySession((prev) => {
          const { [sessionId]: _removed, ...rest } = prev
          return rest
        })
        rememberActiveTab(sessionId, 'chat')
        return
      }
      const splitRatio = workspaceSplitBySession[sessionId]?.splitRatio ?? 0.5
      const nextSplit = createSplit('chat', tab, splitRatio, 'row')
      if (!nextSplit) return
      setReviewTarget(null)
      setWorkspaceSplitBySession((prev) => ({ ...prev, [sessionId]: nextSplit }))
      rememberActiveTab(sessionId, tab)
    },
    [activeSession, activeSessionId, rememberActiveTab, sessions.statuses, workspaceSplitBySession]
  )

  const activeWorkspaceSplit = activeSessionId ? workspaceSplitBySession[activeSessionId] ?? null : null
  const splitLayoutVisible = isSplitLayoutVisible(activeWorkspaceSplit)

  // Seed the active-panel attribute whenever a split appears or the session changes,
  // so the CSS contrast is visible immediately without requiring a click first.
  // The click/focusin listeners in the earlier effect will override this as the user interacts.
  useEffect(() => {
    if (activeWorkspaceSplit) {
      document.body.dataset.splitActivePanel = 'primary'
    } else {
      delete document.body.dataset.splitActivePanel
    }
  }, [activeWorkspaceSplit, activeSessionId])
  const activeWorkspaceTool = useMemo<WorkspaceToolTab | null>(() => {
    if (!activeWorkspaceSplit) return null
    const secondaryToolTab =
      activeWorkspaceSplit.secondaryTab !== 'app-note' ? activeWorkspaceSplit.secondaryTab : null
    const visible = [
      activeWorkspaceSplit.fullscreenTab,
      secondaryToolTab,
      activeWorkspaceSplit.primaryTab
    ].find((tab): tab is WorkspaceToolTab => Boolean(tab && tab !== 'chat'))
    return visible ?? null
  }, [activeWorkspaceSplit])

  /** Tool close always returns to the owning Chat pane. */
  const handleWorkspaceSplitPaneClose = useCallback(
    (_tab: SessionTab) => {
      if (!activeSessionId) return
      setWorkspaceSplitBySession((prev) => {
        const { [activeSessionId]: _removed, ...rest } = prev
        return rest
      })
      rememberActiveTab(activeSessionId, 'chat')
      requestAnimationFrame(() => composerRefs.current.get(activeSessionId)?.focus())
    },
    [activeSessionId, rememberActiveTab]
  )

  const toggleWorkspaceTool = useCallback(
    (tab: WorkspaceToolTab) => {
      if (tab === 'ports' && !activeSession?.hostname) return
      if (activeWorkspaceTool === tab) {
        handleWorkspaceSplitPaneClose(tab)
        return
      }
      selectTab(tab)
    },
    [activeSession?.hostname, activeWorkspaceTool, handleWorkspaceSplitPaneClose, selectTab]
  )

  const handleWorkspaceToolToggleMaximize = useCallback(
    (tab: SessionTab) => {
      if (!activeSessionId || tab === 'chat') return
      setWorkspaceSplitBySession((prev) => {
        const split = prev[activeSessionId]
        if (!split || (split.primaryTab !== tab && split.secondaryTab !== tab)) return prev
        return {
          ...prev,
          [activeSessionId]: {
            ...split,
            fullscreenTab: split.fullscreenTab === tab ? null : tab
          }
        }
      })
    },
    [activeSessionId]
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
      rememberActiveTab(activeSessionId, primaryTab)
      setVisitedTabs((prev) => (prev.has(secondaryTab) ? prev : new Set(prev).add(secondaryTab)))
    },
    [activeSessionId, activeTab, rememberActiveTab, workspaceSplitBySession]
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

  /**
   * Announces a newly created session the moment its harness is up
   * (session-ready-hint). The transcript's own hint covers the session you are
   * looking at; this covers the one you already navigated away from, which
   * otherwise finishes connecting completely silently.
   */
  useEffect(() => {
    if (pendingReadySessionsRef.current.size === 0) return
    for (const sessionId of [...pendingReadySessionsRef.current]) {
      const session = allSessions.find((s) => s.id === sessionId)
      if (!session) {
        pendingReadySessionsRef.current.delete(sessionId)
        continue
      }
      if (!sessionReadyToChat(session, sessions.statuses[sessionId])) continue
      pendingReadySessionsRef.current.delete(sessionId)
      if (sessionId === activeSessionId) {
        if (!hasSessionMessages(sessionId)) composerRefs.current.get(sessionId)?.focus()
      } else {
        setAppToast(`Session ready to chat — ${sessionWorkspaceLabel(session)}`)
      }
    }
  }, [activeSessionId, allSessions, sessions.statuses])

  useEffect(() => {
    if (!appToast) return
    const timer = setTimeout(() => setAppToast(null), 2600)
    return () => clearTimeout(timer)
  }, [appToast])

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
      if (tab === 'chat') {
        selectTab(tab)
        return
      }
      toggleWorkspaceTool(tab)
    },
    [selectTab, toggleWorkspaceTool]
  )

  const openNoteInSplit = useCallback(
    (noteId: string) => {
      if (!activeSessionId) return
      setWorkspaceSplitBySession((prev) => {
        const existing = prev[activeSessionId]
        const ratio = existing?.splitRatio ?? 0.5
        const next = createSplit('chat', 'app-note', ratio, 'row', noteId)
        if (!next) return prev
        return { ...prev, [activeSessionId]: next }
      })
    },
    [activeSessionId]
  )

  const selectAppNoteInSplit = useCallback(
    (noteId: string) => {
      if (!activeSessionId) return
      setWorkspaceSplitBySession((prev) => {
        const existing = prev[activeSessionId]
        if (!existing || existing.secondaryTab !== 'app-note') return prev
        return { ...prev, [activeSessionId]: { ...existing, secondaryAppNoteId: noteId } }
      })
    },
    [activeSessionId]
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

      selectTab('chat')
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
      selectTab,
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
  toggleTranscriptSearchRef.current = toggleTranscriptSearch

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
      ...(activeWorkspacePath &&
      activeSession?.mode === 'claude-code' &&
      !claudeCodeSessionDisconnected(activeSession, activeSessionId, sessions.statuses)
        ? [
            {
              id: 'open-workspace-diff',
              label: 'Open Diff',
              category: 'Workspace',
              run: () => selectTab('diff')
            },
            {
              id: 'open-workspace-files',
              label: 'Open Files',
              category: 'Workspace',
              run: () => selectTab('files')
            },
            {
              id: 'open-workspace-terminal',
              label: 'Open Terminal',
              category: 'Workspace',
              run: () => selectTab('terminal')
            },
            ...(activeSession.hostname
              ? [
                  {
                    id: 'open-workspace-ports',
                    label: 'Open Ports',
                    category: 'Workspace',
                    run: () => selectTab('ports')
                  }
                ]
              : [])
          ]
        : []),
      ...allSessions.map((session) => ({
        id: `session-${session.id}`,
        label: session.name,
        category: 'Session',
        run: () => void selectSession(session)
      }))
    ],
    [
      config.theme,
      config.sidebarCollapsed,
      activeWorkspacePath,
      activeSession,
      activeSessionId,
      sessions.statuses,
      selectTab,
      allSessions,
      toggleDailyNotesPanel
    ]
  )

  const splitPickerItems = useMemo<SplitPickerItem[]>(() => {
    if (!activeSession || activeSession.mode !== 'claude-code') return []
    if (claudeCodeSessionDisconnected(activeSession, activeSessionId, sessions.statuses)) return []
    const ws = activeSessionId ? sessionWorkspace.workspaceBySession[activeSessionId] : undefined
    const items: SplitPickerItem[] = []

    // Workspace tools
    items.push(
      { id: 'split-diff', label: 'Diff', category: 'Workspace', run: () => selectTab('diff') },
      { id: 'split-files', label: 'Files', category: 'Workspace', run: () => selectTab('files') },
      { id: 'split-terminal', label: 'Terminal', category: 'Workspace', run: () => selectTab('terminal') }
    )
    if (activeSession.hostname) {
      items.push({ id: 'split-ports', label: 'Ports', category: 'Workspace', run: () => selectTab('ports') })
    }

    // Notes (app notes only — daily note and weekly plan are separate systems)
    for (const note of appNotes.notes) {
      items.push({
        id: `split-note-${note.id}`,
        label: note.title || 'Untitled',
        category: 'Notes',
        run: () => openNoteInSplit(note.id)
      })
    }

    // Session items: changed files, plan, bookmarks
    const capItems = ws?.sessionChangesCap?.items ?? []
    const bookmarkItems = activeSessionId ? (sessionBookmarks.bookmarksBySession[activeSessionId] ?? []) : []
    for (const item of capItems) {
      if (item.kind !== 'file') continue
      const basename = item.path.replace(/\\/g, '/').split('/').pop() ?? item.path
      if (isClaudePlanPath(item.path)) {
        items.push({
          id: `split-plan-${item.path}`,
          label: 'Plan',
          hint: item.path,
          category: 'Session',
          run: () => openChangedFileInDiff(item.path)
        })
      } else {
        items.push({
          id: `split-changed-${item.path}`,
          label: basename,
          hint: item.path,
          category: 'Session',
          run: () =>
            item.opensInFilesTab
              ? openChangedFileInFilesWithDiff(item.path)
              : openChangedFileInDiff(item.path)
        })
      }
    }
    for (const bm of bookmarkItems) {
      if (bm.kind !== 'file') continue
      items.push({
        id: `split-bm-${bm.id}`,
        label: bm.label,
        hint: bm.target,
        category: 'Session',
        run: () => openChangedFileInFilesWithDiff(bm.target)
      })
    }

    return items
  }, [
    activeSession,
    activeSessionId,
    sessions.statuses,
    sessionWorkspace.workspaceBySession,
    appNotes.notes,
    sessionBookmarks.bookmarksBySession,
    selectTab,
    openNoteInSplit,
    openChangedFileInDiff,
    openChangedFileInFilesWithDiff
  ])

  const bufferSwitcherItems = useMemo<SplitPickerItem[]>(() => {
    const entries: Array<SplitPickerItem & { _t: string }> = []

    // Active claude-code sessions — sorted by lastActiveAt
    for (const s of sessions.activeSessions) {
      if (s.mode !== 'claude-code') continue
      entries.push({
        id: `buf-session-${s.id}`,
        label: s.name,
        category: 'Sessions',
        run: () => void selectSession(s),
        _t: s.lastActiveAt
      })
    }

    // Active terminal sessions — sorted by lastActiveAt
    for (const s of sessions.activeSessions) {
      if (s.mode !== 'terminal') continue
      entries.push({
        id: `buf-terminal-${s.id}`,
        label: s.name,
        category: 'Terminals',
        run: () => void selectSession(s),
        _t: s.lastActiveAt
      })
    }

    // App notes — sorted by updatedAt (best available proxy for recency)
    for (const note of appNotes.notes) {
      entries.push({
        id: `buf-note-${note.id}`,
        label: note.title || 'Untitled',
        category: 'Notes',
        run: () => selectAppNote(note.id),
        _t: note.updatedAt
      })
    }

    // Daily note and weekly plan — no timestamp tracking, float to the bottom
    entries.push({
      id: 'buf-daily-note',
      label: 'Daily Note',
      category: 'Daily Note',
      run: () => selectDailyNote(),
      _t: ''
    })
    entries.push({
      id: 'buf-weekly-plan',
      label: 'Weekly Plan',
      category: 'Weekly Plan',
      run: () => {
        if (weeklyPlanStatus?.fileExists) void onWeeklyPlanRowClick()
        else void startWeeklyPlanWizard()
      },
      _t: ''
    })

    // Sort all items globally by most recently used, descending
    entries.sort((a, b) => (b._t > a._t ? 1 : b._t < a._t ? -1 : 0))

    return entries.map(({ _t: _, ...item }) => item)
  }, [
    sessions.activeSessions,
    appNotes.notes,
    weeklyPlanStatus,
    selectAppNote,
    selectDailyNote,
    onWeeklyPlanRowClick,
    startWeeklyPlanWizard
    // selectSession intentionally omitted — plain async fn, reads own current state via refs
  ])

  function handleOnboardingFinish(identity: { name: string; email: string }): void {
    updateConfig({ onboardingCompleted: true, gitIdentity: identity })
  }

  function handleOnboardingSkip(): void {
    updateConfig({ onboardingCompleted: true })
  }

  async function handleSend(sessionId: string, text: string, attachments?: FileAttachment[]): Promise<void> {
    const reviewComments = reviewCommentsBySession[sessionId] ?? []
    const mergedText = buildComposerSendText(text, reviewComments)
    if (!mergedText && !attachments?.length) return
    if (sessions.rateLimitBySession[sessionId]?.sendBlocked) return
    const busy = sessions.busyBySession[sessionId] ?? false
    if (busy && !attachments?.length) {
      // Session is in flight — queue for automatic dispatch when busy → idle.
      // Attachment sends bypass the queue (they need to go immediately).
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
    await sessions.sendMessage(sessionId, mergedText, model, attachments)
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
          rememberActiveTab(activeSessionId, 'chat')
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
        rememberActiveTab(activeSessionId, 'chat')
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
        if (!result) {
          openFileInFiles(path)
          return
        }
        selectTab('chat')
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
      selectTab('chat')
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
      rememberActiveTab,
      selectTab,
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
  const chatPaneVisibility = resolveTabVisibility('chat', activeTab, activeWorkspaceSplit)
  const composerSplitClass =
    splitLayoutVisible &&
    (chatPaneVisibility === 'split-primary' || chatPaneVisibility === 'split-secondary') &&
    activeWorkspaceSplit
      ? ` composer-cache--split composer-cache--split-${activeWorkspaceSplit.direction} composer-cache--${chatPaneVisibility}`
      : reviewTarget
        ? ' composer-cache--split composer-cache--split-row composer-cache--split-primary'
      : ''

  useLayoutEffect(() => {
    const cache = composerCacheRef.current
    const activeComposer = cache?.querySelector<HTMLElement>('.composer-cache-entry.active')
    if (!composerDockVisible || !activeComposer) {
      setActiveComposerHeight(0)
      return
    }
    const updateHeight = (): void => {
      setActiveComposerHeight(Math.ceil(activeComposer.getBoundingClientRect().height))
    }
    updateHeight()
    const observer = new ResizeObserver(updateHeight)
    observer.observe(activeComposer)
    return () => observer.disconnect()
  }, [activeSessionId, composerDockVisible, composerSplitClass])

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
    splitOpenPickerOpen ||
    bufferSwitcherOpen ||
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
  const activeTabRef = useRef<SessionTab>('chat')
  activeTabRef.current = activeTab
  const activeWorkspaceSplitRef = useRef(activeWorkspaceSplit)
  activeWorkspaceSplitRef.current = activeWorkspaceSplit
  const handleWorkspaceSplitPaneCloseRef = useRef(handleWorkspaceSplitPaneClose)
  handleWorkspaceSplitPaneCloseRef.current = handleWorkspaceSplitPaneClose
  const handleWorkspaceToolToggleMaximizeRef = useRef(handleWorkspaceToolToggleMaximize)
  handleWorkspaceToolToggleMaximizeRef.current = handleWorkspaceToolToggleMaximize
  const busyBySessionRef = useRef<Record<string, boolean>>({})
  busyBySessionRef.current = sessions.busyBySession
  const anyModalOpenRef = useRef(false)
  anyModalOpenRef.current = anyModalOpen
  fileQuickOpenOpenRef.current = fileQuickOpenOpen
  /**
   * Double-ESC / Stop while busy delegates to `handleInterrupt`, which
   * withdraws a not-yet-executed prompt (restores composer text + removes the
   * user row) or interrupts a running turn without restoring the prompt.
   */
  const chatSessionInterruptEnabledRef = useRef(false)
  const pendingChatEscapeRef = useRef<{ sessionId: string; at: number } | null>(null)
  // Double-ESC interrupts the active chat session's in-flight turn (same as
  // Stop), but only while the chat tab is foreground — not from sidebar,
  // daily notes, other tabs, or modals.
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

  const setDiffPanelRef = useCallback((id: string, h: DiffPanelHandle | null) => {
    if (h) diffPanelRefs.current.set(id, h)
    else diffPanelRefs.current.delete(id)
  }, [])
  const setFilesPanelRef = useCallback((id: string, h: FilesPanelHandle | null) => {
    if (h) filesPanelRefs.current.set(id, h)
    else filesPanelRefs.current.delete(id)
  }, [])

  useEffect(() => {
    function handleChatEscape(e: KeyboardEvent): void {
      if (e.key !== 'Escape') {
        if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) {
          pendingChatEscapeRef.current = null
        }
        return
      }
      if (
        anyModalOpenRef.current ||
        !chatSessionInterruptEnabledRef.current ||
        transcriptSearchOpenRef.current
      ) {
        pendingChatEscapeRef.current = null
        return
      }
      const sid = activeSessionIdRef.current
      if (!sid || !busyBySessionRef.current[sid]) {
        pendingChatEscapeRef.current = null
        return
      }
      e.preventDefault()
      if (e.repeat) return

      const now = performance.now()
      const pending = pendingChatEscapeRef.current
      if (!pending || pending.sessionId !== sid || now - pending.at > 600) {
        pendingChatEscapeRef.current = { sessionId: sid, at: now }
        return
      }

      pendingChatEscapeRef.current = null
      void handleInterruptRef.current(sid)
    }
    window.addEventListener('keydown', handleChatEscape)
    return () => window.removeEventListener('keydown', handleChatEscape)
  }, [])

  const workspacePanelShortcutsEnabled = Boolean(
    activeSession &&
      activeSession.mode === 'claude-code' &&
      !activeAppNote &&
      !activeDailyNoteDate &&
      !activeWeeklyPlanSurface &&
      !activeSessionDisconnected
  )

  useEffect(() => {
    function handleWorkspacePanelShortcut(e: KeyboardEvent): void {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.repeat) return
      if (anyModalOpen) return

      if (e.code === 'ArrowRight') {
        e.preventDefault()
        e.stopPropagation()
        void toggleDailyNotesPanel()
        return
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault()
        e.stopPropagation()
        updateConfig({ sidebarCollapsed: !config.sidebarCollapsed })
        return
      }
      if (!workspacePanelShortcutsEnabled) return

      const tabByCode: Partial<Record<string, WorkspaceToolTab>> = {
        KeyD: 'diff',
        KeyF: 'files',
        KeyT: 'terminal',
        KeyP: 'ports'
      }
      const tab = tabByCode[e.code]
      if (!tab || (tab === 'ports' && !activeSession?.hostname)) return
      e.preventDefault()
      e.stopPropagation()
      toggleWorkspaceTool(tab)
    }

    window.addEventListener('keydown', handleWorkspacePanelShortcut)
    return () => window.removeEventListener('keydown', handleWorkspacePanelShortcut)
  }, [
    activeSession?.hostname,
    anyModalOpen,
    config.sidebarCollapsed,
    toggleDailyNotesPanel,
    toggleWorkspaceTool,
    updateConfig,
    workspacePanelShortcutsEnabled
  ])

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
      <div
        id="app"
        className={`app-body${resizing ? ' app-body--resizing-panels' : ''}${
          dailyNotesOpen ? ' app-body--daily-notes-open' : ''
        }`}
        ref={appBodyRef}
      >
        <div
          className="sidebar-shell"
          data-testid="sidebar-shell"
          style={{ width: sidebarExpanded ? sidebarWidth : COLLAPSED_SIDEBAR_WIDTH }}
        >
          <Sidebar
          collapsed={config.sidebarCollapsed}
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
          weeklyPlanFileExists={weeklyPlanStatus?.fileExists ?? false}
          activeWeeklyPlan={activeWeeklyPlanSurface}
          onSelectWeeklyPlanRow={() => void onWeeklyPlanRowClick()}
          onStartWeeklyPlan={() => void startWeeklyPlanWizard()}
          onSelectAppNote={selectAppNote}
          onSelectDailyNote={() => void selectDailyNote()}
          dailyNotesPanelOpen={date !== null}
          onToggleDailyNotesPanel={() => void toggleDailyNotesPanel()}
          onCreateAppNote={() => void createAppNote()}
          onRenameAppNote={(id, title) => void updateAppNoteWithSync(id, { title })}
          onDeleteAppNote={requestDeleteAppNote}
          bookmarks={appBookmarks.bookmarks}
          onCreateBookmark={(input) => void appBookmarks.createBookmark(input)}
          onUpdateBookmark={(id, patch) => void appBookmarks.updateBookmark(id, patch)}
          onDeleteBookmark={(id) => void appBookmarks.deleteBookmark(id)}
          onOpenBookmark={(url) => void window.atelier.openExternal(url)}
          waitingInputAlertIds={waitingInputAlertIds}
          onClearWaitingInputAlert={clearWaitingInputAlert}
          />
        </div>

        {sidebarExpanded ? (
          <div
            className="app-panel-resize-handle"
            data-testid="sidebar-resize-handle"
            onMouseDown={startSidebarResize}
          />
        ) : null}

        {/* Alert chips — float on the left edge when sidebar is hidden */}
        {collapsedAlerts && (
          <div className="sidebar-alert-chips" data-testid="sidebar-alert-chips">
            {collapsedAlerts.blocked.map((session) => (
              <CollapsedAlertChip
                key={session.id}
                session={session}
                kind="blocked"
                onClick={() => {
                  void updateConfig({ sidebarCollapsed: false })
                  void selectSession(session)
                }}
              />
            ))}
            {collapsedAlerts.ready.map((session) => (
              <CollapsedAlertChip
                key={session.id}
                session={session}
                kind="ready"
                onClick={() => {
                  clearWaitingInputAlert(session.id)
                  void updateConfig({ sidebarCollapsed: false })
                  void selectSession(session)
                }}
              />
            ))}
          </div>
        )}

        <div className="main-area">
          <div
            className={`topbar${activeAppNote || activeDailyNoteDate ? ' topbar--note-editor' : ''}${activeDailyNoteDate ? ' topbar--daily-note' : ''}`}
          >
            <button
              type="button"
              className="topbar-sidebar-toggle"
              title="Toggle sidebar"
              data-testid="sidebar-collapse-toggle"
              onClick={() => updateConfig({ sidebarCollapsed: !config.sidebarCollapsed })}
            >
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
                <path d={config.sidebarCollapsed ? 'm13 9 3 3-3 3' : 'm16 9-3 3 3 3'} />
              </svg>
            </button>
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
                    onChange={(e) =>
                      void updateAppNoteWithSync(activeAppNote.id, { title: e.target.value })
                    }
                  />
                ) : activeSession ? (
                  activeSession.name
                ) : (
                  'Atelier'
                )}
              </span>
              {activeAppNote ? (
                <span
                  className={`daily-sync-chip app-note-sync-chip ${
                    appNoteSyncById[activeAppNote.id] ?? 'synced'
                  }`}
                  data-testid="app-note-sync-chip"
                  role="status"
                  aria-live="polite"
                  aria-label={
                    appNoteSyncById[activeAppNote.id] === 'saving'
                      ? 'Saving…'
                      : appNoteSyncById[activeAppNote.id] === 'error'
                        ? 'Save failed'
                        : 'Synced'
                  }
                  title={
                    appNoteSyncById[activeAppNote.id] === 'saving'
                      ? 'Saving…'
                      : appNoteSyncById[activeAppNote.id] === 'error'
                        ? 'Save failed'
                        : 'Synced'
                  }
                >
                  <span className="daily-sync-dot" aria-hidden="true" />
                  <span className="daily-sync-label">
                    {appNoteSyncById[activeAppNote.id] === 'saving'
                      ? 'Saving…'
                      : appNoteSyncById[activeAppNote.id] === 'error'
                        ? 'Save failed'
                        : 'Synced'}
                  </span>
                </span>
              ) : null}
              {activeSession &&
              !activeAppNote &&
              !activeDailyNoteDate &&
              !activeWeeklyPlanSurface &&
              activeSession.mode === 'claude-code' &&
              !activeSessionDisconnected ? (
                <span className="topbar-cost" data-testid="cost-chip">
                  ${activeSession.totalCostUsd.toFixed(2)}
                </span>
              ) : null}
              {activeDailyNoteDate ? (
                <div
                  ref={setDailyNoteHeaderHost}
                  className="daily-note-header-host"
                  data-testid="daily-note-header-host"
                />
              ) : null}
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
                <div
                  className="tab-strip tab-strip--empty"
                  data-testid="tab-strip"
                  data-hint-exclude-root=""
                  aria-hidden="true"
                />
                <div className="topbar-spacer" />
                <TranscriptSearchBar
                  open={transcriptSearchOpen}
                  query={transcriptSearchQuery}
                  matchCount={matchCount}
                  onQueryChange={handleTranscriptSearchQueryChange}
                  onNavigate={navigateTranscriptMatches}
                  onClose={toggleTranscriptSearch}
                />
              </>
            )}
            <button
              type="button"
              className={`topbar-timeline-toggle${dailyNotesOpen ? ' active' : ''}`}
              title={todayNoteExists === false ? 'Create today\'s note' : 'Timeline'}
              aria-label="Toggle timeline panel"
              aria-pressed={dailyNotesOpen}
              data-testid="toggle-daily-notes-panel"
              onClick={() => void toggleDailyNotesPanel()}
            >
              {todayNoteExists === false ? (
                <span className="topbar-timeline-dot" aria-hidden="true" />
              ) : null}
              <svg
                className="icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
            </button>
          </div>

          <div className="workspace-shell">
          {/* Content area below topbar — position:relative anchors terminal + composer keep-alive layers */}
          <div
            data-main-content
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              position: 'relative',
              '--active-composer-height': `${activeComposerHeight}px`,
              '--workspace-split-ratio': activeWorkspaceSplit?.splitRatio ?? 0.5
            } as React.CSSProperties}
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
                      className={`terminal-cache-entry workspace-pane--tool${isActive ? ' active' : ''}${paneClass}`}
                    >
                      <WorkspaceSplitPaneClose
                        tab="terminal"
                        visibility={terminalVisibility}
                        onClose={handleWorkspaceSplitPaneClose}
                        onToggleMaximize={handleWorkspaceToolToggleMaximize}
                        maximized={activeWorkspaceSplit?.fullscreenTab === 'terminal'}
                      />
                      <TerminalWithToolbox
                        ref={(h) => {
                          if (h) tabTerminalRefs.current.set(ptyId, h)
                          else tabTerminalRefs.current.delete(ptyId)
                        }}
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
                onToggleMaximizePane={handleWorkspaceToolToggleMaximize}
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
                setDiffPanelRef={setDiffPanelRef}
                setFilesPanelRef={setFilesPanelRef}
                appNotes={appNotes.notes}
                onUpdateAppNote={async (id, patch) => { await appNotes.updateNote(id, patch) }}
                onSelectAppNoteInSplit={selectAppNoteInSplit}
                noteCursorPositions={noteCursorPositionsRef.current}
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
              headerHost={dailyNoteHeaderHost}
            />
          ) : activeAppNote ? (
            <AppNotesPanel
              notes={appNotes.notes}
              activeNoteId={activeAppNote.id}
              effectiveTheme={effectiveTheme}
              onUpdateNote={async (id, patch) => {
                await updateAppNoteWithSync(id, patch, appNoteSyncVersionRef.current.get(id))
              }}
              onDirty={markAppNoteSaving}
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
                      : reviewTarget
                        ? ' session-workspace-tabs--review'
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
                          className={`${tabContentClass(
                            resolveTabVisibility('ports', activeTab, activeWorkspaceSplit)
                          )} workspace-pane--tool`}
                          data-tab="ports"
                        >
                          <WorkspaceSplitPaneClose
                            tab="ports"
                            visibility={resolveTabVisibility('ports', activeTab, activeWorkspaceSplit)}
                            onClose={handleWorkspaceSplitPaneClose}
                            onToggleMaximize={handleWorkspaceToolToggleMaximize}
                            maximized={activeWorkspaceSplit?.fullscreenTab === 'ports'}
                          />
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
            <div
              className={`composer-cache${composerSplitClass}`}
              data-testid="composer-cache"
              ref={composerCacheRef}
            >
              {[...aliveChatComposers].map((sessionId) => {
                const session = allSessions.find((s) => s.id === sessionId)
                if (!session || session.mode !== 'claude-code') return null
                const composerActive = composerDockVisible && activeSessionId === sessionId
                const ws = sessionWorkspace.workspaceBySession[sessionId]
                const mentionPaths = ws?.filesList?.map((e) => e.relativePath)
                return (
                  <div
                    key={sessionId}
                    className={`composer-cache-entry${composerActive ? ' active' : ''}`}
                    data-session-id={sessionId}
                    data-panel="chat"
                  >
                    <Composer
                      ref={(handle) => {
                        if (handle) composerRefs.current.set(sessionId, handle)
                        else composerRefs.current.delete(sessionId)
                      }}
                      active={composerActive}
                      onSend={(text, attachments) => void handleSend(sessionId, text, attachments)}
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
                      onRemoveBookmark={(bookmark) =>
                        void sessionBookmarks.remove(sessionId, bookmark.kind, bookmark.target)
                      }
                      onFork={() => void sessions.forkSession(sessionId).then((forked) => setActiveSessionId(forked.id))}
                      onClearConversation={() => {
                        setQueuedMessagesBySession((prev) => {
                          if (!(sessionId in prev)) return prev
                          const next = { ...prev }
                          delete next[sessionId]
                          return next
                        })
                        void window.atelier.clearConversation(sessionId)
                      }}
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
          {activeSession &&
          !activeAppNote &&
          !activeDailyNoteDate &&
          !activeWeeklyPlanSurface &&
          activeSession.mode === 'claude-code' &&
          !activeSessionDisconnected ? (
            <WorkspaceToolRail
              activeTool={activeWorkspaceTool}
              showPorts={Boolean(activeSession.hostname)}
              diffChangedCount={activeDiffChangedCount}
              onSelect={selectTab}
              onToolPress={workspaceTabDrag.trackTabPress}
              didDragTool={workspaceTabDrag.didDrag}
            />
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
      />

      <SplitOpenPicker
        isOpen={splitOpenPickerOpen}
        onClose={() => setSplitOpenPickerOpen(false)}
        items={splitPickerItems}
        showCategoryHeaders={false}
      />

      <SplitOpenPicker
        isOpen={bufferSwitcherOpen}
        onClose={() => setBufferSwitcherOpen(false)}
        items={bufferSwitcherItems}
        placeholder="Switch to…"
        testIdPrefix="buffer-switcher"
        showCategoryHeaders={false}
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
          if (created.mode === 'claude-code') pendingReadySessionsRef.current.add(created.id)
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

      {deleteAppNotePrompt && (
        <DeleteAppNoteDialog
          noteName={deleteAppNotePrompt.title}
          onArchive={() => {
            const { id } = deleteAppNotePrompt
            setDeleteAppNotePrompt(null)
            void deleteAppNote(id)
          }}
          onDeletePermanently={() => {
            const { id } = deleteAppNotePrompt
            setDeleteAppNotePrompt(null)
            void deleteAppNote(id, true)
          }}
          onCancel={() => setDeleteAppNotePrompt(null)}
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

      {appToast && (
        <div className="app-toast" data-testid="app-toast" role="status">
          {appToast}
        </div>
      )}
    </div>
  )
}
