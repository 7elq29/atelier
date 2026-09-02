import type { WorkspaceSplitEdge } from './workspace-split-types'

const EDGES: WorkspaceSplitEdge[] = ['left', 'right', 'top', 'bottom']

/**
 * Drop targets shown while a tab is being dragged. Purely presentational: the
 * drag gesture hit-tests these zones by geometry (see useWorkspaceTabDrag), so
 * they take no pointer events of their own and stay out of the way of the
 * panes underneath.
 */
export function WorkspaceSplitDropOverlay({
  activeEdge
}: {
  activeEdge: WorkspaceSplitEdge | null
}): JSX.Element {
  return (
    <div className="workspace-drop-overlay" data-testid="workspace-drop-overlay" aria-hidden="true">
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`workspace-drop-zone workspace-drop-${edge}${activeEdge === edge ? ' active' : ''}`}
          data-drop={edge}
          data-testid={`workspace-drop-zone-${edge}`}
        />
      ))}
    </div>
  )
}
