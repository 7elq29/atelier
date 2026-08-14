import { basename, isAbsolute, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { expandTildePath } from './project-path-autocomplete'

export function resolveSessionWorkspaceRoot(workspaceRoot: string): string {
  return resolve(expandTildePath(workspaceRoot, homedir()))
}

/** Normalize SDK plan paths (including home-dir `.claude/plans/*`) to a workspace-relative path. */
export function normalizePlanPathForWorkspace(
  raw: string | undefined,
  workspaceRoot: string
): string | null {
  if (!raw?.trim()) return null
  const root = resolveSessionWorkspaceRoot(workspaceRoot)
  let trimmed = raw.trim().replace(/\\/g, '/')
  const home = homedir().replace(/\\/g, '/')
  if (!trimmed.startsWith('/') && trimmed.startsWith(home.replace(/^\//, ''))) {
    trimmed = `/${trimmed}`
  }
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed.replace(/^\.\//, ''))
  if (abs !== root && !abs.startsWith(`${root}/`)) {
    const base = basename(trimmed)
    if (!base || base === '.' || base === '..') return null
    return `.claude/plans/${base}`
  }
  const rel = relative(root, abs).split(/\\/g).join('/')
  if (!rel || rel.startsWith('..')) return null
  return rel
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

/** Repo-relative path for a Claude Code plan file referenced by ExitPlanMode. */
export function resolveWorkspacePlanMirrorPath(
  workspaceRoot: string,
  planFilePath: string | undefined,
  planMarkdown: string,
  toolUseId: string
): string {
  if (planFilePath?.trim()) {
    const normalized = normalizePlanPathForWorkspace(planFilePath, workspaceRoot)
    if (normalized) return normalized
  }
  const slug = slugFromPlanTitle(planMarkdown)
  const fileName = slug ? `${slug}.md` : `plan-${toolUseId.slice(0, 8)}.md`
  return `.claude/plans/${fileName}`
}
