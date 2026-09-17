import { useEffect, useState } from 'react'

/**
 * Obsidian-style integrated title bar (macOS hiddenInset). Empty drag region with
 * centered app name — native traffic lights sit in the inset; session chrome stays
 * in `.topbar` below.
 */
export default function TitleBar(): JSX.Element {
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
      <div className="title-bar-drag" data-testid="window-title-bar-label">
        {label}
      </div>
    </header>
  )
}
