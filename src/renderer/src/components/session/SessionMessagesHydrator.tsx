import { useEffect } from 'react'
import { useSessionHasMessages } from '../../hooks/useSessionMessages'

/** Loads transcript from SQLite when a session becomes interactive without cached messages. */
export function SessionMessagesHydrator({
  sessionId,
  enabled,
  loadSessionMessages
}: {
  sessionId: string
  enabled: boolean
  loadSessionMessages: (sessionId: string) => Promise<void>
}): null {
  const hasMessages = useSessionHasMessages(sessionId)
  useEffect(() => {
    if (!enabled || hasMessages) return
    void loadSessionMessages(sessionId)
  }, [sessionId, enabled, hasMessages, loadSessionMessages])
  return null
}
