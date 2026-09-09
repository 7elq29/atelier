import { SESSION_TAB_SHORTCUT_LABELS } from '../../keyboard-hints/keyboard-hints'
import type { SessionTab } from '../../../../shared/session-types'

export type { SessionTab }

/**
 * Tab bar (07-secondary-panels §1): Chat/Diff/Files/Terminal(/Ports for
 * remote sessions) per session, matching the mock's `.tab-strip` button
 * treatment exactly (`.tab-strip button.active`).
 */
export default function TabBar({
  activeTab,
  onSelect,
  showPorts,
  diffChangedCount,
  hiddenTabs,
  onTabPress,
  didDragTab
}: {
  activeTab: SessionTab
  onSelect: (tab: SessionTab) => void
  showPorts: boolean
  /** Live changed-file count for the Diff tab badge; omit when not a git repo or zero. */
  diffChangedCount?: number | null
  /** Tabs in secondary split panes — hidden from the strip while split is active. */
  hiddenTabs?: ReadonlySet<SessionTab>
  /** Begins watching a tab press for a drag-to-split gesture. */
  onTabPress?: (tab: SessionTab, e: React.MouseEvent) => void
  /** True when the gesture just completed was a drag, whose click must not select. */
  didDragTab?: () => boolean
}): JSX.Element {
  const tabs: { id: SessionTab; label: string }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'diff', label: 'Diff' },
    { id: 'files', label: 'Files' },
    { id: 'terminal', label: 'Terminal' },
    ...(showPorts ? [{ id: 'ports' as SessionTab, label: 'Ports' }] : [])
  ]
  return (
    <div className="tab-strip" data-testid="tab-strip" data-hint-exclude-root="">
      {tabs.map((t) => {
        if (hiddenTabs?.has(t.id)) return null
        return (
          <button
            key={t.id}
            className={`workspace-tab-draggable${activeTab === t.id ? ' active' : ''}`}
            /* Not natively draggable: the gesture is tracked from mousedown so it
               can require real movement before it counts as a drag. */
            onMouseDown={(e) => onTabPress?.(t.id, e)}
            onClick={() => {
              if (didDragTab?.()) return
              onSelect(t.id)
            }}
            data-testid={`tab-${t.id}`}
            data-tab={t.id}
            data-session-tab-shortcut={SESSION_TAB_SHORTCUT_LABELS[t.id]}
          >
            <span className="tab-drag-grip" aria-hidden="true">
              ⋮⋮
            </span>
            {t.label}
            {t.id === 'diff' && diffChangedCount != null && diffChangedCount > 0 ? (
              <span className="tab-badge" data-testid="tab-diff-count">
                {diffChangedCount}
              </span>
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
