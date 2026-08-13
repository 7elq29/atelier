/** Line-level diff for plan review pane (current plan vs previous edition). */

export type PlanReviewDiffLineKind = 'add' | 'del' | 'ctx'

export interface PlanReviewDiffLine {
  kind: PlanReviewDiffLineKind
  content: string
  /** Shown in the gutter; null when not applicable for this kind. */
  oldLine: number | null
  newLine: number | null
}

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

export function splitPlanLines(text: string): string[] {
  return splitLines(text)
}

/** Classic LCS backtracking diff on whole lines (trimEnd for stable comparison). */
export function computePlanReviewDiff(previousText: string, currentText: string): PlanReviewDiffLine[] {
  const oldLines = splitLines(previousText).map((line) => line.trimEnd())
  const newLines = splitLines(currentText).map((line) => line.trimEnd())
  const m = oldLines.length
  const n = newLines.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array<number>(n + 1).fill(0))

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
      }
    }
  }

  const raw: PlanReviewDiffLine[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      raw.push({ kind: 'ctx', content: oldLines[i - 1], oldLine: i, newLine: j })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      raw.push({ kind: 'add', content: newLines[j - 1], oldLine: null, newLine: j })
      j--
    } else {
      raw.push({ kind: 'del', content: oldLines[i - 1], oldLine: i, newLine: null })
      i--
    }
  }

  raw.reverse()

  return raw
}

/** Plain read-only lines when there is no previous edition to diff against. */
export function planReviewPlainLines(text: string): PlanReviewDiffLine[] {
  return splitPlanLines(text)
    .map((content, index) => ({
      kind: 'ctx' as const,
      content,
      oldLine: index + 1,
      newLine: index + 1
    }))
    .filter((line) => line.content.trim() !== '')
}
