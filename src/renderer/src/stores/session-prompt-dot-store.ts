import type { MessageRecord } from '../../../shared/session-types'
import { pendingInteractivePromptDotStatus } from '../components/chat/interactive-prompt-status'

export type SessionPromptDot = 'waiting-blocked' | null

type PromptDotBySession = Record<string, SessionPromptDot>

let promptDotBySession: PromptDotBySession = {}
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeSessionPromptDots(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSessionPromptDotsSnapshot(): PromptDotBySession {
  return promptDotBySession
}

export function getSessionPromptDot(sessionId: string): SessionPromptDot {
  return promptDotBySession[sessionId] ?? null
}

/** Recompute sidebar dot hint from transcript — skip on stream deltas (content-only growth). */
export function syncSessionPromptDot(sessionId: string, messages: MessageRecord[] | undefined): void {
  const next = pendingInteractivePromptDotStatus(messages)
  if ((promptDotBySession[sessionId] ?? null) === next) return
  promptDotBySession = { ...promptDotBySession, [sessionId]: next }
  emit()
}

export function removeSessionPromptDot(sessionId: string): void {
  if (!(sessionId in promptDotBySession)) return
  const next = { ...promptDotBySession }
  delete next[sessionId]
  promptDotBySession = next
  emit()
}
