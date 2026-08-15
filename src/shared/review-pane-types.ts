/** Active document in the chat tab's right-hand review split pane. */
export interface ReviewPaneTarget {
  sourceId: number
  kind: 'response' | 'plan' | 'file'
  content: string
  /** Previous edition / HEAD baseline — plan and cap file review render inline diff when set. */
  previousContent?: string
  /** Set when opened from the session changes cap (not a transcript plan card). */
  capFilePath?: string
}

export function reviewPaneTitle(target: ReviewPaneTarget): string {
  if (target.kind === 'plan') return 'Plan review'
  if (target.kind === 'file') {
    const path = target.capFilePath ?? ''
    const base = path.replace(/\\/g, '/').split('/').filter(Boolean).pop()
    return base ?? 'File review'
  }
  return 'Response review'
}

export function reviewPaneSubtitle(target: ReviewPaneTarget): string {
  if (target.kind === 'file' && reviewPaneHasDiff(target)) {
    return 'Inline diff · select text to comment'
  }
  if (target.kind === 'plan' && target.previousContent != null && target.previousContent !== '') {
    return 'Formatted · inline diff · select text to comment'
  }
  return 'Formatted · select text to comment'
}

export function reviewPaneHasDiff(target: ReviewPaneTarget): boolean {
  if (target.kind === 'file') return true
  return target.kind === 'plan' && target.previousContent != null && target.previousContent !== ''
}

export function reviewPaneCommentPrefix(kind: ReviewPaneTarget['kind']): string {
  if (kind === 'plan') return 'Re plan'
  if (kind === 'file') return 'Re file'
  return 'Re response'
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
  sourceLineNumber: number | string,
  quote: string,
  body: string
): string {
  const quoted = quote
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `${prefix} (line ${sourceLineNumber}):\n${quoted}\n\n${body}`
}

/** User-facing quote snippet — single line, ellipsis when long. */
export function truncateReviewQuote(quote: string, maxLen = 44): string {
  const flat = quote.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxLen) return flat
  return `${flat.slice(0, maxLen - 1)}…`
}

export interface ParsedReviewComposerNote {
  prefix: string
  sourceLineLabel: string
  quote: string
  body: string
}

/** Parse a structured review composer note back into parts (for display cards). */
export function parseReviewComposerNote(note: string): ParsedReviewComposerNote | null {
  const headerMatch = note.match(/^(Re .+?) \(line ([^)]+)\):\n/)
  if (!headerMatch) return null
  const rest = note.slice(headerMatch[0].length)
  const splitAt = rest.indexOf('\n\n')
  const quoteBlock = splitAt >= 0 ? rest.slice(0, splitAt) : rest
  const body = splitAt >= 0 ? rest.slice(splitAt + 2) : ''
  const quote = quoteBlock
    .split('\n')
    .map((line) => line.replace(/^> ?/, ''))
    .join('\n')
    .trim()
  return {
    prefix: headerMatch[1]!,
    sourceLineLabel: headerMatch[2]!,
    quote,
    body: body.trim()
  }
}

export interface ReviewComposerComment extends ParsedReviewComposerNote {
  id: string
  /** Full note appended on send — unchanged machine format for the agent. */
  composerNote: string
}

/** Text merged into the outgoing user message (review notes + composer body). */
export function buildComposerSendText(
  text: string,
  reviewComments: readonly Pick<
    ParsedReviewComposerNote,
    'prefix' | 'sourceLineLabel' | 'quote' | 'body'
  >[]
): string {
  const composerBody = text.trim()
  if (reviewComments.length === 0) return composerBody
  const notes = reviewComments.map((c) =>
    formatReviewComposerNote(c.prefix, c.sourceLineLabel, c.quote, c.body)
  )
  return [notes.join('\n\n'), composerBody].filter(Boolean).join('\n\n')
}
