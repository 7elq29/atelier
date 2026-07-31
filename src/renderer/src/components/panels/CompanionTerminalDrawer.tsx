import TerminalPanel from './TerminalPanel'

/**
 * Companion terminal drawer (07-secondary-panels §5b): a resizable
 * bottom drawer with its own independent pty (`${sessionId}:companion`,
 * never the session's own agent I/O), matching the mock's `.drawer-head`
 * ("▤ Companion Terminal" + close button) over `.drawer-handle`/`.drawer`.
 * Resizing is a plain drag-to-resize on the handle (real DOM height change,
 * not a CSS-only affordance).
 */
export default function CompanionTerminalDrawer({
  sessionId,
  cwd,
  hostname,
  height,
  onHeightChange,
  onClose
}: {
  sessionId: string
  cwd: string
  hostname?: string | null
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
        <div className="drawer-head">
          ▤ Companion Terminal
          <span className="spacer" />
          <button className="btn btn-icon btn-sm" onClick={onClose} data-testid="companion-drawer-close">
            ✕
          </button>
        </div>
        <TerminalPanel ptyId={`${sessionId}:companion`} cwd={cwd} hostname={hostname} />
      </div>
    </div>
  )
}
