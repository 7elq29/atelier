import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CreateSessionOptions,
  ImageAttachment,
  MessageRecord,
  ModelSelection,
  ModelValidationResult,
  PromptDecision,
  RemoteHostOption,
  SessionGroupRecord,
  SessionRecord,
  SessionStatus,
  SlashCommandInfo
} from '../../../shared/session-types'
export interface UseSessionsResult {
  activeSessions: SessionRecord[]
  historySessions: SessionRecord[]
  hosts: RemoteHostOption[]
  messagesBySession: Record<string, MessageRecord[]>
  groups: SessionGroupRecord[]
  statuses: Record<string, SessionStatus>
  allTags: string[]
  /** True while a turn is in flight for that session — drives the composer's Send/Stop toggle (04-composer-core). */
  busyBySession: Record<string, boolean>
  /** Live slash-command registry per session (bug #56) — see SessionCommandsEvent's doc comment. Empty until the harness's first push lands. */
  commandsBySession: Record<string, SlashCommandInfo[]>
  /** Context-window token usage per session (token-usage-indicator) — updated after each completed turn. Empty until the session's first turn completes. */
  tokenUsageBySession: Record<string, { inputTokens: number; contextWindow: number }>
  /** Worktree creation progress per session (use-worktree) — integer 0–100 while creating-worktree, deleted when done. */
  worktreeProgressBySession: Record<string, number>
  /** Sessions detected as unrecoverable on startup (transcript gone or tmux dead). */
  staleSessionIds: Set<string>
  refresh: () => Promise<void>
  createSession: (opts: CreateSessionOptions) => Promise<SessionRecord>
  resumeSession: (sessionId: string) => Promise<void>
  sendMessage: (sessionId: string, text: string, modelSelection?: ModelSelection, image?: ImageAttachment) => Promise<void>
  interrupt: (sessionId: string) => Promise<void>
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
  deleteSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, name: string) => Promise<void>
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
  /** Opens a real native Save dialog and writes the session's transcript to disk (10c-enrichment-export-conversation); resolves to the saved path, or null if cancelled. */
  exportTranscript: (sessionId: string, format: 'markdown' | 'json') => Promise<string | null>
  setColor: (sessionId: string, color: string) => Promise<void>
  setNotes: (sessionId: string, notes: string) => Promise<void>
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
  const [messagesBySession, setMessagesBySession] = useState<Record<string, MessageRecord[]>>({})
  const [groups, setGroups] = useState<SessionGroupRecord[]>([])
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({})
  const [allTags, setAllTags] = useState<string[]>([])
  const [busyBySession, setBusyBySession] = useState<Record<string, boolean>>({})
  const [commandsBySession, setCommandsBySession] = useState<Record<string, SlashCommandInfo[]>>({})
  const [tokenUsageBySession, setTokenUsageBySession] = useState<Record<string, { inputTokens: number; contextWindow: number }>>({})
  const [worktreeProgressBySession, setWorktreeProgressBySession] = useState<Record<string, number>>({})
  const [staleSessionIds, setStaleSessionIds] = useState<Set<string>>(new Set())
  const messagesRef = useRef(messagesBySession)
  messagesRef.current = messagesBySession

  const refresh = useCallback(async () => {
    const [active, history, tags] = await Promise.all([
      window.gardenia.listActiveSessions(),
      window.gardenia.listHistorySessions(),
      window.gardenia.listAllTags()
    ])
    setActiveSessions(active)
    setHistorySessions(history)
    setAllTags(tags)
  }, [])

  const refreshGroups = useCallback(async () => {
    setGroups(await window.gardenia.listGroups())
  }, [])

  useEffect(() => {
    refresh()
    refreshGroups()
    window.gardenia.listHosts().then(setHosts)
    window.gardenia.listSessionStatuses().then(setStatuses)

    const offMessage = window.gardenia.onSessionMessage(({ sessionId, message }) => {
      setMessagesBySession((prev) => {
        const list = prev[sessionId] ?? []
        const idx = list.findIndex((m) => m.id === message.id)
        if (idx === -1) return { ...prev, [sessionId]: [...list, message] }
        // Same id as an existing row (streamed-text finalization, or a
        // tool-call flipping from running -> completed/error): replace in
        // place rather than append, so the transcript never shows a
        // duplicate row for what is still "one row per message" in SQLite.
        const next = [...list]
        next[idx] = message
        return { ...prev, [sessionId]: next }
      })
    })
    const offDelta = window.gardenia.onSessionStreamDelta(({ sessionId, messageId, text }) => {
      // Token-level live render: patches the in-progress message's content
      // directly in renderer state on every delta, without a DB round-trip
      // — the eventual `session:message` push above commits the final text.
      setMessagesBySession((prev) => {
        const list = prev[sessionId]
        if (!list) return prev
        const idx = list.findIndex((m) => m.id === messageId)
        if (idx === -1) return prev
        const next = [...list]
        next[idx] = { ...next[idx], content: text }
        return { ...prev, [sessionId]: next }
      })
    })
    const offLifecycle = window.gardenia.onSessionLifecycle(() => {
      // Any lifecycle change (created/renamed/closed/resumed/forked/deleted/
      // updated) can move a session between active/pinned/history — simplest
      // correct thing is to just refetch both lists.
      refresh()
    })
    // Concurrent per-session status (06-session-organization): pushed for
    // EVERY session independently of which one is focused/active, so this
    // patches statuses[sessionId] directly rather than refetching everything.
    const offStatus = window.gardenia.onSessionStatus(({ sessionId, status }) => {
      setStatuses((prev) => ({ ...prev, [sessionId]: status }))
    })
    const offGroup = window.gardenia.onGroupChanged(() => {
      refreshGroups()
      refresh()
    })
    const offTurnState = window.gardenia.onSessionTurnState(({ sessionId, busy }) => {
      setBusyBySession((prev) => (prev[sessionId] === busy ? prev : { ...prev, [sessionId]: busy }))
    })
    // Live slash-command registry (bug #56): always REPLACE the cached list
    // for this session, never merge — matches SessionCommandsEvent's own
    // doc comment (the SDK's own commands_changed push is itself a full
    // replacement, not a delta).
    const offCommands = window.gardenia.onSessionCommands(({ sessionId, commands }) => {
      setCommandsBySession((prev) => ({ ...prev, [sessionId]: commands }))
    })
    // token-usage-indicator: update per-session token counts after each turn.
    const offTokenUsage = window.gardenia.onSessionTokenUsage(({ sessionId, inputTokens, contextWindow }) => {
      setTokenUsageBySession((prev) => ({ ...prev, [sessionId]: { inputTokens, contextWindow } }))
    })
    // use-worktree: track git worktree add progress per session.
    const offWorktreeProgress = window.gardenia.onSessionWorktreeProgress(({ sessionId, percent }) => {
      setWorktreeProgressBySession((prev) => ({ ...prev, [sessionId]: percent }))
    })
    // Startup recoverability: mark sessions whose transcript/tmux is gone.
    const offStale = window.gardenia.onSessionStale(({ sessionId }) => {
      setStaleSessionIds((prev) => { const next = new Set(prev); next.add(sessionId); return next })
    })
    return () => {
      offMessage()
      offDelta()
      offLifecycle()
      offStatus()
      offGroup()
      offTurnState()
      offCommands()
      offTokenUsage()
      offWorktreeProgress()
      offStale()
    }
  }, [refresh, refreshGroups])

  const createSession = useCallback(
    async (opts: CreateSessionOptions): Promise<SessionRecord> => {
      const session = await window.gardenia.createSession(opts)
      await refresh()
      return session
    },
    [refresh]
  )

  const resumeSession = useCallback(async (sessionId: string): Promise<void> => {
    const { messages } = await window.gardenia.resumeSession(sessionId)
    // Full stored transcript rendered immediately; the live reconnect (main
    // process) streams any NEW events in over session:message afterward.
    setMessagesBySession((prev) => ({ ...prev, [sessionId]: messages }))
  }, [])

  const sendMessage = useCallback(async (sessionId: string, text: string, modelSelection?: ModelSelection, image?: ImageAttachment): Promise<void> => {
    await window.gardenia.sendSessionMessage(sessionId, text, modelSelection, image)
  }, [])

  const interrupt = useCallback(async (sessionId: string): Promise<void> => {
    await window.gardenia.interruptSession(sessionId)
  }, [])

  const validateModel = useCallback(async (sessionId: string, model: string): Promise<ModelValidationResult> => {
    return window.gardenia.validateModel(sessionId, model)
  }, [])

  const addLocalMessage = useCallback((sessionId: string, content: string): void => {
    setMessagesBySession((prev) => {
      const list = prev[sessionId] ?? []
      const message: MessageRecord = {
        // Negative id keeps this row out of the way of real DB-issued
        // positive ids, which `onSessionMessage`'s dedup-by-id check above
        // relies on to distinguish "new row" from "update existing row".
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
        await window.gardenia.respondToPrompt(sessionId, requestId, decision)
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
    await window.gardenia.cycleSessionMode(sessionId)
  }, [])

  const forkSession = useCallback(async (sessionId: string): Promise<SessionRecord> => {
    const forked = await window.gardenia.forkSession(sessionId)
    const messages = await window.gardenia.listSessionMessages(forked.id)
    setMessagesBySession((prev) => ({ ...prev, [forked.id]: messages }))
    return forked
  }, [])

  const restartSession = useCallback(async (sessionId: string): Promise<SessionRecord> => {
    const forked = await window.gardenia.restartSession(sessionId)
    const messages = await window.gardenia.listSessionMessages(forked.id)
    setMessagesBySession((prev) => ({ ...prev, [forked.id]: messages }))
    return forked
  }, [])

  const closeSession = useCallback(async (sessionId: string): Promise<void> => {
    await window.gardenia.closeSession(sessionId)
  }, [])

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    await window.gardenia.deleteSession(sessionId)
    setMessagesBySession((prev) => {
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
  }, [])

  const renameSession = useCallback(async (sessionId: string, name: string): Promise<void> => {
    await window.gardenia.renameSession(sessionId, name)
  }, [])

  const setPinned = useCallback(async (sessionId: string, pinned: boolean): Promise<void> => {
    await window.gardenia.setSessionPinned(sessionId, pinned)
  }, [])

  const exportTranscript = useCallback(
    async (sessionId: string, format: 'markdown' | 'json'): Promise<string | null> => {
      return window.gardenia.exportTranscript(sessionId, format)
    },
    []
  )

  const setColor = useCallback(async (sessionId: string, color: string): Promise<void> => {
    await window.gardenia.setSessionColor(sessionId, color)
  }, [])

  const setNotes = useCallback(async (sessionId: string, notes: string): Promise<void> => {
    await window.gardenia.setSessionNotes(sessionId, notes)
  }, [])

  const addTag = useCallback(async (sessionId: string, tag: string): Promise<void> => {
    await window.gardenia.addSessionTag(sessionId, tag)
    await refresh()
  }, [refresh])

  const removeTag = useCallback(async (sessionId: string, tag: string): Promise<void> => {
    await window.gardenia.removeSessionTag(sessionId, tag)
    await refresh()
  }, [refresh])

  const setSessionGroup = useCallback(async (sessionId: string, groupId: string | null): Promise<void> => {
    await window.gardenia.setSessionGroup(sessionId, groupId)
  }, [])

  const reorderSessionsFn = useCallback(
    async (groupId: string | null | undefined, orderedIds: string[]): Promise<void> => {
      await window.gardenia.reorderSessions(groupId, orderedIds)
    },
    []
  )

  const createGroup = useCallback(async (name: string): Promise<SessionGroupRecord> => {
    const group = await window.gardenia.createGroup(name)
    await refreshGroups()
    return group
  }, [refreshGroups])

  const renameGroup = useCallback(async (groupId: string, name: string): Promise<void> => {
    await window.gardenia.renameGroup(groupId, name)
  }, [])

  const setGroupCollapsed = useCallback(async (groupId: string, collapsed: boolean): Promise<void> => {
    await window.gardenia.setGroupCollapsed(groupId, collapsed)
    await refreshGroups()
  }, [refreshGroups])

  const deleteGroup = useCallback(async (groupId: string): Promise<void> => {
    await window.gardenia.deleteGroup(groupId)
  }, [])

  const reorderGroups = useCallback(async (orderedIds: string[]): Promise<void> => {
    await window.gardenia.reorderGroups(orderedIds)
    await refreshGroups()
  }, [refreshGroups])

  return {
    activeSessions,
    historySessions,
    hosts,
    messagesBySession,
    groups,
    statuses,
    allTags,
    busyBySession,
    commandsBySession,
    tokenUsageBySession,
    worktreeProgressBySession,
    staleSessionIds,
    refresh,
    createSession,
    resumeSession,
    sendMessage,
    interrupt,
    validateModel,
    addLocalMessage,
    respondToPrompt,
    cycleMode,
    forkSession,
    restartSession,
    closeSession,
    deleteSession,
    renameSession,
    setPinned,
    exportTranscript,
    setColor,
    setNotes,
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
