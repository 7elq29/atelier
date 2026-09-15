import type { MessageRecord } from './session-types'

/** Max user-turn conversations shown in the chat transcript (older turns stay in SQLite). */
export const CHAT_TRANSCRIPT_MAX_TURNS = 20

export type SessionMessagesResult = {
  messages: MessageRecord[]
  transcriptTruncated: boolean
  hiddenTurnCount: number
}
