/**
 * Chat changes cap payload — pending files (git-reconciled) + session-attributed commits.
 */

export interface SessionChangesCapFileItem {
  kind: 'file'
  path: string
  additions: number
  deletions: number
  /** When true, cap row opens Files (inline diff) instead of Diff › Changes. */
  opensInFilesTab: boolean
  /** ISO timestamp for newest-first ordering in the cap. */
  sortAt: string
}

export interface SessionChangesCapCommitItem {
  kind: 'commit'
  hash: string
  subject: string
  sortAt: string
}

export type SessionChangesCapItem = SessionChangesCapFileItem | SessionChangesCapCommitItem

export interface SessionChangesCap {
  items: SessionChangesCapItem[]
}

export function sessionChangesCapSignature(cap: SessionChangesCap): string {
  return cap.items
    .map((i) =>
      i.kind === 'file'
        ? `f:${i.path}:${i.additions}:${i.deletions}:${i.opensInFilesTab ? 1 : 0}:${i.sortAt}`
        : `c:${i.hash}:${i.subject}:${i.sortAt}`
    )
    .join('|')
}
