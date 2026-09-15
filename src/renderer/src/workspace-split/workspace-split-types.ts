import type { SessionTab } from '../components/panels/TabBar'

/** Tabs that can live in a split pane (terminal uses a full-area overlay cache). */
export const WORKSPACE_SPLITTABLE_TABS: readonly SessionTab[] = ['chat', 'diff', 'files', 'terminal', 'ports']

export const WORKSPACE_TAB_LABELS: Record<SessionTab, string> = {
  chat: 'Chat',
  diff: 'Diff',
  files: 'Files',
  terminal: 'Terminal',
  ports: 'Ports'
}

export type WorkspaceSplitEdge = 'left' | 'right' | 'top' | 'bottom'

/** Row = side by side (left/right drop), col = stacked (top/bottom drop). */
export type WorkspaceSplitDirection = 'row' | 'col'

export interface WorkspaceSplitState {
  primaryTab: SessionTab
  secondaryTab: SessionTab
  splitRatio: number
  direction: WorkspaceSplitDirection
  fullscreenTab: SessionTab | null
}

export type WorkspaceTabVisibility =
  | 'hidden'
  | 'single'
  | 'split-primary'
  | 'split-secondary'
