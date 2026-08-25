import {
  parseStructuredContent,
  type AskUserQuestionContent,
  type PermissionRequestContent,
  type PlanProposedContent
} from '../../../../shared/chat-content'
import type { MessageRecord } from '../../../../shared/session-types'

type InteractivePromptContent = PermissionRequestContent | AskUserQuestionContent | PlanProposedContent

function asInteractivePrompt(content: ReturnType<typeof parseStructuredContent>): InteractivePromptContent | null {
  if (!content) return null
  if (
    content.kind === 'permission_request' ||
    content.kind === 'ask_user_question' ||
    content.kind === 'plan_proposed'
  ) {
    return content
  }
  return null
}

/** Sidebar dot: pending permission / AskUserQuestion / plan card needs the alert icon. */
export function pendingInteractivePromptDotStatus(messages: MessageRecord[] | undefined): 'waiting-blocked' | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') break
    if (m.role !== 'assistant') continue
    const prompt = asInteractivePrompt(parseStructuredContent(m.content))
    if (!prompt) break
    if (prompt.status === 'pending') return 'waiting-blocked'
    break
  }
  return null
}

/** Running tool chip: same toolUseId as a pending interactive prompt card. */
export function isToolAwaitingUserApproval(toolUseId: string, messages: MessageRecord[] | undefined): boolean {
  if (!messages) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') break
    if (m.role !== 'assistant') continue
    const prompt = asInteractivePrompt(parseStructuredContent(m.content))
    if (!prompt) continue
    if (prompt.status === 'pending' && prompt.toolUseId === toolUseId) return true
    if (prompt.toolUseId === toolUseId) break
  }
  return false
}
