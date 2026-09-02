import { useCallback, useRef, useState } from 'react'
import type { SessionTab } from '../components/panels/TabBar'
import type { WorkspaceSplitEdge } from './workspace-split-types'

/**
 * How far the pointer must travel before a tab press turns into a drag.
 * Chromium's native HTML5 drag triggers after about four pixels, which made
 * ordinary clicks register as drags; this is deliberately well above that.
 */
export const WORKSPACE_TAB_DRAG_THRESHOLD_PX = 12

/** Nearest drop edge under the pointer, or null when it is outside every zone. */
function edgeAtPoint(x: number, y: number): WorkspaceSplitEdge | null {
  const zones = document.querySelectorAll<HTMLElement>('.workspace-drop-zone[data-drop]')
  let nearest: { edge: WorkspaceSplitEdge; distance: number } | null = null
  for (const zone of zones) {
    const edge = zone.dataset.drop as WorkspaceSplitEdge | undefined
    if (!edge) continue
    const r = zone.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
    // Each zone's outer boundary is the workspace boundary, so distance to it is
    // how close the pointer is to that edge. Corners overlap two zones; the
    // closer edge wins.
    const distance =
      edge === 'left' ? x - r.left : edge === 'right' ? r.right - x : edge === 'top' ? y - r.top : r.bottom - y
    if (!nearest || distance < nearest.distance) nearest = { edge, distance }
  }
  return nearest?.edge ?? null
}

export interface WorkspaceTabDrag {
  /** Tab being dragged, once the threshold has been crossed. */
  dragTab: SessionTab | null
  activeEdge: WorkspaceSplitEdge | null
  ghost: { x: number; y: number } | null
  /** Call on mousedown over a tab to start watching for a drag. */
  trackTabPress: (tab: SessionTab, e: React.MouseEvent) => void
  /** Whether the gesture that just finished was a drag, so its click can be ignored. */
  didDrag: () => boolean
}

/**
 * Drag-to-split gesture for workspace tabs, driven by mouse events rather than
 * native HTML5 drag-and-drop. Native DnD gives no control over the threshold,
 * suppresses the click once it engages, and does not update :hover while a drag
 * is in flight — so the drop zones could never highlight from CSS alone.
 */
export function useWorkspaceTabDrag(
  onDrop: (edge: WorkspaceSplitEdge, tab: SessionTab) => void
): WorkspaceTabDrag {
  const [dragTab, setDragTab] = useState<SessionTab | null>(null)
  const [activeEdge, setActiveEdge] = useState<WorkspaceSplitEdge | null>(null)
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)
  const draggedRef = useRef(false)

  const trackTabPress = useCallback(
    (tab: SessionTab, e: React.MouseEvent) => {
      if (e.button !== 0) return
      const startX = e.clientX
      const startY = e.clientY
      draggedRef.current = false
      let engaged = false

      const onMove = (ev: MouseEvent): void => {
        if (!engaged) {
          const dx = ev.clientX - startX
          const dy = ev.clientY - startY
          if (Math.hypot(dx, dy) < WORKSPACE_TAB_DRAG_THRESHOLD_PX) return
          engaged = true
          draggedRef.current = true
          setDragTab(tab)
          document.body.classList.add('dragging-workspace-tab')
        }
        setGhost({ x: ev.clientX, y: ev.clientY })
        setActiveEdge(edgeAtPoint(ev.clientX, ev.clientY))
      }

      const finish = (ev: MouseEvent): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', finish)
        if (engaged) {
          const edge = edgeAtPoint(ev.clientX, ev.clientY)
          if (edge) onDrop(edge, tab)
        }
        setDragTab(null)
        setActiveEdge(null)
        setGhost(null)
        document.body.classList.remove('dragging-workspace-tab')
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', finish)
    },
    [onDrop]
  )

  const didDrag = useCallback(() => draggedRef.current, [])

  return { dragTab, activeEdge, ghost, trackTabPress, didDrag }
}
