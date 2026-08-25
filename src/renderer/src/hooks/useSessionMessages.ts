import { useSyncExternalStore } from 'react'
import type { MessageRecord } from '../../../shared/session-types'
import {
  getSessionMessages,
  getSessionMessagesSnapshot,
  getTranscriptTruncation,
  hasSessionMessages,
  subscribeSessionMessages,
  type TranscriptTruncationInfo
} from '../stores/session-messages-store'

const EMPTY_MESSAGES: MessageRecord[] = []

/** Live transcript for one session — re-renders only when that session's messages change. */
export function useSessionMessages(sessionId: string | null): MessageRecord[] {
  return useSyncExternalStore(
    subscribeSessionMessages,
    () => (sessionId ? getSessionMessages(sessionId) : EMPTY_MESSAGES),
    () => (sessionId ? getSessionMessages(sessionId) : EMPTY_MESSAGES)
  )
}

/** Full map for sidebar dots — re-renders on any session's message update. */
export function useSessionMessagesMap(): Record<string, MessageRecord[]> {
  return useSyncExternalStore(
    subscribeSessionMessages,
    getSessionMessagesSnapshot,
    getSessionMessagesSnapshot
  )
}

export function useTranscriptTruncation(sessionId: string | null): TranscriptTruncationInfo | null {
  return useSyncExternalStore(
    subscribeSessionMessages,
    () => (sessionId ? getTranscriptTruncation(sessionId) : null),
    () => (sessionId ? getTranscriptTruncation(sessionId) : null)
  )
}

export function useSessionHasMessages(sessionId: string | null): boolean {
  return useSyncExternalStore(
    subscribeSessionMessages,
    () => (sessionId != null ? hasSessionMessages(sessionId) : false),
    () => (sessionId != null ? hasSessionMessages(sessionId) : false)
  )
}
