/** Group plan-review diff lines into markdown blocks for correct rendering. */

import { computePlanReviewDiff, splitPlanLines, type PlanReviewDiffLine, type PlanReviewDiffLineKind } from './plan-review-diff'

export interface PlanReviewDisplayLine {
  kind: PlanReviewDiffLineKind
  content: string
  /** Source line number shown in the gutter and referenced in composer notes. */
  sourceLineNumber: number
  gutter: string
  key: string
}

export interface PlanReviewRenderBlock {
  key: string
  lines: PlanReviewDisplayLine[]
  content: string
  kind: PlanReviewDiffLineKind | 'mixed'
}

const TABLE_ROW = /^\|.+\|$/
const TABLE_SEP = /^\|[\s:|\-]+\|$/
const FENCE = /^(`{3,}|~{3,})/
const LIST_ITEM = /^(\s*)([-*+]|(\d+\.))\s+(\[[ xX]\]\s*)?\S/
const HEADING = /^#{1,6}\s/
const BLOCKQUOTE = /^>\s?/

function isBlank(line: string): boolean {
  return line.trim() === ''
}

function isTableLine(line: string): boolean {
  const trimmed = line.trim()
  return TABLE_ROW.test(trimmed) || TABLE_SEP.test(trimmed)
}

export function isTableSeparatorLine(line: string): boolean {
  return TABLE_SEP.test(line.trim())
}

function isListLine(line: string): boolean {
  return LIST_ITEM.test(line)
}

function isHeadingLine(line: string): boolean {
  return HEADING.test(line.trim())
}

function isBlockquoteLine(line: string): boolean {
  return BLOCKQUOTE.test(line)
}

function isFenceLine(line: string): boolean {
  return FENCE.test(line.trim())
}

function isParagraphContinuation(line: string): boolean {
  if (isBlank(line)) return false
  if (isTableLine(line) || isListLine(line) || isHeadingLine(line) || isBlockquoteLine(line) || isFenceLine(line)) {
    return false
  }
  return /^\s+\S/.test(line)
}

function blockKindFromLines(lines: PlanReviewDisplayLine[]): PlanReviewRenderBlock['kind'] {
  const kinds = new Set(lines.map((line) => line.kind))
  if (kinds.size === 1) return lines[0]!.kind
  if (kinds.has('add') && kinds.has('del')) return 'mixed'
  if (kinds.has('add')) return 'add'
  if (kinds.has('del')) return 'del'
  return 'ctx'
}

function sliceSourceContent(sourceContent: string, lines: PlanReviewDisplayLine[]): string {
  const allLines = splitPlanLines(sourceContent)
  const nums = lines.map((line) => line.sourceLineNumber)
  const start = Math.min(...nums) - 1
  const end = Math.max(...nums) - 1
  return allLines.slice(start, end + 1).join('\n')
}

function makeBlock(lines: PlanReviewDisplayLine[], sourceContent?: string): PlanReviewRenderBlock {
  const content =
    sourceContent && lines.every((line) => line.kind !== 'del')
      ? sliceSourceContent(sourceContent, lines)
      : lines.map((line) => line.content).join('\n')
  return {
    key: lines.map((line) => line.key).join('|'),
    lines,
    content,
    kind: blockKindFromLines(lines)
  }
}

/** Merge consecutive diff lines into markdown blocks (tables, lists, code fences, etc.). */
export function groupPlanReviewRenderBlocks(
  lines: PlanReviewDisplayLine[],
  sourceContent?: string
): PlanReviewRenderBlock[] {
  const blocks: PlanReviewRenderBlock[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]!

    if (isFenceLine(line.content)) {
      const group = [line]
      index++
      while (index < lines.length && !isFenceLine(lines[index]!.content)) {
        group.push(lines[index]!)
        index++
      }
      if (index < lines.length) {
        group.push(lines[index]!)
        index++
      }
      blocks.push(makeBlock(group, sourceContent))
      continue
    }

    if (isTableLine(line.content)) {
      const group = [line]
      index++
      while (index < lines.length && isTableLine(lines[index]!.content)) {
        group.push(lines[index]!)
        index++
      }
      blocks.push(makeBlock(group, sourceContent))
      continue
    }

    if (isListLine(line.content)) {
      blocks.push(makeBlock([line], sourceContent))
      index++
      continue
    }

    if (isBlockquoteLine(line.content)) {
      const group = [line]
      index++
      while (index < lines.length && isBlockquoteLine(lines[index]!.content)) {
        group.push(lines[index]!)
        index++
      }
      blocks.push(makeBlock(group, sourceContent))
      continue
    }

    if (isHeadingLine(line.content)) {
      blocks.push(makeBlock([line], sourceContent))
      index++
      continue
    }

    const group = [line]
    index++
    while (index < lines.length) {
      const next = lines[index]!
      if (
        isFenceLine(next.content) ||
        isTableLine(next.content) ||
        isListLine(next.content) ||
        isBlockquoteLine(next.content) ||
        isHeadingLine(next.content)
      ) {
        break
      }
      group.push(next)
      index++
    }
    blocks.push(makeBlock(group, sourceContent))
  }

  return blocks
}

export function buildPlanReviewDisplayLines(content: string, previousContent?: string): PlanReviewDisplayLine[] {
  const diffLines: PlanReviewDiffLine[] =
    previousContent != null && previousContent !== ''
      ? computePlanReviewDiff(previousContent, content)
      : splitPlanLines(content).map((lineContent, index) => ({
          kind: 'ctx' as const,
          content: lineContent,
          oldLine: index + 1,
          newLine: index + 1
        }))

  return diffLines
    .filter((line) => line.content.trim() !== '' || line.kind !== 'ctx')
    .map((line, index) => {
      const sourceLineNumber =
        line.kind === 'del'
          ? (line.oldLine ?? index + 1)
          : (line.newLine ?? line.oldLine ?? index + 1)
      return {
        kind: line.kind,
        content: line.content,
        sourceLineNumber,
        gutter: String(sourceLineNumber),
        key: `${line.kind}-${sourceLineNumber}-${index}`
      }
    })
}

export function buildPlanReviewRenderBlocks(content: string, previousContent?: string): PlanReviewRenderBlock[] {
  const displayLines = buildPlanReviewDisplayLines(content, previousContent)
  if (displayLines.length === 0) return []
  return groupPlanReviewRenderBlocks(displayLines, content)
}

/** Source file review — one block per diff line, no markdown grouping/heuristics. */
export function buildFileReviewRenderBlocks(content: string, previousContent?: string): PlanReviewRenderBlock[] {
  return buildPlanReviewDisplayLines(content, previousContent).map((line) => ({
    key: line.key,
    lines: [line],
    content: line.content,
    kind: line.kind
  }))
}

export function planReviewCommentKey(line: PlanReviewDisplayLine): string {
  return line.key
}

export function planReviewComposerLineNumber(line: PlanReviewDisplayLine): number {
  return line.sourceLineNumber
}

/** @deprecated use buildPlanReviewDisplayLines */
export function planReviewDiffToDisplayLines(diffLines: PlanReviewDiffLine[]): PlanReviewDisplayLine[] {
  return diffLines
    .filter((line) => line.content.trim() !== '' || line.kind !== 'ctx')
    .map((line, index) => {
      const sourceLineNumber =
        line.kind === 'del'
          ? (line.oldLine ?? index + 1)
          : (line.newLine ?? line.oldLine ?? index + 1)
      return {
        kind: line.kind,
        content: line.content,
        sourceLineNumber,
        gutter: String(sourceLineNumber),
        key: `${line.kind}-${sourceLineNumber}-${index}`
      }
    })
}
