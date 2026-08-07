import { isAbsolute, relative, resolve } from 'node:path'

export function normalizeToRepoRelativePath(filePath: string, workspaceRoot: string): string | null {
  const root = resolve(workspaceRoot)
  const normalized = filePath.replace(/\\/g, '/')

  if (!isAbsolute(normalized)) {
    const rel = normalized.replace(/^\.\//, '')
    const abs = resolve(root, rel)
    const fromRoot = relative(root, abs)
    if (fromRoot.startsWith('..') || fromRoot === '') return null
    return fromRoot.split(/\\/g).join('/')
  }

  const abs = resolve(normalized)
  if (abs === root || abs.startsWith(root + '/')) {
    return relative(root, abs).split(/\\/g).join('/')
  }

  const stripLead = normalized.replace(/^\//, '')
  if (stripLead && !stripLead.includes('..')) {
    const underRoot = resolve(root, stripLead)
    if (underRoot === root || underRoot.startsWith(root + '/')) {
      return relative(root, underRoot).split(/\\/g).join('/')
    }
  }

  return null
}
