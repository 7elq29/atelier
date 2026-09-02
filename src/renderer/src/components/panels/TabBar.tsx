import { SESSION_TAB_SHORTCUT_LABELS } from '../../keyboard-hints/keyboard-hints'

export type SessionTab = 'chat' | 'diff' | 'files' | 'terminal' | 'ports'

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
  onDragTabStart,
  onDragTabEnd
}: {
  activeTab: SessionTab
  onSelect: (tab: SessionTab) => void
  showPorts: boolean
  /** Live changed-file count for the Diff tab badge; omit when not a git repo or zero. */
  diffChangedCount?: number | null
  /** Tabs in secondary split panes — hidden from the strip while split is active. */
  hiddenTabs?: ReadonlySet<SessionTab>
  onDragTabStart?: (tab: SessionTab, e: React.DragEvent<HTMLButtonElement>) => void
  onDragTabEnd?: () => void
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
        const dragEnabled = Boolean(onDragTabStart)
        return (
          <button
            key={t.id}
            className={`workspace-tab-draggable${activeTab === t.id ? ' active' : ''}`}
            draggable={dragEnabled}
            onClick={(e) => {
              if (dragEnabled && (e.currentTarget as HTMLButtonElement & { __didDrag?: boolean }).__didDrag) {
                e.preventDefault()
                e.stopPropagation()
                return
              }
              onSelect(t.id)
            }}
            onDragStart={(e) => {
              if (!onDragTabStart) return
              ;(e.currentTarget as HTMLButtonElement & { __didDrag?: boolean }).__didDrag = true
              onDragTabStart(t.id, e)
            }}
            onDragEnd={(e) => {
              onDragTabEnd?.()
              window.setTimeout(() => {
                ;(e.currentTarget as HTMLButtonElement & { __didDrag?: boolean }).__didDrag = false
              }, 0)
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
