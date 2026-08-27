import { useSyncExternalStore } from 'react'
import type { MessageRecord } from '../../../shared/session-types'
import {
  getSessionMessages,
  getTranscriptTruncation,
  hasSessionMessages,
  subscribeSessionMessages,
  type TranscriptTruncationInfo
} from '../stores/session-messages-store'
import {
  getSessionPromptDotsSnapshot,
  subscribeSessionPromptDots,
  type SessionPromptDot
} from '../stores/session-prompt-dot-store'

const EMPTY_MESSAGES: MessageRecord[] = []

/** Live transcript for one session — re-renders only when that session's messages change. */
export function useSessionMessages(sessionId: string | null): MessageRecord[] {
  return useSyncExternalStore(
    subscribeSessionMessages,
    () => (sessionId ? getSessionMessages(sessionId) : EMPTY_MESSAGES),
    () => (sessionId ? getSessionMessages(sessionId) : EMPTY_MESSAGES)
  )
}

/** Sidebar prompt-dot hints — skips stream-delta content-only updates. */
export function useSessionPromptDotsMap(): Record<string, SessionPromptDot> {
  return useSyncExternalStore(
    subscribeSessionPromptDots,
    getSessionPromptDotsSnapshot,
    getSessionPromptDotsSnapshot
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
