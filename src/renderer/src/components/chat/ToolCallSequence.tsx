import { Fragment, useState } from 'react'
import type { ThinkingBlockContent, ToolCallContent } from '../../../../shared/chat-content'
import { toolBadgeClass } from './ToolCallCard'
import ThinkingBlockInline from './ThinkingBlockInline'

/**
 * One entry in a tool/thinking sequence (14-tool-call-sequence-collapse): the
 * `tool` or `thinking` content drives grouping/status decisions, `render`
 * produces whatever this entry's *own* full markup was before this feature
 * existed — kept as a callback so `ToolCallSequence` doesn't need to know
 * whether an entry is a top-level call or a subagent-nested child, just when
 * to call it.
 */
export interface ToolCallSequenceEntry {
  key: string
  tool?: ToolCallContent
  thinking?: ThinkingBlockContent
  render: () => JSX.Element
}

/** Resolved interactive prompt folded into the same summary row as tool activity. */
export type SidecarSequenceEntry = {
  key: string
  foldSummary: string
  render: () => JSX.Element
}

const BUCKET_PHRASE: Record<string, (count: number) => string> = {
  thinking: (n) => `extended reasoning ${n} time${n === 1 ? '' : 's'}`,
  read: (n) => `read ${n} file${n === 1 ? '' : 's'}`,
  bash: (n) => `ran ${n} shell command${n === 1 ? '' : 's'}`,
  edit: (n) => `edited ${n} file${n === 1 ? '' : 's'}`,
  task: (n) => `ran ${n} subagent${n === 1 ? '' : 's'}`,
  grep: (n) => `searched ${n} time${n === 1 ? '' : 's'}`,
  web: (n) => `searched the web ${n} time${n === 1 ? '' : 's'}`,
  todo: (n) => `updated the todo list ${n} time${n === 1 ? '' : 's'}`,
  other: (n) => `ran ${n} other action${n === 1 ? '' : 's'}`
}

function entryRunning(entry: ToolCallSequenceEntry): boolean {
  if (entry.thinking) return entry.thinking.status === 'running'
  if (entry.tool) return entry.tool.status === 'running'
  return false
}

function renderRunningEntry(entry: ToolCallSequenceEntry): JSX.Element {
  if (entry.thinking?.status === 'running') {
    return <ThinkingBlockInline content={entry.thinking} />
  }
  return entry.render()
}

/**
 * Aggregate summary text, e.g. "Extended reasoning 2 times, read 2 files"
 * (14-tool-call-sequence-collapse). Groups tool calls by the same
 * `toolBadgeClass` buckets `ToolCallCard` uses; thinking blocks get their
 * own bucket. Order follows first appearance; only the first character is
 * capitalized.
 */
export function buildSequenceSummary(entries: ToolCallSequenceEntry[]): string {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const bucket = entry.thinking ? 'thinking' : toolBadgeClass(entry.tool!.name)
    if (!counts.has(bucket)) order.push(bucket)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const phrase = order.map((bucket) => BUCKET_PHRASE[bucket](counts.get(bucket) ?? 0)).join(', ')
  return phrase.length > 0 ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : ''
}

function appendSummaryPhrase(parts: string[], phrase: string): void {
  const trimmed = phrase.trim()
  if (!trimmed) return
  parts.push(trimmed.charAt(0).toLowerCase() + trimmed.slice(1))
}

/** Tool/thinking summary plus resolved interactive sidecars in one comma-separated line. */
export function buildCombinedSequenceSummary(
  entries: ToolCallSequenceEntry[],
  sidecars: SidecarSequenceEntry[]
): string {
  const parts: string[] = []
  const toolSummary = buildSequenceSummary(entries)
  if (toolSummary) parts.push(toolSummary)
  for (const sidecar of sidecars) appendSummaryPhrase(parts, sidecar.foldSummary)
  const joined = parts.join(', ')
  return joined.length > 0 ? joined.charAt(0).toUpperCase() + joined.slice(1) : ''
}

/** The one clickable expandable text row that finished calls collapse into. */
function SequenceSummaryRow({
  entries,
  sidecars
}: {
  entries: ToolCallSequenceEntry[]
  sidecars: SidecarSequenceEntry[]
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const summary = buildCombinedSequenceSummary(entries, sidecars)

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
          {sidecars.map((sidecar) => (
            <Fragment key={sidecar.key}>{sidecar.render()}</Fragment>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Renders an ordered sequence of tool/thinking activity per 14-tool-call-
 * sequence-collapse's aggregation rule — used for a turn's top-level
 * sequence and for each subagent's own nested sequence inside its
 * `.subagent-wrap`:
 * - Finished steps (including a lone step) collapse into one aggregate row.
 * - A running tool call renders as its own card after any collapsed prefix.
 * - A running thinking block renders as inline blinking text, not a card.
 * Resolved interactive sidecars in the same run merge into the summary line.
 */
export default function ToolCallSequence({
  entries,
  sidecars = []
}: {
  entries: ToolCallSequenceEntry[]
  sidecars?: SidecarSequenceEntry[]
}): JSX.Element {
  const mergedSidecars = sidecars.filter((s) => s.foldSummary.trim())

  if (entries.length === 0) {
    if (mergedSidecars.length === 0) return <></>
    return <SequenceSummaryRow entries={[]} sidecars={mergedSidecars} />
  }

  const last = entries[entries.length - 1]
  const running = entryRunning(last)
  const collapsed = running ? entries.slice(0, -1) : entries
  const hasCollapsed = collapsed.length > 0 || mergedSidecars.length > 0

  if (!running) {
    return <SequenceSummaryRow entries={entries} sidecars={mergedSidecars} />
  }

  if (!hasCollapsed) {
    return renderRunningEntry(last)
  }

  return (
    <>
      <SequenceSummaryRow entries={collapsed} sidecars={mergedSidecars} />
      {renderRunningEntry(last)}
    </>
  )
}
