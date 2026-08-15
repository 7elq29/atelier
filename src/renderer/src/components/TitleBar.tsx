/**
 * Obsidian-style integrated title bar (macOS hiddenInset). Empty drag region with
 * centered app name — native traffic lights sit in the inset; session chrome stays
 * in `.topbar` below.
 */
export default function TitleBar(): JSX.Element {
  const label = window.atelier.isDev ? 'Atelier · DEV' : 'Atelier'
  return (
    <header className={`title-bar${window.atelier.isDev ? ' title-bar-dev' : ''}`} data-testid="window-title-bar">
      <div className="title-bar-drag" data-testid="window-title-bar-label">
        {label}
      </div>
    </header>
  )
}
