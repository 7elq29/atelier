import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { expandTildePath } from '../../shared/project-path-autocomplete'

export function resolveSessionTouchedAbsolutePath(
  capPath: string,
  workspaceRoot: string,
  homeDir: string = homedir()
): string {
  const root = resolve(expandTildePath(workspaceRoot, homeDir))
  const trimmed = capPath.trim().replace(/\\/g, '/')
  if (isAbsolute(trimmed)) return resolve(trimmed)
  if (trimmed.startsWith('~')) return resolve(expandTildePath(trimmed, homeDir))
  return resolve(root, trimmed.replace(/^\.\//, ''))
}

/** Repo-relative when under workspace; absolute normalized path when outside. */
export function normalizeToRepoRelativePath(filePath: string, workspaceRoot: string): string | null {
  const homeDir = homedir()
  const root = resolve(expandTildePath(workspaceRoot, homeDir))
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
