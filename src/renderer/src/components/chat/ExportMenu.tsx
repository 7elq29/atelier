import { useEffect, useRef, useState } from 'react'

/**
 * "Export conversation" topbar button + dropdown (10c-enrichment-export-
 * conversation). Markup/classes (`.export-menu-pop`/`.smi`) and icon paths
 * (`#icon-download`/`#icon-notepad`/`#icon-archive`) copied verbatim from the
 * mock's `toggleExportMenu()`/`exportAs()`, reimplemented as real React state
 * — same approach `MessageActions.tsx` used for `#icon-copy`/`#icon-speaker`
 * — instead of the mock's demo-only DOM-node juggling + clipboard toast.
 */
export default function ExportMenu({
  onExport
}: {
  onExport: (format: 'markdown' | 'json') => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleOutsideClick(event: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('click', handleOutsideClick, true)
    return () => document.removeEventListener('click', handleOutsideClick, true)
  }, [open])

  function handleSelect(format: 'markdown' | 'json'): void {
    setOpen(false)
    onExport(format)
  }

  return (
    <div style={{ position: 'relative' }} ref={rootRef}>
      <button
        className="btn btn-icon btn-sm"
        title="Export conversation"
        data-testid="export-menu-button"
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          className="icon"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="12" y1="3" x2="12" y2="15" />
          <polyline points="7 10 12 15 17 10" />
          <path d="M4 18h16" />
        </svg>
      </button>
      {open && (
        <div className="export-menu-pop" data-testid="export-menu-pop">
          <div className="smi" data-testid="export-as-markdown" onClick={() => handleSelect('markdown')}>
            <svg
              className="icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 2h9l5 5v15H6z" />
              <path d="M15 2v5h5" />
              <line x1="9" y1="13" x2="16" y2="13" />
              <line x1="9" y1="17" x2="14" y2="17" />
            </svg>
            Export as Markdown
          </div>
          <div className="smi" data-testid="export-as-json" onClick={() => handleSelect('json')}>
            <svg
              className="icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="4" width="18" height="4" rx="1" />
              <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
              <line x1="10" y1="12" x2="14" y2="12" />
            </svg>
            Export as JSON
          </div>
        </div>
      )}
    </div>
  )
}
