import TerminalWithToolbox from './TerminalWithToolbox'

/**
 * Companion terminal drawer (07-secondary-panels §5b): a resizable
 * bottom drawer with its own independent pty (`${sessionId}:companion`,
 * never the session's own agent I/O). Resizing is a plain drag-to-resize
 * on the handle (real DOM height change, not a CSS-only affordance).
 */
export default function CompanionTerminalDrawer({
  sessionId,
  cwd,
  hostname,
  shellRemoteHost,
  height,
  onHeightChange,
  onClose
}: {
  sessionId: string
  cwd: string
  hostname?: string | null
  shellRemoteHost?: string | null
  height: number
  onHeightChange: (h: number) => void
  onClose: () => void
}): JSX.Element {
  function startResize(e: React.MouseEvent): void {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    function onMove(ev: MouseEvent): void {
      const delta = startY - ev.clientY
      onHeightChange(Math.min(600, Math.max(120, startHeight + delta)))
    }
    function onUp(): void {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div data-testid="companion-drawer">
      <div className="drawer-handle" onMouseDown={startResize} data-testid="companion-drawer-handle" />
      <div className="drawer" style={{ height }}>
        <TerminalWithToolbox
          ptyId={`${sessionId}:companion`}
          cwd={cwd}
          hostname={hostname}
          shellRemoteHost={shellRemoteHost}
          variant="companion"
          active
          onClose={onClose}
        />
      </div>
    </div>
  )
}
