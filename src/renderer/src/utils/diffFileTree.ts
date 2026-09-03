import type { DiffFileChange } from '../../../shared/panel-types'

export interface DiffTreeFileNode {
  kind: 'file'
  /** Repo-relative path — the Diff panel's selection key. */
  path: string
  /** Basename, i.e. what the row shows. */
  label: string
  file: DiffFileChange
}

export interface DiffTreeDirNode {
  kind: 'dir'
  /** Repo-relative path of the *deepest* directory of a compressed chain. */
  path: string
  /** `a/b/c` when `a` and `b` each hold nothing but the next directory. */
  label: string
  children: DiffTreeNode[]
}

export type DiffTreeNode = DiffTreeDirNode | DiffTreeFileNode

interface PendingDir {
  dirs: Map<string, PendingDir>
  files: DiffFileChange[]
}

function pendingDir(): PendingDir {
  return { dirs: new Map(), files: [] }
}

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

/**
 * Groups changed files by directory so the 240px `.file-tree` rail can show
 * basenames instead of ellipsized full paths. Single-child directory chains
 * collapse into one row, like GitHub's Files-changed tree.
 */
export function buildDiffFileTree(files: DiffFileChange[]): DiffTreeNode[] {
  const root = pendingDir()
  for (const file of files) {
    const segments = file.path.split('/').filter((s) => s.length > 0)
    const name = segments.pop()
    if (name === undefined) continue
    let dir = root
    for (const segment of segments) {
      let child = dir.dirs.get(segment)
      if (!child) {
        child = pendingDir()
        dir.dirs.set(segment, child)
      }
      dir = child
    }
    dir.files.push(file)
  }
  return childNodes(root, '')
}

function childNodes(dir: PendingDir, path: string): DiffTreeNode[] {
  const dirs = [...dir.dirs.entries()]
    .map(([name, child]) => compressChain(name, child, path ? `${path}/${name}` : name))
    .sort((a, b) => a.label.localeCompare(b.label))
  const files: DiffTreeFileNode[] = dir.files
    .map((file) => ({ kind: 'file' as const, path: file.path, label: basename(file.path), file }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return [...dirs, ...files]
}

/** Folds `a` → `a/b` → `a/b/c` into a single `a/b/c` row while nothing branches. */
function compressChain(name: string, dir: PendingDir, path: string): DiffTreeDirNode {
  let label = name
  let deepestPath = path
  let deepest = dir
  while (deepest.files.length === 0 && deepest.dirs.size === 1) {
    const [childName, child] = [...deepest.dirs.entries()][0]!
    label = `${label}/${childName}`
    deepestPath = `${deepestPath}/${childName}`
    deepest = child
  }
  return { kind: 'dir', path: deepestPath, label, children: childNodes(deepest, deepestPath) }
}
