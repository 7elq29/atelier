/**
 * Obsidian-style integrated title bar (macOS hiddenInset). Empty drag region with
 * centered app name — native traffic lights sit in the inset; session chrome stays
 * in `.topbar` below.
 */
export default function TitleBar(): JSX.Element {
  return (
    <header className="title-bar" data-testid="window-title-bar">
      <div className="title-bar-drag">Atelier</div>
    </header>
  )
}
