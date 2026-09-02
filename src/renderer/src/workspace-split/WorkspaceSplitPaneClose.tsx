import type { SessionTab } from '../components/panels/TabBar'
import type { WorkspaceTabVisibility } from './workspace-split-types'

const TAB_LABELS: Record<string, string> = {
  chat: 'Chat',
  diff: 'Diff',
  files: 'Files',
  terminal: 'Terminal',
  ports: 'Ports'
}

/**
 * Closes one half of a split. Rendered per pane rather than once for the whole
 * split because the panes live in two different containers — Chat in
 * .session-workspace-tabs, Diff/Files in the keep-alive .panel-cache-layer.
 */
export function WorkspaceSplitPaneClose({
  tab,
  visibility,
  onClose
}: {
  tab: SessionTab
  visibility: WorkspaceTabVisibility
  onClose: (tab: SessionTab) => void
}): JSX.Element | null {
  if (visibility !== 'split-primary' && visibility !== 'split-secondary') return null
  const label = TAB_LABELS[tab] ?? tab
  return (
    <button
      type="button"
      className="workspace-split-pane-close"
      data-testid="workspace-split-pane-close"
      data-tab={tab}
      title={`Close ${label} pane`}
      aria-label={`Close ${label} pane`}
      onClick={() => onClose(tab)}
    >
      ✕
    </button>
  )
}
