import type { SessionTab } from '../../../../shared/session-types'
import { SESSION_TAB_SHORTCUT_LABELS } from '../../keyboard-hints/keyboard-hints'

export type WorkspaceToolTab = Exclude<SessionTab, 'chat'>

function ToolIcon({ tab }: { tab: WorkspaceToolTab }): JSX.Element {
  if (tab === 'diff') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 3v14m0 0-3-3m3 3 3-3M17 21V7m0 0-3 3m3-3 3 3" />
      </svg>
    )
  }
  if (tab === 'files') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.5 6.5h6l2 2h9v10a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      </svg>
    )
  }
  if (tab === 'terminal') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m5 7 4 4-4 4m7 1h7" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.2 3.8 8.5S14.5 18.1 12 20.5M12 3.5C9.5 5.9 8.2 8.7 8.2 12s1.3 6.1 3.8 8.5" />
    </svg>
  )
}

const LABELS: Record<WorkspaceToolTab, string> = {
  diff: 'Diff',
  files: 'Files',
  terminal: 'Terminal',
  ports: 'Ports'
}

export default function WorkspaceToolRail({
  activeTool,
  showPorts,
  diffChangedCount,
  onSelect,
  onToolPress,
  didDragTool
}: {
  activeTool: WorkspaceToolTab | null
  showPorts: boolean
  diffChangedCount?: number | null
  onSelect: (tab: WorkspaceToolTab) => void
  onToolPress?: (tab: WorkspaceToolTab, event: React.MouseEvent) => void
  didDragTool?: () => boolean
}): JSX.Element {
  const tools: WorkspaceToolTab[] = ['diff', 'files', 'terminal', ...(showPorts ? ['ports' as const] : [])]

  return (
    <nav className="workspace-tool-rail" data-testid="workspace-tool-rail" aria-label="Workspace tools">
      {tools.map((tab) => (
        <button
          key={tab}
          type="button"
          className={`workspace-tool-button workspace-tab-draggable${activeTool === tab ? ' active' : ''}`}
          data-testid={`tab-${tab}`}
          data-tab={tab}
          data-hint-exclude=""
          data-session-tab-shortcut={SESSION_TAB_SHORTCUT_LABELS[tab]}
          title={LABELS[tab]}
          aria-label={LABELS[tab]}
          aria-pressed={activeTool === tab}
          onMouseDown={(event) => onToolPress?.(tab, event)}
          onClick={() => {
            if (didDragTool?.()) return
            onSelect(tab)
          }}
        >
          <ToolIcon tab={tab} />
          {tab === 'diff' && diffChangedCount != null && diffChangedCount > 0 ? (
            <span className="workspace-tool-badge" data-testid="tab-diff-count">
              {diffChangedCount}
            </span>
          ) : null}
        </button>
      ))}
    </nav>
  )
}
