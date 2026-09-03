import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, dirname } from 'node:path'
import { isClaudePlanPath } from '../../shared/claude-plan-path'
import { expandTildePath } from '../../shared/project-path-autocomplete'
import { isCapPathOutsideWorkspace } from '../../shared/session-touched-path'
import { resolveSessionWorkspaceRoot } from '../../shared/plan-mirror-path'
import { resolveActualGitRepoRootCached } from '../panels/git-core'

export { resolveSessionWorkspaceRoot } from '../../shared/plan-mirror-path'

/** Normalize `/private/var` ↔ `/var` so repo-root-relative checks work on macOS. */
function normalizeComparablePath(p: string): string {
  const resolved = resolve(p)
  if (resolved.startsWith('/private/')) {
    return resolved.slice('/private'.length)
  }
  return resolved
}

/** Repo-root-relative path when `absPath` is inside the git checkout; null otherwise. */
export function gitRelativeFromRepoRoot(repoRoot: string, absPath: string): string | null {
  const rel = relative(normalizeComparablePath(repoRoot), normalizeComparablePath(absPath))
    .split(/\\/g)
    .join('/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}

/** Git repo + paths for a cap item — resolves from the file location, not only session cwd (e.g. `~`). */
export async function resolveCapGitContext(
  capPath: string,
  workspacePath: string,
  hostname: string | null
): Promise<{ repoRoot: string; gitRelative: string; absPath: string } | null> {
  if (isClaudePlanPath(capPath) || isCapPathOutsideWorkspace(capPath, workspacePath)) return null

  const normalizedCap = capPath.replace(/\\/g, '/')
  const expandedWs = resolveSessionWorkspaceRoot(workspacePath)
  const absCandidates: string[] = []

  if (isAbsolute(normalizedCap) || normalizedCap.startsWith('~')) {
    absCandidates.push(resolveSessionTouchedAbsolutePath(normalizedCap, workspacePath))
  } else {
    absCandidates.push(resolveSessionTouchedAbsolutePath(normalizedCap, workspacePath))
    const repoFromWs = await resolveActualGitRepoRootCached(expandedWs, hostname)
    if (repoFromWs) {
      absCandidates.push(resolve(normalizeComparablePath(repoFromWs), normalizedCap))
    }
  }

  const seen = new Set<string>()
  for (const abs of absCandidates) {
    const key = normalizeComparablePath(abs)
    if (seen.has(key)) continue
    seen.add(key)
    // Git needs a directory cwd — `rev-parse` fails when cwd is a file path.
    const repoRootRaw = await resolveActualGitRepoRootCached(dirname(abs), hostname)
    if (!repoRootRaw) continue
    const gitRelative = gitRelativeFromRepoRoot(repoRootRaw, abs)
    if (gitRelative) {
      return { repoRoot: repoRootRaw, gitRelative, absPath: abs }
    }
  }
  return null
}

export function resolveSessionTouchedAbsolutePath(
  capPath: string,
  workspaceRoot: string,
  homeDir: string = homedir()
): string {
  const root = resolveSessionWorkspaceRoot(workspaceRoot)
  const trimmed = capPath.trim().replace(/\\/g, '/')
  if (isAbsolute(trimmed)) return resolve(trimmed)
  if (trimmed.startsWith('~')) return resolve(expandTildePath(trimmed, homeDir))
  return resolve(root, trimmed.replace(/^\.\//, ''))
}

/** Resolve SDK `file_path` to an absolute path (project root first when it differs from cwd). */
export function resolveToolFileAbsolutePath(
  filePath: string,
  workspaceRoot: string,
  projectRoot?: string,
  homeDir: string = homedir()
): string | null {
  const trimmed = filePath.trim().replace(/\\/g, '/')
  if (!trimmed) return null

  if (trimmed.startsWith('~')) {
    return resolve(expandTildePath(trimmed, homeDir))
  }
  if (isAbsolute(trimmed)) {
    return resolve(trimmed)
  }

  const rel = trimmed.replace(/^\.\//, '')
  const ws = resolveSessionWorkspaceRoot(workspaceRoot)
  const roots =
    projectRoot && resolveSessionWorkspaceRoot(projectRoot) !== ws
      ? [resolveSessionWorkspaceRoot(projectRoot), ws]
      : [ws]
  return resolve(roots[0]!, rel)
}

/** Canonical cap storage: git-repo-relative when inside repo, absolute when outside. */
export async function normalizeCapStoragePath(
  filePath: string,
  workspacePath: string,
  hostname: string | null,
  projectPath?: string
): Promise<string | null> {
  const abs = resolveToolFileAbsolutePath(filePath, workspacePath, projectPath)
  if (!abs) return null

  const ctx =
    (await resolveCapGitContext(filePath, workspacePath, hostname)) ??
    (await resolveCapGitContext(abs.split(/\\/g).join('/'), workspacePath, hostname))
  if (ctx) return ctx.gitRelative

  return abs.split(/\\/g).join('/')
}

/** Resolve a stored cap path (git-relative, workspace-relative legacy, or absolute) to absolute for file IO. */
export async function resolveCapPathAbsolute(
  capPath: string,
  workspacePath: string,
  hostname: string | null
): Promise<string> {
  if (isClaudePlanPath(capPath) || isCapPathOutsideWorkspace(capPath, workspacePath)) {
    return resolveSessionTouchedAbsolutePath(capPath, workspacePath)
  }

  const ctx = await resolveCapGitContext(capPath, workspacePath, hostname)
  if (ctx) return ctx.absPath
  return resolveSessionTouchedAbsolutePath(capPath, workspacePath)
}

/** @deprecated Prefer normalizeCapStoragePath — workspace-relative legacy helper. */
export function normalizeToRepoRelativePath(filePath: string, workspaceRoot: string): string | null {
  const homeDir = homedir()
  const root = resolveSessionWorkspaceRoot(workspaceRoot)
  const trimmed = filePath.trim().replace(/\\/g, '/')
  if (!trimmed) return null

  let abs: string
  if (trimmed.startsWith('~')) {
    abs = resolve(expandTildePath(trimmed, homeDir))
  } else if (isAbsolute(trimmed)) {
    abs = resolve(trimmed)
  } else {
    abs = resolve(root, trimmed.replace(/^\.\//, ''))
  }

  if (abs === root || abs.startsWith(`${root}/`)) {
    const rel = relative(root, abs).split(/\\/g).join('/')
    if (!rel || rel.startsWith('..')) return null
    return rel
  }

  return abs.split(/\\/g).join('/')
}
