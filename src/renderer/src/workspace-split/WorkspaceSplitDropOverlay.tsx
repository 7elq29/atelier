import { useState } from 'react'
import type { SessionTab } from '../components/panels/TabBar'

type Edge = 'left' | 'right' | 'top' | 'bottom'

const EDGES: Edge[] = ['left', 'right', 'top', 'bottom']

/**
 * Drop targets for splitting the workspace. The active zone is tracked in state
 * from dragenter/dragover rather than CSS :hover — during a native HTML5 drag
 * Chromium does not update :hover, so a hover-driven highlight never appears.
 */
export function WorkspaceSplitDropOverlay({
  onDrop
}: {
  onDrop: (edge: Edge, tab: SessionTab) => void
}): JSX.Element {
  const [activeEdge, setActiveEdge] = useState<Edge | null>(null)

  const handleDrop = (edge: Edge) => (e: React.DragEvent) => {
    e.preventDefault()
    setActiveEdge(null)
    const tab = e.dataTransfer.getData('text/plain') as SessionTab
    if (!tab) return
    onDrop(edge, tab)
  }

  return (
    <div className="workspace-drop-overlay" data-testid="workspace-drop-overlay" aria-hidden="true">
      {EDGES.map((edge) => (
        <div
          key={edge}
          className={`workspace-drop-zone workspace-drop-${edge}${activeEdge === edge ? ' active' : ''}`}
          data-drop={edge}
          data-testid={`workspace-drop-zone-${edge}`}
          onDragEnter={(e) => {
            e.preventDefault()
            setActiveEdge(edge)
          }}
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (activeEdge !== edge) setActiveEdge(edge)
          }}
          onDragLeave={() => setActiveEdge((cur) => (cur === edge ? null : cur))}
          onDrop={handleDrop(edge)}
        />
      ))}
    </div>
  )
}
