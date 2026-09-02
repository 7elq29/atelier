import type { SessionTab } from '../components/panels/TabBar'
import { WORKSPACE_TAB_LABELS } from './workspace-split-types'

/** Label that follows the cursor while a tab is dragged, per the mock. */
export function WorkspaceSplitDragGhost({
  tab,
  position
}: {
  tab: SessionTab | null
  position: { x: number; y: number } | null
}): JSX.Element | null {
  if (!tab || !position) return null
  return (
    <div
      className="workspace-drag-ghost"
      data-testid="workspace-drag-ghost"
      style={{ left: position.x, top: position.y }}
    >
      {WORKSPACE_TAB_LABELS[tab] ?? tab}
    </div>
  )
}
