import type { MessageRecord } from '../../../shared/session-types'

type MessagesBySession = Record<string, MessageRecord[]>

export type TranscriptTruncationInfo = {
  transcriptTruncated: boolean
  hiddenTurnCount: number
}

type TruncationBySession = Record<string, TranscriptTruncationInfo>

let messagesBySession: MessagesBySession = {}
let truncationBySession: TruncationBySession = {}
const listeners = new Set<() => void>()
/** Stream deltas that arrived before the target message row was loaded. */
const pendingStreamDeltas = new Map<string, Map<number, string>>()

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

export function getTranscriptTruncation(sessionId: string): TranscriptTruncationInfo | null {
  return truncationBySession[sessionId] ?? null
}

export function setSessionMessages(
  sessionId: string,
  messages: MessageRecord[],
  truncation?: TranscriptTruncationInfo
): void {
  messagesBySession = { ...messagesBySession, [sessionId]: messages }
  if (truncation) {
    truncationBySession = { ...truncationBySession, [sessionId]: truncation }
  } else {
    const next = { ...truncationBySession }
    delete next[sessionId]
    truncationBySession = next
  }
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
  if (!(sessionId in messagesBySession) && !(sessionId in truncationBySession)) {
    pendingStreamDeltas.delete(sessionId)
    return
  }
  const next = { ...messagesBySession }
  delete next[sessionId]
  messagesBySession = next
  if (sessionId in truncationBySession) {
    const nextTrunc = { ...truncationBySession }
    delete nextTrunc[sessionId]
    truncationBySession = nextTrunc
  }
  pendingStreamDeltas.delete(sessionId)
  emit()
}

function applyBufferedDelta(
  list: MessageRecord[],
  sessionId: string,
  messageId: number
): MessageRecord[] | null {
  const buffered = pendingStreamDeltas.get(sessionId)?.get(messageId)
  if (buffered === undefined) return null
  pendingStreamDeltas.get(sessionId)?.delete(messageId)
  const idx = list.findIndex((m) => m.id === messageId)
  if (idx === -1) return null
  const next = [...list]
  next[idx] = { ...next[idx], content: buffered }
  return next
}

/** Registers IPC listeners once; returns cleanup. */
export function initSessionMessagesListeners(): () => void {
  const offMessage = window.atelier.onSessionMessage(({ sessionId, message }) => {
    patchSessionMessages((prev) => {
      const list = prev[sessionId]
      if (!list) return { ...prev, [sessionId]: [message] }
      const idx = list.findIndex((m) => m.id === message.id)
      let next: MessageRecord[]
      if (idx === -1) next = [...list, message]
      else {
        next = [...list]
        next[idx] = message
      }
      const buffered = applyBufferedDelta(next, sessionId, message.id)
      if (buffered) next = buffered
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
      if (!list) {
        const byMessage = pendingStreamDeltas.get(sessionId) ?? new Map<number, string>()
        byMessage.set(messageId, text)
        pendingStreamDeltas.set(sessionId, byMessage)
        return prev
      }
      const idx = list.findIndex((m) => m.id === messageId)
      if (idx === -1) {
        const byMessage = pendingStreamDeltas.get(sessionId) ?? new Map<number, string>()
        byMessage.set(messageId, text)
        pendingStreamDeltas.set(sessionId, byMessage)
        return prev
      }
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
