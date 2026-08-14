import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionWorkspacePayload } from '../../../shared/session-workspace-types'

export function useSessionWorkspace(): {
  workspaceBySession: Record<string, SessionWorkspacePayload>
  readySessionIds: Set<string>
  hydrateSnapshot: (sessionId: string) => void
  evictSession: (sessionId: string) => void
} {
  const [workspaceBySession, setWorkspaceBySession] = useState<Record<string, SessionWorkspacePayload>>({})
  const [readySessionIds, setReadySessionIds] = useState<Set<string>>(() => new Set())
  const hydrateGenerationRef = useRef(new Map<string, number>())

  const mergeWorkspace = useCallback((sessionId: string, workspace: SessionWorkspacePayload) => {
    setWorkspaceBySession((prev) => ({ ...prev, [sessionId]: workspace }))
    setReadySessionIds((prev) => {
      if (prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.add(sessionId)
      return next
    })
  }, [])

  const hydrateSnapshot = useCallback((sessionId: string) => {
    const generation = (hydrateGenerationRef.current.get(sessionId) ?? 0) + 1
    hydrateGenerationRef.current.set(sessionId, generation)
    void window.atelier.refreshSessionWorkspace(sessionId, false).then((workspace) => {
      if (hydrateGenerationRef.current.get(sessionId) !== generation) return
      if (workspace) mergeWorkspace(sessionId, workspace)
    })
  }, [mergeWorkspace])

  const evictSession = useCallback((sessionId: string) => {
    hydrateGenerationRef.current.set(sessionId, (hydrateGenerationRef.current.get(sessionId) ?? 0) + 1)
    setWorkspaceBySession((prev) => {
      if (!(sessionId in prev)) return prev
      const next = { ...prev }
      delete next[sessionId]
      return next
    })
    setReadySessionIds((prev) => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
  }, [])

  useEffect(() => {
    return window.atelier.onSessionOpenReady(({ sessionId, workspace }) => {
      mergeWorkspace(sessionId, workspace)
    })
  }, [mergeWorkspace])

  useEffect(() => {
    return window.atelier.onSessionWorkspaceUpdated(({ sessionId, workspace }) => {
      setWorkspaceBySession((prev) => ({ ...prev, [sessionId]: workspace }))
    })
  }, [])

  return { workspaceBySession, readySessionIds, hydrateSnapshot, evictSession }
}
