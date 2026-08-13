/** Active document in the chat tab's right-hand review split pane. */
export interface ReviewPaneTarget {
  sourceId: number
  kind: 'response' | 'plan'
  content: string
  /** Previous plan markdown edition — plan review renders a line diff when set. */
  previousContent?: string
  /** Set when opened from the session changes cap (not a transcript plan card). */
  capFilePath?: string
}

export function reviewPaneTitle(kind: ReviewPaneTarget['kind']): string {
  return kind === 'plan' ? 'Plan review' : 'Response review'
}

export function reviewPaneSubtitle(target: ReviewPaneTarget): string {
  if (target.kind === 'plan' && target.previousContent != null && target.previousContent !== '') {
    return 'Formatted · inline diff · select text to comment'
  }
  return 'Formatted · select text to comment'
}

export function reviewPaneHasDiff(target: ReviewPaneTarget): boolean {
  return target.kind === 'plan' && target.previousContent != null && target.previousContent !== ''
}

export function reviewPaneCommentPrefix(kind: ReviewPaneTarget['kind']): string {
  return kind === 'plan' ? 'Re plan' : 'Re response'
}

/** @deprecated Use DOM selection anchors — kept for mock fallback only. */
export function sourceLineNumberForQuote(sourceContent: string, quote: string): number {
  const trimmed = quote.trim()
  if (!trimmed) return 1

  const lines = sourceContent.split('\n')
  const firstLine = trimmed.split('\n')[0] ?? trimmed
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]!.includes(firstLine)) return index + 1
  }

  const offset = sourceContent.indexOf(trimmed)
  if (offset >= 0) {
    return sourceContent.slice(0, offset).split('\n').length
  }

  return 1
}

export function formatReviewComposerNote(
  prefix: string,
  sourceLineNumber: number,
  quote: string,
  body: string
): string {
  const quoted = quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `${prefix} (line ${sourceLineNumber}):\n${quoted}\n\n${body}`
}
