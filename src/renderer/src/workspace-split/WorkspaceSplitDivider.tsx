import { useCallback, useRef } from 'react'

export function WorkspaceSplitDivider({
  splitRatio,
  onSplitRatioChange
}: {
  splitRatio: number
  onSplitRatioChange: (ratio: number) => void
}): JSX.Element {
  const dragging = useRef(false)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      dragging.current = true
      const host = (e.currentTarget as HTMLElement).closest('.session-workspace-tabs')
      if (!host) return

      const onMove = (ev: MouseEvent): void => {
        if (!dragging.current) return
        const rect = host.getBoundingClientRect()
        const ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - rect.left) / rect.width))
        onSplitRatioChange(ratio)
      }

      const onUp = (): void => {
        dragging.current = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    },
    [onSplitRatioChange]
  )

  return (
    <div
      className="workspace-split-divider"
      data-testid="workspace-split-divider"
      style={{ left: `calc(${splitRatio * 100}% - 2.5px)` }}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
    />
  )
}
