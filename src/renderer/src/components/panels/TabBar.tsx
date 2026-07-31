export type SessionTab = 'chat' | 'diff' | 'files' | 'terminal' | 'ports'

/**
 * Tab bar (07-secondary-panels §1): Chat/Diff/Files/Terminal(/Ports for
 * remote sessions) per session, matching the mock's `.tab-strip` button
 * treatment exactly (`.tab-strip button.active`).
 */
export default function TabBar({
  activeTab,
  onSelect,
  showPorts
}: {
  activeTab: SessionTab
  onSelect: (tab: SessionTab) => void
  showPorts: boolean
}): JSX.Element {
  const tabs: { id: SessionTab; label: string }[] = [
    { id: 'chat', label: 'Chat' },
    { id: 'diff', label: 'Diff' },
    { id: 'files', label: 'Files' },
    { id: 'terminal', label: 'Terminal' },
    ...(showPorts ? [{ id: 'ports' as SessionTab, label: 'Ports' }] : [])
  ]
  return (
    <div className="tab-strip" data-testid="tab-strip">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={activeTab === t.id ? 'active' : ''}
          onClick={() => onSelect(t.id)}
          data-testid={`tab-${t.id}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
