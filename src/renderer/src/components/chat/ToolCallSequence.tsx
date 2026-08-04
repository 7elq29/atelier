import { Fragment, useState } from 'react'
import type { ToolCallContent } from '../../../../shared/chat-content'
import ToolCallCard, { toolBadgeClass } from './ToolCallCard'

/**
 * One entry in a tool-call sequence (14-tool-call-sequence-collapse): the
 * `tool` content drives grouping/status decisions, `render` produces
 * whatever this entry's *own* full markup was before this feature existed
 * (its `transcript-message` wrapper + `MessageActions` + `ToolCallCard`,
 * plus a nested `.subagent-wrap` after it if this call spawned a subagent)
 * — kept as a callback so `ToolCallSequence` doesn't need to know whether an
 * entry is a top-level call or a subagent-nested child, just when to call it.
 */
export interface ToolCallSequenceEntry {
  key: string
  tool: ToolCallContent
  render: () => JSX.Element
}

const BUCKET_PHRASE: Record<string, (count: number) => string> = {
  read: (n) => `read ${n} file${n === 1 ? '' : 's'}`,
  bash: (n) => `ran ${n} shell command${n === 1 ? '' : 's'}`,
  edit: (n) => `edited ${n} file${n === 1 ? '' : 's'}`,
  task: (n) => `ran ${n} subagent${n === 1 ? '' : 's'}`,
  grep: (n) => `searched ${n} time${n === 1 ? '' : 's'}`,
  web: (n) => `searched the web ${n} time${n === 1 ? '' : 's'}`,
  todo: (n) => `updated the todo list ${n} time${n === 1 ? '' : 's'}`,
  other: (n) => `ran ${n} other action${n === 1 ? '' : 's'}`
}

/**
 * Aggregate summary text, e.g. "Read 2 files, ran 1 shell command"
 * (14-tool-call-sequence-collapse). Groups by the same `toolBadgeClass`
 * buckets `ToolCallCard` uses for its badge color, in the order each bucket
 * first appears in `tools`, comma-joined, singular/plural per count, only
 * the very first character of the whole string capitalized.
 */
export function buildSequenceSummary(tools: ToolCallContent[]): string {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const tool of tools) {
    const bucket = toolBadgeClass(tool.name)
    if (!counts.has(bucket)) order.push(bucket)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const phrase = order.map((bucket) => BUCKET_PHRASE[bucket](counts.get(bucket) ?? 0)).join(', ')
  return phrase.length > 0 ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : ''
}

/** The one clickable/expandable aggregate row that finished calls collapse into. */
function SequenceSummaryRow({ entries }: { entries: ToolCallSequenceEntry[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = buildSequenceSummary(entries.map((entry) => entry.tool))

  return (
    <div
      className={`tool-sequence-summary${open ? ' open' : ''}`}
      data-testid="tool-sequence-summary"
      onClick={() => setOpen((v) => !v)}
    >
      <div className="tool-sequence-summary-head">
        <span className="tool-sequence-summary-text">{summary}</span>
        <span className="tool-chev">▸</span>
      </div>
      {open && (
        <div className="tool-sequence-summary-body" data-testid="tool-sequence-summary-body">
          {entries.map((entry) => (
            <Fragment key={entry.key}>{entry.render()}</Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Renders an ordered sequence of tool calls per 14-tool-call-sequence-
 * collapse's aggregation rule — used identically for a turn's top-level
 * tool-call sequence and for each subagent's own nested sequence inside its
 * `.subagent-wrap`:
 * - Exactly one call: render it as a normal standalone card, no wrapper.
 * - 2+ calls, last one still running: every call except the last collapses
 *   into one aggregate row; the last renders as its own separate, always-
 *   visible card after it.
 * - 2+ calls, last one finished: all calls (including what was the current
 *   one) collapse into that one aggregate row — nothing stands alone.
 */
export default function ToolCallSequence({ entries }: { entries: ToolCallSequenceEntry[] }): JSX.Element {
  if (entries.length === 1) {
    return entries[0].render()
  }

  const last = entries[entries.length - 1]
  const running = last.tool.status === 'running'
  const collapsed = running ? entries.slice(0, -1) : entries

  return (
    <>
      <SequenceSummaryRow entries={collapsed} />
      {running && last.render()}
    </>
  )
}
