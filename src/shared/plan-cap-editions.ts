import { parseStructuredContent } from './chat-content'
import { countPlanReviewDiffStats } from './plan-review-diff'

export interface PlanCapEdition {
  current: string
  previous?: string
}

function normalizeCapPath(capPath: string): string {
  return capPath.replace(/\\/g, '/').replace(/^\.\//, '')
}

function slugFromPlanTitle(plan: string): string | null {
  const title =
    plan.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? plan.match(/^Plan:\s*(.+)$/im)?.[1]?.trim()
  if (!title) return null
  const slug = title
    .toLowerCase()
    .replace(/[^\w]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || null
}

/** Candidate repo-relative paths for a plan_proposed message (matches main-process mirror rules). */
export function planMirrorPathCandidates(
  planFilePath: string | undefined,
  planMarkdown: string,
  toolUseId: string
): string[] {
  const out = new Set<string>()
  if (planFilePath?.trim()) {
    const raw = normalizeCapPath(planFilePath.trim())
    out.add(raw)
    const base = raw.split('/').filter(Boolean).pop()
    if (base?.endsWith('.md')) out.add(`.claude/plans/${base}`)
  }
  const slug = slugFromPlanTitle(planMarkdown)
  out.add(`.claude/plans/${slug ? `${slug}.md` : `plan-${toolUseId.slice(0, 8)}.md`}`)
  return [...out]
}

function planCapPathSuffix(capPath: string): string | null {
  const normalized = normalizeCapPath(capPath)
  const idx = normalized.indexOf('.claude/plans/')
  return idx >= 0 ? normalized.slice(idx) : null
}

function capPathMatchesPlanTarget(capPath: string, targetPath: string): boolean {
  const left = normalizeCapPath(capPath)
  const right = normalizeCapPath(targetPath)
  if (left === right) return true
  const leftSuffix = planCapPathSuffix(left)
  const rightSuffix = planCapPathSuffix(right)
  return leftSuffix !== null && leftSuffix === rightSuffix
}

/** Latest plan markdown for `capPath`, plus the prior edition when one exists in the transcript. */
export function findPlanCapEdition(
  messages: { role: string; content: string }[],
  capPath: string
): PlanCapEdition | null {
  const editions: string[] = []

  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const structured = parseStructuredContent(message.content)
    if (structured?.kind !== 'plan_proposed') continue
    const plan = structured.plan
    if (!plan?.trim()) continue

    const candidates = planMirrorPathCandidates(
      structured.planFilePath,
      plan,
      structured.toolUseId || 'plan'
    )
    if (!candidates.some((candidate) => capPathMatchesPlanTarget(capPath, candidate))) continue
    editions.push(plan)
  }

  if (editions.length === 0) return null
  const current = editions[editions.length - 1]!
  const previous = editions.length >= 2 ? editions[editions.length - 2] : undefined
  return { current, previous }
}

/** Session changes cap +/- for plan rows — same line diff as Plan review (latest vs previous edition). */
export function planCapReviewDiffStats(
  messages: { role: string; content: string }[],
  capPath: string
): { additions: number; deletions: number } | null {
  const edition = findPlanCapEdition(messages, capPath)
  if (!edition) return null
  return countPlanReviewDiffStats(edition.previous ?? '', edition.current)
}
