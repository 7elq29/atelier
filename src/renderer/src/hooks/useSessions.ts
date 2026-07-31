import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CreateSessionOptions,
  MessageRecord,
  RemoteHostOption,
  SessionRecord
} from '../../../shared/session-types'

export interface UseSessionsResult {
  activeSessions: SessionRecord[]
  historySessions: SessionRecord[]
  hosts: RemoteHostOption[]
  messagesBySession: Record<string, MessageRecord[]>
  refresh: () => Promise<void>
  createSession: (opts: CreateSessionOptions) => Promise<SessionRecord>
  resumeSession: (sessionId: string) => Promise<void>
  sendMessage: (sessionId: string, text: string) => Promise<void>
  forkSession: (sessionId: string) => Promise<SessionRecord>
  restartSession: (sessionId: string) => Promise<SessionRecord>
  closeSession: (sessionId: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, name: string) => Promise<void>
  setPinned: (sessionId: string, pinned: boolean) => Promise<void>
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
  const messagesRef = useRef(messagesBySession)
  messagesRef.current = messagesBySession

  const refresh = useCallback(async () => {
    const [active, history] = await Promise.all([
      window.gardenia.listActiveSessions(),
      window.gardenia.listHistorySessions()
    ])
    setActiveSessions(active)
    setHistorySessions(history)
  }, [])

  useEffect(() => {
    refresh()
    window.gardenia.listHosts().then(setHosts)

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
    return () => {
      offMessage()
      offDelta()
      offLifecycle()
    }
  }, [refresh])

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

  const sendMessage = useCallback(async (sessionId: string, text: string): Promise<void> => {
    await window.gardenia.sendSessionMessage(sessionId, text)
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

  return {
    activeSessions,
    historySessions,
    hosts,
    messagesBySession,
    refresh,
    createSession,
    resumeSession,
    sendMessage,
    forkSession,
    restartSession,
    closeSession,
    deleteSession,
    renameSession,
    setPinned
  }
}
