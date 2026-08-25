import { useCallback, useEffect, useState } from 'react'
import type {
  CreateSessionOptions,
  ImageAttachment,
  MessageRecord,
  ModelSelection,
  ModelValidationResult,
  PromptDecision,
  RemoteHostOption,
  SessionGroupRecord,
  SessionInterruptResult,
  SessionRecord,
  SessionStatus,
  SlashCommandInfo,
  ModelInfo
} from '../../../shared/session-types'
import type {
  BackgroundTaskRow,
  SessionAuthStatusEvent,
  SessionRateLimitEvent,
  SessionSdkChromeEvent,
  SessionToastEvent
} from '../../../shared/harness-ui-types'
import {
  initSessionMessagesListeners,
  patchSessionMessages,
  removeSessionMessages,
  setSessionMessages
} from '../stores/session-messages-store'
export interface UseSessionsResult {
  activeSessions: SessionRecord[]
  historySessions: SessionRecord[]
  hosts: RemoteHostOption[]
  groups: SessionGroupRecord[]
  statuses: Record<string, SessionStatus>
  allTags: string[]
  /** True while a turn is in flight for that session — drives the composer's Send/Stop toggle (04-composer-core). */
  busyBySession: Record<string, boolean>
  /** Live slash-command registry per session (bug #56) — see SessionCommandsEvent's doc comment. Empty until the harness's first push lands. */
  commandsBySession: Record<string, SlashCommandInfo[]>
  /** Live model registry per session — from SDK `initializationResult().models`. */
  modelsBySession: Record<string, ModelInfo[]>
  /** Claude Code cwd per session (composer context bar) — from SDK init + inferred Bash `cd`. */
  harnessCwdBySession: Record<string, string>
  /** Context-window token usage per session (token-usage-indicator) — updated after each completed turn. Empty until the session's first turn completes. */
  tokenUsageBySession: Record<string, { inputTokens: number; contextWindow: number }>
  promptSuggestionBySession: Record<string, string | undefined>
  backgroundTasksBySession: Record<string, BackgroundTaskRow[]>
  sdkChromeBySession: Record<string, SessionSdkChromeEvent | null>
  rateLimitBySession: Record<string, SessionRateLimitEvent | null>
  sdkToastsBySession: Record<string, SessionToastEvent[]>
  authStatus: SessionAuthStatusEvent | null
  hookLogBySession: Record<string, string[]>
  /** Worktree creation progress per session (use-worktree) — integer 0–100 while creating-worktree, deleted when done. */
  worktreeProgressBySession: Record<string, number>
  /** Sessions detected as unrecoverable on startup (transcript gone or tmux dead). */
  staleSessionIds: Set<string>
  refresh: () => Promise<void>
  createSession: (opts: CreateSessionOptions) => Promise<SessionRecord>
  resumeSession: (sessionId: string) => Promise<void>
  /** Loads transcript from SQLite without reconnecting the harness (session-startup-idle). */
  loadSessionMessages: (sessionId: string, opts?: { includeMessageId?: number }) => Promise<void>
  reconnectSession: (sessionId: string) => Promise<void>
  sendMessage: (sessionId: string, text: string, modelSelection?: ModelSelection, image?: ImageAttachment) => Promise<void>
  interrupt: (sessionId: string) => Promise<SessionInterruptResult>
  /** Validates a `/model <id>` against the SDK's live acceptance logic, on demand (not cached) — see `ModelValidationResult`'s doc comment. */
  validateModel: (sessionId: string, model: string) => Promise<ModelValidationResult>
  /** Appends a renderer-only system message to a session's transcript without any SDK/IPC round-trip — used to surface local validation errors (e.g. an unknown `/model <id>`) inline in the chat panel. */
  addLocalMessage: (sessionId: string, content: string) => void
  respondToPrompt: (sessionId: string, requestId: string, decision: PromptDecision) => Promise<void>
  /** Shift+Tab / mode-pill click cycles default -> plan -> acceptEdits -> auto -> default (11-composer-mode-indicator). */
  cycleMode: (sessionId: string) => Promise<void>
  forkSession: (sessionId: string) => Promise<SessionRecord>
  restartSession: (sessionId: string) => Promise<SessionRecord>
  closeSession: (sessionId: string) => Promise<void>
  linkDailyTask: (sessionId: string, noteDate: string, taskGid: string) => Promise<SessionRecord>
  completeLinkedDailyTask: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, name: string) => Promise<void>
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
  /** Opens a real native Save dialog and writes the session's transcript to disk (10c-enrichment-export-conversation); resolves to the saved path, or null if cancelled. */
  exportTranscript: (sessionId: string, format: 'markdown' | 'json') => Promise<string | null>
  setColor: (sessionId: string, color: string) => Promise<void>
  setNotes: (sessionId: string, notes: string) => Promise<void>
  setProjectPath: (sessionId: string, projectPath: string) => Promise<void>
  addTag: (sessionId: string, tag: string) => Promise<void>
  removeTag: (sessionId: string, tag: string) => Promise<void>
  setSessionGroup: (sessionId: string, groupId: string | null) => Promise<void>
  reorderSessions: (groupId: string | null | undefined, orderedIds: string[]) => Promise<void>
  createGroup: (name: string) => Promise<SessionGroupRecord>
  renameGroup: (groupId: string, name: string) => Promise<void>
  setGroupCollapsed: (groupId: string, collapsed: boolean) => Promise<void>
  deleteGroup: (groupId: string) => Promise<void>
  reorderGroups: (orderedIds: string[]) => Promise<void>
}

/**
 * Real session-list + transcript state for the sidebar/main-area (replaces
 * App.tsx's PLACEHOLDER_SESSIONS from 08-global-nav-and-settings). Backed by
 * IPC round-trips for commands and two push channels
 * (`session:message` / `session:lifecycle`) for live updates.
 */
export function useSessions(): UseSessionsResult {
  const [activeSessions, setActiveSessions] = useState<SessionRecord[]>([])
  const [historySessions, setHistorySessions] = useState<SessionRecord[]>([])
  const [hosts, setHosts] = useState<RemoteHostOption[]>([])
  const [groups, setGroups] = useState<SessionGroupRecord[]>([])
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({})
  const [allTags, setAllTags] = useState<string[]>([])
  const [busyBySession, setBusyBySession] = useState<Record<string, boolean>>({})
  const [commandsBySession, setCommandsBySession] = useState<Record<string, SlashCommandInfo[]>>({})
  const [modelsBySession, setModelsBySession] = useState<Record<string, ModelInfo[]>>({})
  const [harnessCwdBySession, setHarnessCwdBySession] = useState<Record<string, string>>({})
  const [tokenUsageBySession, setTokenUsageBySession] = useState<Record<string, { inputTokens: number; contextWindow: number }>>({})
  const [promptSuggestionBySession, setPromptSuggestionBySession] = useState<Record<string, string | undefined>>({})
  const [backgroundTasksBySession, setBackgroundTasksBySession] = useState<Record<string, BackgroundTaskRow[]>>({})
  const [sdkChromeBySession, setSdkChromeBySession] = useState<Record<string, SessionSdkChromeEvent | null>>({})
  const [rateLimitBySession, setRateLimitBySession] = useState<Record<string, SessionRateLimitEvent | null>>({})
  const [sdkToastsBySession, setSdkToastsBySession] = useState<Record<string, SessionToastEvent[]>>({})
  const [authStatus, setAuthStatus] = useState<SessionAuthStatusEvent | null>(null)
  const [hookLogBySession, setHookLogBySession] = useState<Record<string, string[]>>({})
  const [worktreeProgressBySession, setWorktreeProgressBySession] = useState<Record<string, number>>({})
  const [staleSessionIds, setStaleSessionIds] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    const [active, history, tags] = await Promise.all([
      window.atelier.listActiveSessions(),
      window.atelier.listHistorySessions(),
      window.atelier.listAllTags()
    ])
    setActiveSessions(active)
    setHistorySessions(history)
    setAllTags(tags)
  }, [])

  const refreshGroups = useCallback(async () => {
    setGroups(await window.atelier.listGroups())
  }, [])

  useEffect(() => {
    refresh()
    refreshGroups()
    window.atelier.listHosts().then(setHosts)
    window.atelier.listSessionStatuses().then(setStatuses)

    const offMessages = initSessionMessagesListeners()
    const offLifecycle = window.atelier.onSessionLifecycle((event) => {
      if (event.type === 'session.deleted') {
        removeSessionMessages(event.sessionId)
        setBusyBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setCommandsBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setTokenUsageBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setPromptSuggestionBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setHarnessCwdBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setBackgroundTasksBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setSdkChromeBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setRateLimitBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setSdkToastsBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setHookLogBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
        setWorktreeProgressBySession((prev) => {
          if (!(event.sessionId in prev)) return prev
          const next = { ...prev }
          delete next[event.sessionId]
          return next
        })
      }
      // Any lifecycle change (created/renamed/closed/resumed/forked/deleted/
      // updated) can move a session between active/pinned/history — simplest
      // correct thing is to just refetch both lists.
      refresh()
    })
    // Concurrent per-session status (06-session-organization): pushed for
    // EVERY session independently of which one is focused/active, so this
    // patches statuses[sessionId] directly rather than refetching everything.
    const offStatus = window.atelier.onSessionStatus(({ sessionId, status }) => {
      setStatuses((prev) => ({ ...prev, [sessionId]: status }))
      if (status !== 'creating-worktree') {
        setWorktreeProgressBySession((prev) => {
          if (!(sessionId in prev)) return prev
          const next = { ...prev }
          delete next[sessionId]
          return next
        })
      }
    })
    const offGroup = window.atelier.onGroupChanged(() => {
      refreshGroups()
      refresh()
    })
    const offTurnState = window.atelier.onSessionTurnState(({ sessionId, busy }) => {
      setBusyBySession((prev) => (prev[sessionId] === busy ? prev : { ...prev, [sessionId]: busy }))
    })
    // Live slash-command registry (bug #56): always REPLACE the cached list
    // for this session, never merge — matches SessionCommandsEvent's own
    // doc comment (the SDK's own commands_changed push is itself a full
    // replacement, not a delta).
    const offCommands = window.atelier.onSessionCommands(({ sessionId, commands }) => {
      setCommandsBySession((prev) => ({ ...prev, [sessionId]: commands }))
    })
    const offModels = window.atelier.onSessionModels(({ sessionId, models }) => {
      setModelsBySession((prev) => ({ ...prev, [sessionId]: models }))
    })
    const offHarnessCwd = window.atelier.onSessionHarnessCwd(({ sessionId, cwd }) => {
      setHarnessCwdBySession((prev) => ({ ...prev, [sessionId]: cwd }))
    })
    // token-usage-indicator: update per-session token counts after each turn.
    const offTokenUsage = window.atelier.onSessionTokenUsage(({ sessionId, inputTokens, contextWindow }) => {
      setTokenUsageBySession((prev) => ({ ...prev, [sessionId]: { inputTokens, contextWindow } }))
    })
    const offPromptSuggestion = window.atelier.onSessionPromptSuggestion(({ sessionId, suggestion }) => {
      setPromptSuggestionBySession((prev) => {
        if (suggestion == null) {
          if (!(sessionId in prev)) return prev
          const next = { ...prev }
          delete next[sessionId]
          return next
        }
        return { ...prev, [sessionId]: suggestion }
      })
    })
    const offBackgroundTasks = window.atelier.onSessionBackgroundTasks(({ sessionId, tasks }) => {
      setBackgroundTasksBySession((prev) => ({ ...prev, [sessionId]: tasks }))
    })
    const offSdkChrome = window.atelier.onSessionSdkChrome((payload) => {
      setSdkChromeBySession((prev) => ({ ...prev, [payload.sessionId]: payload }))
    })
    const offRateLimit = window.atelier.onSessionRateLimit((payload) => {
      setRateLimitBySession((prev) => ({ ...prev, [payload.sessionId]: payload }))
    })
    const offSdkToast = window.atelier.onSessionSdkToast((toast) => {
      setSdkToastsBySession((prev) => {
        const list = prev[toast.sessionId] ?? []
        const filtered = list.filter((t) => t.key !== toast.key)
        return { ...prev, [toast.sessionId]: [toast, ...filtered].slice(0, 8) }
      })
    })
    const offAuthStatus = window.atelier.onSessionAuthStatus((payload) => {
      setAuthStatus(payload)
    })
    const offHookLog = window.atelier.onSessionHookLog(({ sessionId, line }) => {
      setHookLogBySession((prev) => {
        const list = prev[sessionId] ?? []
        return { ...prev, [sessionId]: [...list, line].slice(-40) }
      })
    })
    // use-worktree: track git worktree add progress per session.
    const offWorktreeProgress = window.atelier.onSessionWorktreeProgress(({ sessionId, percent }) => {
      setWorktreeProgressBySession((prev) => ({ ...prev, [sessionId]: percent }))
    })
    // Startup recoverability: mark sessions whose transcript/tmux is gone.
    const offStale = window.atelier.onSessionStale(({ sessionId }) => {
      setStaleSessionIds((prev) => { const next = new Set(prev); next.add(sessionId); return next })
    })
    return () => {
      offMessages()
      offLifecycle()
      offStatus()
      offGroup()
      offTurnState()
      offCommands()
      offModels()
      offHarnessCwd()
      offTokenUsage()
      offPromptSuggestion()
      offBackgroundTasks()
      offSdkChrome()
      offRateLimit()
      offSdkToast()
      offAuthStatus()
      offHookLog()
      offWorktreeProgress()
      offStale()
    }
  }, [refresh, refreshGroups])

  const createSession = useCallback(
    async (opts: CreateSessionOptions): Promise<SessionRecord> => {
      const session = await window.atelier.createSession(opts)
      await refresh()
      return session
    },
    [refresh]
  )

  const resumeSession = useCallback(async (sessionId: string): Promise<void> => {
    setBackgroundTasksBySession((prev) => ({ ...prev, [sessionId]: [] }))
    setSdkChromeBySession((prev) => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    const { messages, transcriptTruncated, hiddenTurnCount } = await window.atelier.resumeSession(sessionId)
    setSessionMessages(sessionId, messages, { transcriptTruncated, hiddenTurnCount })
  }, [])

  const loadSessionMessages = useCallback(
    async (sessionId: string, opts?: { includeMessageId?: number }): Promise<void> => {
      const { messages, transcriptTruncated, hiddenTurnCount } = await window.atelier.listSessionMessages(
        sessionId,
        opts
      )
      setSessionMessages(sessionId, messages, { transcriptTruncated, hiddenTurnCount })
    },
    []
  )

  const reconnectSession = useCallback(async (sessionId: string): Promise<void> => {
    await window.atelier.reconnectSession(sessionId)
  }, [])

  const sendMessage = useCallback(async (sessionId: string, text: string, modelSelection?: ModelSelection, image?: ImageAttachment): Promise<void> => {
    await window.atelier.sendSessionMessage(sessionId, text, modelSelection, image)
  }, [])

  const interrupt = useCallback(async (sessionId: string): Promise<SessionInterruptResult> => {
    setBusyBySession((prev) => (prev[sessionId] === false ? prev : { ...prev, [sessionId]: false }))
    return window.atelier.interruptSession(sessionId)
  }, [])

  const validateModel = useCallback(async (sessionId: string, model: string): Promise<ModelValidationResult> => {
    return window.atelier.validateModel(sessionId, model)
  }, [])

  const addLocalMessage = useCallback((sessionId: string, content: string): void => {
    patchSessionMessages((prev) => {
      const list = prev[sessionId] ?? []
      const message: MessageRecord = {
        id: -Date.now(),
        sessionId,
        role: 'system',
        content,
        rawEvent: null,
        createdAt: new Date().toISOString()
      }
      return { ...prev, [sessionId]: [...list, message] }
    })
  }, [])

  const respondToPrompt = useCallback(
    async (sessionId: string, requestId: string, decision: PromptDecision): Promise<void> => {
      try {
        await window.atelier.respondToPrompt(sessionId, requestId, decision)
      } catch (err) {
        // Can legitimately fail if the turn already ended in error and the
        // card's prompt was expired server-side (see manager.ts's
        // `expirePendingPrompts`) — the card itself re-renders from the
        // pushed `session.message` update in that case, so there's nothing
        // else to do here besides not letting this vanish silently.
        console.error('respondToPrompt failed', { sessionId, requestId, decision, err })
      }
    },
    []
  )

  /** Shift+Tab / mode-pill click cycles default -> plan -> acceptEdits -> auto -> default (11-composer-mode-indicator). The main process broadcasts `session.updated` itself, so — same pattern as setPinned/setColor/etc. above — this doesn't need to patch local state or call refresh() itself. */
  const cycleMode = useCallback(async (sessionId: string): Promise<void> => {
    await window.atelier.cycleSessionMode(sessionId)
  }, [])

  const forkSession = useCallback(async (sessionId: string): Promise<SessionRecord> => {
    const forked = await window.atelier.forkSession(sessionId)
    const { messages, transcriptTruncated, hiddenTurnCount } = await window.atelier.listSessionMessages(forked.id)
    setSessionMessages(forked.id, messages, { transcriptTruncated, hiddenTurnCount })
    return forked
  }, [])

  const restartSession = useCallback(async (sessionId: string): Promise<SessionRecord> => {
    const forked = await window.atelier.restartSession(sessionId)
    const { messages, transcriptTruncated, hiddenTurnCount } = await window.atelier.listSessionMessages(forked.id)
    setSessionMessages(forked.id, messages, { transcriptTruncated, hiddenTurnCount })
    return forked
  }, [])

  const closeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      let closedSession: SessionRecord | undefined
      setActiveSessions((prev) => {
        const session = prev.find((s) => s.id === sessionId)
        if (!session) return prev
        closedSession = { ...session, closedAt: new Date().toISOString(), pinned: false }
        return prev.filter((s) => s.id !== sessionId)
      })
      if (closedSession) {
        setHistorySessions((prev) => {
          if (prev.some((s) => s.id === sessionId)) return prev
          return [closedSession!, ...prev]
        })
        setStatuses((prev) => {
          if (!(sessionId in prev)) return prev
          const next = { ...prev }
          delete next[sessionId]
          return next
        })
      }
      try {
        await window.atelier.closeSession(sessionId)
      } catch {
        await refresh()
      }
    },
    [refresh]
  )

  const linkDailyTask = useCallback(
    async (sessionId: string, noteDate: string, taskGid: string): Promise<SessionRecord> =>
      window.atelier.linkDailyTask(sessionId, noteDate, taskGid),
    []
  )

  const completeLinkedDailyTask = useCallback(async (sessionId: string): Promise<void> => {
    await window.atelier.completeLinkedDailyTask(sessionId)
  }, [])

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    await window.atelier.deleteSession(sessionId)
    removeSessionMessages(sessionId)
  }, [])

  const renameSession = useCallback(async (sessionId: string, name: string): Promise<void> => {
    await window.atelier.renameSession(sessionId, name)
  }, [])

  const setPinned = useCallback(async (sessionId: string, pinned: boolean): Promise<void> => {
    await window.atelier.setSessionPinned(sessionId, pinned)
  }, [])

  const exportTranscript = useCallback(
    async (sessionId: string, format: 'markdown' | 'json'): Promise<string | null> => {
      return window.atelier.exportTranscript(sessionId, format)
    },
    []
  )

  const setColor = useCallback(async (sessionId: string, color: string): Promise<void> => {
    await window.atelier.setSessionColor(sessionId, color)
  }, [])

  const setNotes = useCallback(async (sessionId: string, notes: string): Promise<void> => {
    await window.atelier.setSessionNotes(sessionId, notes)
  }, [])

  const setProjectPath = useCallback(async (sessionId: string, projectPath: string): Promise<void> => {
    await window.atelier.setSessionProjectPath(sessionId, projectPath)
  }, [])

  const addTag = useCallback(async (sessionId: string, tag: string): Promise<void> => {
    await window.atelier.addSessionTag(sessionId, tag)
    await refresh()
  }, [refresh])

  const removeTag = useCallback(async (sessionId: string, tag: string): Promise<void> => {
    await window.atelier.removeSessionTag(sessionId, tag)
    await refresh()
  }, [refresh])

  const setSessionGroup = useCallback(async (sessionId: string, groupId: string | null): Promise<void> => {
    await window.atelier.setSessionGroup(sessionId, groupId)
  }, [])

  const reorderSessionsFn = useCallback(
    async (groupId: string | null | undefined, orderedIds: string[]): Promise<void> => {
      await window.atelier.reorderSessions(groupId, orderedIds)
    },
    []
  )

  const createGroup = useCallback(async (name: string): Promise<SessionGroupRecord> => {
    const group = await window.atelier.createGroup(name)
    await refreshGroups()
    return group
  }, [refreshGroups])

  const renameGroup = useCallback(async (groupId: string, name: string): Promise<void> => {
    await window.atelier.renameGroup(groupId, name)
  }, [])

  const setGroupCollapsed = useCallback(async (groupId: string, collapsed: boolean): Promise<void> => {
    await window.atelier.setGroupCollapsed(groupId, collapsed)
    await refreshGroups()
  }, [refreshGroups])

  const deleteGroup = useCallback(async (groupId: string): Promise<void> => {
    await window.atelier.deleteGroup(groupId)
  }, [])

  const reorderGroups = useCallback(async (orderedIds: string[]): Promise<void> => {
    await window.atelier.reorderGroups(orderedIds)
    await refreshGroups()
  }, [refreshGroups])

  return {
    activeSessions,
    historySessions,
    hosts,
    groups,
    statuses,
    allTags,
    busyBySession,
    commandsBySession,
    modelsBySession,
    harnessCwdBySession,
    tokenUsageBySession,
    promptSuggestionBySession,
    backgroundTasksBySession,
    sdkChromeBySession,
    rateLimitBySession,
    sdkToastsBySession,
    authStatus,
    hookLogBySession,
    worktreeProgressBySession,
    staleSessionIds,
    refresh,
    createSession,
    resumeSession,
    loadSessionMessages,
    reconnectSession,
    sendMessage,
    interrupt,
    validateModel,
    addLocalMessage,
    respondToPrompt,
    cycleMode,
    forkSession,
    restartSession,
    closeSession,
    linkDailyTask,
    completeLinkedDailyTask,
    deleteSession,
    renameSession,
    setPinned,
    exportTranscript,
    setColor,
    setNotes,
    setProjectPath,
    addTag,
    removeTag,
    setSessionGroup,
    reorderSessions: reorderSessionsFn,
    createGroup,
    renameGroup,
    setGroupCollapsed,
    deleteGroup,
    reorderGroups
  }
}
