import { useState } from 'react'
import type { ThinkingBlockContent } from '../../../../shared/chat-content'

function formatThinkingTokens(n: number): string {
  if (n >= 1000) return `~${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `~${n}`
}

/**
 * Extended-thinking partial stream (`thinking_block` structured content).
 * Same `.tool-card` chrome as tool calls; muted left rule while running.
 */
export default function ThinkingBlockCard({ content }: { content: ThinkingBlockContent }): JSX.Element {
  const [open, setOpen] = useState(false)
  const running = content.status === 'running'
  const hasText = (content.text?.trim().length ?? 0) > 0

  return (
    <div
      className={`tool-card thinking-block${open ? ' open' : ''}${running ? ' thinking-block-running' : ''}`}
      data-testid="thinking-block-card"
      data-thinking-status={content.status}
      onClick={() => setOpen((v) => !v)}
    >
      <div className="tool-head">
        <span className="tool-badge other">THINKING</span>
        <span className="tool-headline">{running ? 'Extended reasoning…' : 'Extended reasoning'}</span>
        {content.estimatedTokens != null && content.estimatedTokens > 0 && (
          <span className="tool-elapsed" data-testid="thinking-token-estimate">
            {formatThinkingTokens(content.estimatedTokens)} tokens
          </span>
        )}
        {running ? <span className="spinner" data-testid="thinking-running-indicator" /> : null}
        <span className="tool-chev">▸</span>
      </div>
      {(hasText || !running) && (
        <div className="tool-body">
          <pre className="thinking-block-detail" data-testid="thinking-block-text">
            {content.text?.trim() ? content.text : '(redacted)'}
          </pre>
        </div>
      )}
    </div>
  )
}
