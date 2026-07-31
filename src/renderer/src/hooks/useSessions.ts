import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CreateSessionOptions,
  MessageRecord,
  ModelSelection,
  PromptDecision,
  RemoteHostOption,
  SessionGroupRecord,
  SessionRecord,
  SessionStatus
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
  refresh: () => Promise<void>
  createSession: (opts: CreateSessionOptions) => Promise<SessionRecord>
  resumeSession: (sessionId: string) => Promise<void>
  sendMessage: (sessionId: string, text: string, modelSelection?: ModelSelection) => Promise<void>
  interrupt: (sessionId: string) => Promise<void>
  respondToPrompt: (sessionId: string, requestId: string, decision: PromptDecision) => Promise<void>
  forkSession: (sessionId: string) => Promise<SessionRecord>
  restartSession: (sessionId: string) => Promise<SessionRecord>
  closeSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, name: string) => Promise<void>
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
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
    return () => {
      offMessage()
      offDelta()
      offLifecycle()
      offStatus()
      offGroup()
      offTurnState()
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

  const sendMessage = useCallback(async (sessionId: string, text: string, modelSelection?: ModelSelection): Promise<void> => {
    await window.gardenia.sendSessionMessage(sessionId, text, modelSelection)
  }, [])

  const interrupt = useCallback(async (sessionId: string): Promise<void> => {
    await window.gardenia.interruptSession(sessionId)
  }, [])

  const respondToPrompt = useCallback(
    async (sessionId: string, requestId: string, decision: PromptDecision): Promise<void> => {
      await window.gardenia.respondToPrompt(sessionId, requestId, decision)
    },
    []
  )

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
    refresh,
    createSession,
    resumeSession,
    sendMessage,
    interrupt,
    respondToPrompt,
    forkSession,
    restartSession,
    closeSession,
    deleteSession,
    renameSession,
    setPinned,
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
