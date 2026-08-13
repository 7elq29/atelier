import type { ThinkingBlockContent } from '../../../../shared/chat-content'

export function formatThinkingTokens(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `~${n}`
}

/**
 * Extended-reasoning indicator — muted one-line text while streaming (blinking
 * cursor) and after completion (same line, no card chrome).
 */
export default function ThinkingBlockInline({ content }: { content: ThinkingBlockContent }): JSX.Element {
  const running = content.status === 'running'
  const tokens =
    content.estimatedTokens != null && content.estimatedTokens > 0
      ? formatThinkingTokens(content.estimatedTokens)
      : null

  return (
    <div
      className={`thinking-inline${running ? '' : ' thinking-inline-completed'}`}
      data-testid="thinking-block-inline"
      data-thinking-status={content.status}
    >
      <span className="thinking-inline-text">
        {running ? 'Extended reasoning…' : 'Extended reasoning'}
        {tokens ? <> · {tokens} tokens</> : null}
      </span>
      {running ? (
        <span className="thinking-inline-cursor" aria-hidden="true" data-testid="thinking-running-indicator" />
      ) : null}
    </div>
  )
}
