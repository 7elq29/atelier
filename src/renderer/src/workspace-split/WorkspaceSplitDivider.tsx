import { useCallback, useRef, useState } from 'react'
import type { WorkspaceSplitDirection } from './workspace-split-types'

export function WorkspaceSplitDivider({
  splitRatio,
  direction,
  onSplitRatioChange
}: {
  splitRatio: number
  direction: WorkspaceSplitDirection
  onSplitRatioChange: (ratio: number) => void
}): JSX.Element {
  const dragging = useRef(false)
  const [active, setActive] = useState(false)
  const isRow = direction === 'row'

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      setActive(true)
      const host = (e.currentTarget as HTMLElement).closest('.session-workspace-tabs')
      if (!host) return

      const onMove = (ev: MouseEvent): void => {
        if (!dragging.current) return
        const rect = host.getBoundingClientRect()
        const raw = isRow
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height
        onSplitRatioChange(Math.min(0.85, Math.max(0.15, raw)))
      }

      const onUp = (): void => {
        dragging.current = false
        setActive(false)
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [isRow, onSplitRatioChange]
  )

  const offset = `calc(${splitRatio * 100}% - 2.5px)`
  return (
    <div
      className={`workspace-split-divider workspace-split-divider--${direction}${active ? ' dragging' : ''}`}
      data-testid="workspace-split-divider"
      data-direction={direction}
      style={isRow ? { left: offset } : { top: offset }}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={isRow ? 'vertical' : 'horizontal'}
    />
  )
}
