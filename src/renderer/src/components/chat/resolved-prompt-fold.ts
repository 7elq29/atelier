import type {
  AskUserQuestionContent,
  PermissionRequestContent,
  PlanProposedContent
} from '../../../../shared/chat-content'

/** Collapsed summary rows — not the expanded card — must stay one scannable line. */
const FOLD_DETAIL_MAX = 72

function truncateFoldDetail(text: string, max = FOLD_DETAIL_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max - 1)}…`
}

export function permissionResolvedSummary(content: PermissionRequestContent): string {
  if (content.status === 'expired') return 'Expired'
  if (content.status === 'allowed') {
    return content.alwaysAllowed ? 'Allowed (always)' : 'Allowed'
  }
  if (content.status === 'denied') return 'Denied'
  return ''
}

export function permissionFoldSummary(content: PermissionRequestContent, command: string): string {
  const verb = permissionResolvedSummary(content)
  const detail = command.trim() || content.toolName
  return `Permission ${verb.toLowerCase()} — ${detail}`
}

export function askUserResolvedSummary(content: AskUserQuestionContent): string {
  if (content.status === 'expired') return 'Expired'
  if (content.status === 'cancelled') return 'Skipped'
  if (content.status === 'answered' && content.answers) {
    const parts = Object.values(content.answers).filter(Boolean)
    if (parts.length === 1) return parts[0]!
    if (parts.length > 1) return parts.join(', ')
  }
  return 'Answered'
}

export function askUserFoldSummary(content: AskUserQuestionContent): string {
  if (content.status === 'expired') return 'Question expired'
  if (content.status === 'cancelled') return 'Question skipped — continued in chat'
  const answer = askUserResolvedSummary(content)
  return `Question answered — ${truncateFoldDetail(answer)}`
}

export function planResolvedSummary(content: PlanProposedContent): string {
  switch (content.status) {
    case 'accepted':
      return 'Accepted'
    case 'rejected':
      return 'Rejected'
    case 'keep_planning':
      return 'Keep planning'
    case 'expired':
      return 'Expired'
    default:
      return ''
  }
}

export function planFoldSummary(content: PlanProposedContent): string {
  return `Proposed plan — ${planResolvedSummary(content).toLowerCase()}`
}

export function permissionCommandText(content: PermissionRequestContent): string {
  const input = content.input as Record<string, unknown> | undefined
  if (content.toolName === 'Bash' && typeof input?.command === 'string') {
    // Multiline/heredoc commands stay full-size in the expanded permission card only.
    const firstLine = input.command.split('\n')[0]?.trim() ?? input.command
    return truncateFoldDetail(firstLine)
  }
  if (typeof input?.file_path === 'string') return truncateFoldDetail(input.file_path)
  return content.toolName
}

/** Fold phrase for a resolved sidecar, or null while still pending. */
export function promptFoldSummary(
  content: PermissionRequestContent | AskUserQuestionContent | PlanProposedContent
): string | null {
  if (content.status === 'pending') return null
  switch (content.kind) {
    case 'permission_request':
      return permissionFoldSummary(content, permissionCommandText(content))
    case 'ask_user_question':
      return askUserFoldSummary(content)
    case 'plan_proposed':
      return planFoldSummary(content)
    default:
      return null
  }
}
