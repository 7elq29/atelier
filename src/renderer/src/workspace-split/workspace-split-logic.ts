import type { SessionTab } from '../../../shared/session-types'
import type {
  WorkspaceSplitDirection,
  WorkspaceSplitState,
  WorkspaceTabVisibility
} from './workspace-split-types'
import { WORKSPACE_SPLITTABLE_TABS } from './workspace-split-types'

export function isWorkspaceSplittableTab(tab: SessionTab): boolean {
  return (WORKSPACE_SPLITTABLE_TABS as readonly string[]).includes(tab)
}

export function stripActiveTab(activeTab: SessionTab, split: WorkspaceSplitState | null): SessionTab {
  if (!split) return activeTab
  return split.fullscreenTab ?? split.primaryTab
}

export function isTabHiddenFromStrip(tab: SessionTab, split: WorkspaceSplitState | null): boolean {
  if (!split) return false
  return tab === split.secondaryTab
}

export function resolveTabVisibility(
  tab: SessionTab,
  activeTab: SessionTab,
  split: WorkspaceSplitState | null
): WorkspaceTabVisibility {
  if (!split) {
    return activeTab === tab ? 'single' : 'hidden'
  }
  if (split.fullscreenTab) {
    return split.fullscreenTab === tab ? 'single' : 'hidden'
  }
  if (tab === split.primaryTab) return 'split-primary'
  if (tab === split.secondaryTab) return 'split-secondary'
  return 'hidden'
}

export function isSplitLayoutVisible(split: WorkspaceSplitState | null): boolean {
  return Boolean(split && !split.fullscreenTab)
}

export function isChatTabVisible(activeTab: SessionTab, split: WorkspaceSplitState | null): boolean {
  return resolveTabVisibility('chat', activeTab, split) !== 'hidden'
}

export function isTerminalTabVisible(activeTab: SessionTab, split: WorkspaceSplitState | null): boolean {
  return resolveTabVisibility('terminal', activeTab, split) !== 'hidden'
}

export function applyStripTabSelect(
  tab: SessionTab,
  split: WorkspaceSplitState | null
): { split: WorkspaceSplitState | null; restoreSplit: boolean } {
  if (!split) {
    return { split: null, restoreSplit: false }
  }
  const splitTabs = new Set<SessionTab>([split.primaryTab, split.secondaryTab])
  if (split.fullscreenTab) {
    if (splitTabs.has(tab)) {
      return { split: { ...split, fullscreenTab: null }, restoreSplit: true }
    }
    return { split: { ...split, fullscreenTab: tab }, restoreSplit: false }
  }
  if (tab === split.primaryTab) {
    return { split, restoreSplit: false }
  }
  if (splitTabs.has(tab)) {
    return { split, restoreSplit: false }
  }
  return { split: { ...split, fullscreenTab: tab }, restoreSplit: false }
}

export function createSplit(
  primaryTab: SessionTab,
  secondaryTab: SessionTab,
  splitRatio = 0.5,
  direction: WorkspaceSplitDirection = 'row'
): WorkspaceSplitState | null {
  if (primaryTab === secondaryTab) return null
  if (!isWorkspaceSplittableTab(primaryTab) || !isWorkspaceSplittableTab(secondaryTab)) return null
  return { primaryTab, secondaryTab, splitRatio, direction, fullscreenTab: null }
}

/** left/right split side by side; top/bottom stack, matching the mock's pane tree. */
export function splitDirectionForEdge(edge: 'left' | 'right' | 'top' | 'bottom'): WorkspaceSplitDirection {
  return edge === 'left' || edge === 'right' ? 'row' : 'col'
}

export function tabContentClass(visibility: WorkspaceTabVisibility): string {
  switch (visibility) {
    case 'hidden':
      return 'tab-content hidden'
    case 'single':
      return 'tab-content'
    case 'split-primary':
      return 'tab-content workspace-split-pane workspace-split-pane--primary'
    case 'split-secondary':
      return 'tab-content workspace-split-pane workspace-split-pane--secondary'
  }
}
