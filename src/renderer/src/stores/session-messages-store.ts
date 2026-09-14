import type { MessageRecord } from '../../../shared/session-types'
import { removeSessionPromptDot, syncSessionPromptDot } from './session-prompt-dot-store'

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
/** Coalesced stream text flushed once per animation frame. */
const pendingStreamFlush = new Map<string, Map<number, string>>()
let streamFlushRaf = 0
let emitRaf = 0

const EMPTY_MESSAGES: MessageRecord[] = []

function emit(): void {
  for (const listener of listeners) listener()
}

/** Coalesce subscriber wakeups to one per frame (stream deltas + tool/message bursts). */
function scheduleEmit(): void {
  if (emitRaf !== 0) return
  emitRaf = requestAnimationFrame(() => {
    emitRaf = 0
    emit()
  })
}

function flushPendingStreamDeltas(): void {
  streamFlushRaf = 0
  if (pendingStreamFlush.size === 0) return

  patchSessionMessages((prev) => {
    let next: MessagesBySession | null = null

    for (const [sessionId, byMessage] of pendingStreamFlush) {
      const list = (next ?? prev)[sessionId]
      if (!list) {
        for (const [messageId, text] of byMessage) {
          const byMsg = pendingStreamDeltas.get(sessionId) ?? new Map<number, string>()
          byMsg.set(messageId, text)
          pendingStreamDeltas.set(sessionId, byMsg)
        }
        continue
      }

      for (const [messageId, text] of byMessage) {
        const idx = list.findIndex((m) => m.id === messageId)
        if (idx === -1) {
          const byMsg = pendingStreamDeltas.get(sessionId) ?? new Map<number, string>()
          byMsg.set(messageId, text)
          pendingStreamDeltas.set(sessionId, byMsg)
          continue
        }
        if (!next) next = { ...prev }
        let sessionList = next[sessionId]
        if (sessionList === list) {
          sessionList = [...list]
          next[sessionId] = sessionList
        }
        sessionList[idx] = { ...sessionList[idx], content: text }
      }
    }

    pendingStreamFlush.clear()
    return next ?? prev
  })
}

function scheduleStreamDeltaFlush(): void {
  if (streamFlushRaf !== 0) return
  streamFlushRaf = requestAnimationFrame(flushPendingStreamDeltas)
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
  syncSessionPromptDot(sessionId, messages)
  emit()
}

export function patchSessionMessages(
  updater: (prev: MessagesBySession) => MessagesBySession,
  options?: { syncPromptDots?: boolean }
): void {
  const syncPromptDots = options?.syncPromptDots ?? false
  const prev = messagesBySession
  const next = updater(prev)
  if (next === prev) return
  messagesBySession = next
  if (syncPromptDots) {
    for (const sessionId of Object.keys(next)) {
      if (next[sessionId] !== prev[sessionId]) {
        syncSessionPromptDot(sessionId, next[sessionId])
      }
    }
  }
  scheduleEmit()
}

export function removeSessionMessages(sessionId: string): void {
  if (!(sessionId in messagesBySession) && !(sessionId in truncationBySession)) {
    pendingStreamDeltas.delete(sessionId)
    pendingStreamFlush.delete(sessionId)
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
  pendingStreamFlush.delete(sessionId)
  removeSessionPromptDot(sessionId)
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
    patchSessionMessages(
      (prev) => {
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
      },
      { syncPromptDots: true }
    )
  })

  const offMessageRemoved = window.atelier.onSessionMessageRemoved(({ sessionId, messageId }) => {
    patchSessionMessages(
      (prev) => {
        const list = prev[sessionId]
        if (!list) return prev
        const next = list.filter((m) => m.id !== messageId)
        if (next.length === list.length) return prev
        return { ...prev, [sessionId]: next }
      },
      { syncPromptDots: true }
    )
  })

  const offMessagesCleared = window.atelier.onSessionMessagesCleared(({ sessionId }) => {
    setSessionMessages(sessionId, [], { transcriptTruncated: false, hiddenTurnCount: 0 })
  })

  const offDelta = window.atelier.onSessionStreamDelta(({ sessionId, messageId, text }) => {
    let byMessage = pendingStreamFlush.get(sessionId)
    if (!byMessage) {
      byMessage = new Map<number, string>()
      pendingStreamFlush.set(sessionId, byMessage)
    }
    byMessage.set(messageId, text)
    scheduleStreamDeltaFlush()
  })

  return () => {
    offMessage()
    offMessageRemoved()
    offMessagesCleared()
    offDelta()
    if (streamFlushRaf !== 0) {
      cancelAnimationFrame(streamFlushRaf)
      streamFlushRaf = 0
    }
    if (emitRaf !== 0) {
      cancelAnimationFrame(emitRaf)
      emitRaf = 0
    }
    pendingStreamFlush.clear()
  }
}
