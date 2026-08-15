/**
 * Chat changes cap payload — pending files reconciled from git diff HEAD per touched path.
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

export type SessionChangesCapItem = SessionChangesCapFileItem

export interface SessionChangesCap {
  items: SessionChangesCapItem[]
}

export function sessionChangesCapSignature(cap: SessionChangesCap): string {
  return cap.items
    .map(
      (i) => `f:${i.path}:${i.additions}:${i.deletions}:${i.opensInFilesTab ? 1 : 0}:${i.sortAt}`
    )
    .join('|')
}
