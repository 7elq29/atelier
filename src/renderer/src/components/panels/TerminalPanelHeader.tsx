import { truncateContextPath } from '../../utils/truncateContextPath'

function IconTerminalGlyph(): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

function IconLaptop(): JSX.Element {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M2 19h20" />
    </svg>
  )
}

function IconGlobe(): JSX.Element {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" />
    </svg>
  )
}

export function IconToolbox(): JSX.Element {
  return (
    <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 9h16v11H4z" />
      <path d="M8 9V7a4 4 0 0 1 8 0v2" />
      <line x1="4" y1="14" x2="20" y2="14" />
    </svg>
  )
}

function hostDisplay(
  hostname: string | null | undefined,
  shellRemoteHost: string | null | undefined
): { label: string; isLocal: boolean } {
  if (hostname) return { label: hostname, isLocal: false }
  if (shellRemoteHost) return { label: shellRemoteHost, isLocal: false }
  return { label: 'Local', isLocal: true }
}

/**
 * In-panel header for every real terminal surface (session Terminal tab,
 * companion drawer, and terminal-mode sessions).
 */
export default function TerminalPanelHeader({
  cwd,
  hostname,
  shellRemoteHost,
  variant = 'default',
  toolboxOpen,
  onToggleToolbox,
  onClose
}: {
  cwd: string
  hostname?: string | null
  shellRemoteHost?: string | null
  variant?: 'default' | 'companion'
  toolboxOpen: boolean
  onToggleToolbox: () => void
  onClose?: () => void
}): JSX.Element {
  const cwdLabel = truncateContextPath(cwd)
  const host = hostDisplay(hostname, shellRemoteHost)
  const title = variant === 'companion' ? 'Companion terminal' : 'Terminal'

  return (
    <div className="term-panel-header" data-testid="terminal-panel-header">
      <div className="term-panel-header-title">
        <span className="term-panel-header-glyph" aria-hidden>
          <IconTerminalGlyph />
        </span>
        <span className="term-panel-header-label">{title}</span>
      </div>
      <div className="term-panel-header-meta">
        {cwdLabel ? (
          <span className="term-panel-header-chip term-panel-header-cwd" data-testid="terminal-cwd-chip" title={cwd}>
            {cwdLabel}
          </span>
        ) : null}
        <span className="term-panel-header-chip term-panel-header-host" data-testid="terminal-host-chip">
          {host.isLocal ? <IconLaptop /> : <IconGlobe />}
          {host.label}
        </span>
        <button
          type="button"
          className="term-toolbox-toggle"
          data-testid="terminal-toolbox-toggle"
          title="Command toolbox"
          aria-label="Command toolbox"
          aria-expanded={toolboxOpen}
          onClick={onToggleToolbox}
        >
          <IconToolbox />
        </button>
        {onClose ? (
          <button
            type="button"
            className="btn btn-icon btn-sm term-panel-header-close"
            onClick={onClose}
            data-testid="companion-drawer-close"
            aria-label="Close companion terminal"
          >
            ✕
          </button>
        ) : null}
      </div>
    </div>
  )
}
