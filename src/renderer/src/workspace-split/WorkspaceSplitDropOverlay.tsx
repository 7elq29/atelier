import type { SessionTab } from '../components/panels/TabBar'

export function WorkspaceSplitDropOverlay({
  onDrop
}: {
  onDrop: (edge: 'left' | 'right' | 'top' | 'bottom', tab: SessionTab) => void
}): JSX.Element {
  const handleDrop = (edge: 'left' | 'right' | 'top' | 'bottom') => (e: React.DragEvent) => {
    e.preventDefault()
    const tab = e.dataTransfer.getData('text/plain') as SessionTab
    if (!tab) return
    onDrop(edge, tab)
  }

  return (
    <div className="workspace-drop-overlay" data-testid="workspace-drop-overlay" aria-hidden="true">
      <div
        className="workspace-drop-zone workspace-drop-left"
        data-drop="left"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop('left')}
      />
      <div
        className="workspace-drop-zone workspace-drop-right"
        data-drop="right"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop('right')}
      />
      <div
        className="workspace-drop-zone workspace-drop-top"
        data-drop="top"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop('top')}
      />
      <div
        className="workspace-drop-zone workspace-drop-bottom"
        data-drop="bottom"
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop('bottom')}
      />
    </div>
  )
}
