import { useEffect, useState } from 'react'

/**
 * Obsidian-style integrated title bar (macOS hiddenInset). Drag region with
 * centered app name — native traffic lights sit in the inset; the sidebar
 * collapse toggle lives here so it's always accessible regardless of sidebar state.
 */
export default function TitleBar({
  collapsed,
  onToggleCollapse
}: {
  collapsed: boolean
  onToggleCollapse: () => void
}): JSX.Element {
  const [fullScreen, setFullScreen] = useState(false)
  const label = window.atelier.isDev ? 'Atelier · DEV' : 'Atelier'

  useEffect(() => {
    let mounted = true
    const syncFullScreen = (): void => {
      void window.atelier.isWindowFullScreen().then((current) => {
        if (mounted) setFullScreen(current)
      })
    }
    const off = window.atelier.onWindowFullScreenChanged(({ fullScreen: next }) => {
      setFullScreen(next)
    })
    window.addEventListener('resize', syncFullScreen)
    syncFullScreen()
    return () => {
      mounted = false
      off()
      window.removeEventListener('resize', syncFullScreen)
    }
  }, [])

  if (fullScreen) return <></>

  return (
    <header className={`title-bar${window.atelier.isDev ? ' title-bar-dev' : ''}`} data-testid="window-title-bar">
      <button
        className="title-bar-toggle-btn"
        title="Toggle sidebar"
        data-testid="sidebar-collapse-toggle"
        onClick={onToggleCollapse}
      >
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M9 4v16" />
          <path d={collapsed ? 'm13 9 3 3-3 3' : 'm16 9-3 3 3 3'} />
        </svg>
      </button>
      <div className="title-bar-drag" data-testid="window-title-bar-label">
        {label}
      </div>
    </header>
  )
}
