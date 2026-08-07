import { useState } from 'react'
import type { ToolCallContent, ToolCallStatus } from '../../../../shared/chat-content'

/** Maps a tool name to one of the mock's `.tool-badge` color classes (bash/read/edit are the ones defined verbatim in mocks/index.html; the rest extend that same token-driven pattern for tool types the mock didn't enumerate). Exported for reuse by `ToolCallSequence.tsx`'s aggregate-summary grouping (14-tool-call-sequence-collapse), which buckets by these same classes. */
export function toolBadgeClass(name: string): string {
  const key = name.toLowerCase()
  if (key === 'bash') return 'bash'
  if (key === 'read') return 'read'
  if (key === 'edit' || key === 'write' || key === 'notebookedit' || key === 'multiedit') return 'edit'
  // "Task" is the tool name documented by the Agent SDK; this Uber-internal
  // Claude Code build calls the same subagent-spawning tool "Agent" instead
  // (verified for real — see 03-chat-surface-core's progress notes) — both
  // get the same badge.
  if (key === 'task' || key === 'agent') return 'task'
  if (key === 'grep' || key === 'glob') return 'grep'
  if (key === 'webfetch' || key === 'websearch') return 'web'
  if (key === 'todowrite' || key === 'taskcreate' || key === 'taskupdate') return 'todo'
  return 'other'
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** One-line headline: the command for Bash, the file path for Read/Edit/Write, etc. */
export function toolHeadline(name: string, input: unknown): string {
  const obj = asRecord(input)
  switch (name) {
    case 'Bash':
      return typeof obj.command === 'string' ? obj.command : name
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
    case 'MultiEdit':
      return typeof obj.file_path === 'string' ? obj.file_path : name
    case 'Grep':
      return typeof obj.pattern === 'string' ? `grep ${obj.pattern}` : name
    case 'Glob':
      return typeof obj.pattern === 'string' ? String(obj.pattern) : name
    case 'Task':
    case 'Agent':
      return typeof obj.description === 'string'
        ? obj.description
        : typeof obj.subagent_type === 'string'
          ? String(obj.subagent_type)
          : 'Task'
    case 'WebFetch':
      return typeof obj.url === 'string' ? obj.url : name
    case 'WebSearch':
      return typeof obj.query === 'string' ? obj.query : name
    default:
      return name
  }
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length
}

function formatToolElapsed(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * One-line "what changed" summary for edit-type tools' collapsed row
 * (14-tool-call-sequence-collapse), computed purely from `input` — no diff
 * tool, no waiting on anything beyond the call having finished. Returns null
 * while running (no summary yet, matching the spec) or when the expected
 * input shape isn't present (fall back to headline-only rather than guess).
 */
export function editSummary(name: string, input: unknown, status: ToolCallStatus): string | null {
  if (status === 'running') return null
  const obj = asRecord(input)
  switch (name) {
    case 'Edit': {
      const oldStr = obj.old_string
      const newStr = obj.new_string
      if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null
      return `+${countLines(newStr)} -${countLines(oldStr)} lines`
    }
    case 'MultiEdit': {
      const edits = obj.edits
      if (!Array.isArray(edits) || edits.length === 0) return null
      let added = 0
      let removed = 0
      for (const edit of edits) {
        const e = asRecord(edit)
        if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') return null
        added += countLines(e.new_string)
        removed += countLines(e.old_string)
      }
      return `+${added} -${removed} lines`
    }
    case 'Write': {
      const content = obj.content
      if (typeof content !== 'string') return null
      return `${countLines(content)} lines written`
    }
    case 'NotebookEdit':
      // Minimal, computable phrasing — this tool is rare enough that
      // per-cell-type/diff detail isn't worth the complexity (per spec).
      return '1 cell edited'
    default:
      return null
  }
}

function outputText(output: unknown): string {
  if (output == null) return ''
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((block) =>
        block && typeof block === 'object' && 'text' in (block as Record<string, unknown>)
          ? String((block as Record<string, unknown>).text)
          : JSON.stringify(block)
      )
      .join('\n')
  }
  return JSON.stringify(output, null, 2)
}

/**
 * Collapsible tool-call card (03-chat-surface-core): colored badge by tool
 * type, one-line headline, status chip that flips to completed/error on
 * `tool_call_end` (via `content.status`, kept in sync by SessionManager),
 * full input/output visible when expanded, a pulsing `.spinner` while
 * running. Markup/classes match `.tool-card`/`.tool-head`/etc. in
 * mocks/index.html exactly.
 */
export default function ToolCallCard({ content }: { content: ToolCallContent }): JSX.Element {
  const [open, setOpen] = useState(false)
  const badge = toolBadgeClass(content.name)
  const running = content.status === 'running'
  // Only edit-type tools (Edit/Write/NotebookEdit/MultiEdit) get a collapsed
  // change summary next to the headline; every other tool type stays
  // headline-only, unchanged from before (14-tool-call-sequence-collapse).
  const summary = !open && badge === 'edit' ? editSummary(content.name, content.input, content.status) : null

  return (
    <div
      className={`tool-card${open ? ' open' : ''}${content.status === 'denied' ? ' tool-denied' : ''}`}
      data-testid="tool-card"
      data-tool-name={content.name}
      data-tool-status={content.status}
      data-tool-use-id={content.toolUseId}
      data-parent-tool-use-id={content.parentToolUseId ?? ''}
      onClick={(e) => {
        // Stop propagation: a ToolCallCard can now sit inside an expanded
        // `.tool-sequence-summary` aggregate row (14-tool-call-sequence-
        // collapse), which is itself clickable to collapse/expand. Without
        // this, clicking a nested card would also bubble up and immediately
        // re-collapse the aggregate it's sitting inside.
        e.stopPropagation()
        setOpen((v) => !v)
      }}
    >
      <div className="tool-head">
        <span className={`tool-badge ${badge}`}>{content.name.toUpperCase()}</span>
        <span className="tool-headline">{toolHeadline(content.name, content.input)}</span>
        {summary && (
          <span className="tool-edit-summary" data-testid="tool-edit-summary">
            {summary}
          </span>
        )}
        {running ? (
          <>
            {content.inputStreamJson && (
              <span className="tool-stream-hint" data-testid="tool-input-stream-hint">
                Composing…
              </span>
            )}
            {content.elapsedTimeSeconds != null && content.elapsedTimeSeconds > 0 && (
              <span className="tool-elapsed" data-testid="tool-elapsed">
                {formatToolElapsed(content.elapsedTimeSeconds)}
              </span>
            )}
            <span className="spinner" data-testid="tool-running-indicator" />
          </>
        ) : (
          <span
            className={`tool-status ${
              content.status === 'error'
                ? 'error'
                : content.status === 'interrupted'
                  ? 'interrupted'
                  : content.status === 'denied'
                    ? 'denied'
                    : 'ok'
            }`}
            data-testid="tool-status-chip"
          >
            {content.status === 'error'
              ? 'error'
              : content.status === 'interrupted'
                ? 'interrupted'
                : content.status === 'denied'
                  ? 'denied'
                  : 'completed'}
          </span>
        )}
        <span className="tool-chev">▸</span>
      </div>
      <div className="tool-body">
        {running && content.inputStreamJson ? (
          <pre className="tool-card-detail" data-testid="tool-input-stream">
            {content.inputStreamJson}
          </pre>
        ) : (
          <pre className="tool-card-detail" data-testid="tool-input">
            {JSON.stringify(content.input, null, 2)}
          </pre>
        )}
        {!running && (
          <pre className="tool-card-detail" data-testid="tool-output">
            {outputText(content.output)}
          </pre>
        )}
      </div>
    </div>
  )
}
