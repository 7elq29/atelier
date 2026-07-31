import { useState } from 'react'
import type { ToolCallContent } from '../../../../shared/chat-content'

/** Maps a tool name to one of the mock's `.tool-badge` color classes (bash/read/edit are the ones defined verbatim in mocks/index.html; the rest extend that same token-driven pattern for tool types the mock didn't enumerate). */
function toolBadgeClass(name: string): string {
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

  return (
    <div
      className={`tool-card${open ? ' open' : ''}`}
      data-testid="tool-card"
      data-tool-name={content.name}
      data-tool-status={content.status}
      data-tool-use-id={content.toolUseId}
      data-parent-tool-use-id={content.parentToolUseId ?? ''}
      onClick={() => setOpen((v) => !v)}
    >
      <div className="tool-head">
        <span className={`tool-badge ${badge}`}>{content.name.toUpperCase()}</span>
        <span className="tool-headline">{toolHeadline(content.name, content.input)}</span>
        {running ? (
          <span className="spinner" data-testid="tool-running-indicator" />
        ) : (
          <span
            className={`tool-status ${content.status === 'error' ? 'error' : 'ok'}`}
            data-testid="tool-status-chip"
          >
            {content.status === 'error' ? 'error' : 'completed'}
          </span>
        )}
        <span className="tool-chev">▸</span>
      </div>
      <div className="tool-body">
        <pre data-testid="tool-input">{JSON.stringify(content.input, null, 2)}</pre>
        {!running && <pre data-testid="tool-output">{outputText(content.output)}</pre>}
      </div>
    </div>
  )
}
