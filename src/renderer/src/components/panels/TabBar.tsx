import { SESSION_TAB_SHORTCUT_LABELS } from '../../keyboard-hints/keyboard-hints'
import type { SessionTab } from '../../../../shared/session-types'

export type { SessionTab }

/** Chat remains in the top bar; secondary tools live in WorkspaceToolRail. */
export default function TabBar({
  activeTab,
  onSelect
}: {
  activeTab: SessionTab
  onSelect: (tab: SessionTab) => void
}): JSX.Element {
  return (
    <div className="tab-strip" data-testid="tab-strip" data-hint-exclude-root="">
      <button
        className={activeTab === 'chat' ? 'active' : ''}
        onClick={() => onSelect('chat')}
        data-testid="tab-chat"
        data-tab="chat"
        data-session-tab-shortcut={SESSION_TAB_SHORTCUT_LABELS.chat}
      >
        Chat
      </button>
    </div>
  )
}
