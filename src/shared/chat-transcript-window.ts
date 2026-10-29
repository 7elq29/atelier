import type { MessageRecord } from './session-types'

/** Max user-turn conversations shown in the chat transcript (older turns stay in SQLite). */
export const CHAT_TRANSCRIPT_MAX_TURNS = 50

export type SessionMessagesResult = {
  messages: MessageRecord[]
  transcriptTruncated: boolean
  hiddenTurnCount: number
}

/**
 * Keep only the latest `maxTurns` user-turn conversations (and every message
 * belonging to those turns). Used by the renderer so live IPC appends (e.g.
 * Minion full WS replay) cannot grow the painted transcript past the window.
 */
export function windowMessagesForDisplay(
  messages: MessageRecord[],
  maxTurns = CHAT_TRANSCRIPT_MAX_TURNS,
  priorHiddenTurnCount = 0
): SessionMessagesResult {
  const userIndexes: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIndexes.push(i)
  }
  const totalTurns = priorHiddenTurnCount + userIndexes.length
  if (userIndexes.length <= maxTurns) {
    return {
      messages,
      transcriptTruncated: priorHiddenTurnCount > 0,
      hiddenTurnCount: priorHiddenTurnCount
    }
  }
  const startIdx = userIndexes[userIndexes.length - maxTurns]!
  const kept = messages.slice(startIdx)
  const hiddenTurnCount = totalTurns - maxTurns
  return {
    messages: kept,
    transcriptTruncated: hiddenTurnCount > 0,
    hiddenTurnCount
  }
}
