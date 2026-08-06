/**
 * Shared types for the secondary panels (07-secondary-panels): Diff/Files/
 * Terminal/Ports. Kept dependency-free (no Electron/Node types) so both main
 * and renderer can import them, same convention as session-types.ts.
 */

export type DiffLineKind = 'context' | 'add' | 'del'

export interface DiffLine {
  kind: DiffLineKind
  oldLine: number | null
  newLine: number | null
  content: string
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

export type DiffFileStatus = 'added' | 'modified' | 'deleted' | 'renamed'

export interface DiffFileChange {
  path: string
  oldPath?: string
  status: DiffFileStatus
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

export interface DiffSummary {
  /** True when `projectPath` is not a git repo at all. */
  isRepo: boolean
  branch: string | null
  files: DiffFileChange[]
}

export interface CommitInfo {
  hash: string
  author: string
  date: string
  message: string
}

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
  /** True for the main worktree (the repo's primary checkout). */
  isMain: boolean
}

export interface FileTreeNode {
  name: string
  path: string
  relativePath: string
  type: 'file' | 'dir'
  children?: FileTreeNode[]
}

export type FileKind = 'text' | 'image' | 'html' | 'binary'

export interface FileReadResult {
  kind: FileKind
  /** Text content (kind === 'text' | 'html') or a data: URL (kind === 'image'). */
  content: string
  /** File extension, lowercase, without the dot — used for syntax highlighting. */
  extension: string
}

export type PortForwardStatus = 'connecting' | 'active' | 'error'

export interface PortForward {
  id: string
  sessionId: string
  localPort: number
  remoteHost: string
  remotePort: number
  status: PortForwardStatus
  error?: string
}

export type FileWriteResult = { ok: true } | { ok: false; error: string }

export interface PtySpawnOptions {
  id: string
  cwd: string
  hostname?: string | null
  cols: number
  rows: number
}
