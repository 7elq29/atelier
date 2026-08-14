import type { MessageRecord } from '../../../shared/session-types'

type MessagesBySession = Record<string, MessageRecord[]>

let messagesBySession: MessagesBySession = {}
const listeners = new Set<() => void>()

const EMPTY_MESSAGES: MessageRecord[] = []

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeSessionMessages(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSessionMessagesSnapshot(): MessagesBySession {
  return messagesBySession
}

export function getSessionMessages(sessionId: string): MessageRecord[] {
  return messagesBySession[sessionId] ?? EMPTY_MESSAGES
}

export function hasSessionMessages(sessionId: string): boolean {
  return sessionId in messagesBySession
}

export function setSessionMessages(sessionId: string, messages: MessageRecord[]): void {
  messagesBySession = { ...messagesBySession, [sessionId]: messages }
  emit()
}

export function patchSessionMessages(
  updater: (prev: MessagesBySession) => MessagesBySession
): void {
  const next = updater(messagesBySession)
  if (next === messagesBySession) return
  messagesBySession = next
  emit()
}

export function removeSessionMessages(sessionId: string): void {
  if (!(sessionId in messagesBySession)) return
  const next = { ...messagesBySession }
  delete next[sessionId]
  messagesBySession = next
  emit()
}

/** Registers IPC listeners once; returns cleanup. */
export function initSessionMessagesListeners(): () => void {
  const offMessage = window.atelier.onSessionMessage(({ sessionId, message }) => {
    patchSessionMessages((prev) => {
      const list = prev[sessionId]
      if (!list) return { ...prev, [sessionId]: [message] }
      const idx = list.findIndex((m) => m.id === message.id)
      if (idx === -1) return { ...prev, [sessionId]: [...list, message] }
      const next = [...list]
      next[idx] = message
      return { ...prev, [sessionId]: next }
    })
  })

  const offMessageRemoved = window.atelier.onSessionMessageRemoved(({ sessionId, messageId }) => {
    patchSessionMessages((prev) => {
      const list = prev[sessionId]
      if (!list) return prev
      const next = list.filter((m) => m.id !== messageId)
      if (next.length === list.length) return prev
      return { ...prev, [sessionId]: next }
    })
  })

  const offDelta = window.atelier.onSessionStreamDelta(({ sessionId, messageId, text }) => {
    patchSessionMessages((prev) => {
      const list = prev[sessionId]
      if (!list) return prev
      const idx = list.findIndex((m) => m.id === messageId)
      if (idx === -1) return prev
      const next = [...list]
      next[idx] = { ...next[idx], content: text }
      return { ...prev, [sessionId]: next }
    })
  })

  return () => {
    offMessage()
    offMessageRemoved()
    offDelta()
  }
}
