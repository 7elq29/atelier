import type { SessionTab } from '../../../shared/session-types'
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
  onClose,
  onToggleMaximize,
  maximized = false
}: {
  tab: SessionTab
  visibility: WorkspaceTabVisibility
  onClose: (tab: SessionTab) => void
  onToggleMaximize?: (tab: SessionTab) => void
  maximized?: boolean
}): JSX.Element | null {
  const splitVisible = visibility === 'split-primary' || visibility === 'split-secondary'
  if ((!splitVisible && !maximized) || tab === 'chat') return null
  const label = TAB_LABELS[tab] ?? tab
  return (
    <div className="workspace-pane-head" data-testid="workspace-tool-pane-actions">
      {onToggleMaximize ? (
        <button
          type="button"
          className="workspace-pane-enlarge"
          data-testid="workspace-split-pane-enlarge"
          data-tab={tab}
          title={maximized ? 'Restore split view' : `Enlarge ${label} pane`}
          aria-label={maximized ? 'Restore split view' : `Enlarge ${label} pane`}
          onClick={() => onToggleMaximize(tab)}
        >
          {maximized ? '◲' : '⛶'}
        </button>
      ) : null}
      <button
        type="button"
        className="workspace-pane-close workspace-split-pane-close"
        data-testid="workspace-split-pane-close"
        data-tab={tab}
        title={`Close ${label} pane`}
        aria-label={`Close ${label} pane`}
        onClick={() => onClose(tab)}
      >
        ✕
      </button>
    </div>
  )
}
