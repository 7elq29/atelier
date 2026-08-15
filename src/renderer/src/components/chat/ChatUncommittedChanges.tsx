import { useState } from 'react'
import type { SessionChangesCapItem } from '../../../../shared/session-changes-cap'
import { isClaudePlanPath } from '../../../../shared/claude-plan-path'

function basenamePath(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}

function ChevronDown(): JSX.Element {
  return (
    <svg width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function ChatChangesFileRow({
  path,
  additions,
  deletions,
  opensInFilesTab,
  onOpen
}: {
  path: string
  additions: number
  deletions: number
  opensInFilesTab: boolean
  onOpen: (path: string, opensInFilesTab: boolean) => void
}): JSX.Element {
  const isPlan = isClaudePlanPath(path)
  return (
    <div
      className={`chat-changes-file${isPlan ? ' chat-changes-file-plan' : ''}`}
      role="button"
      tabIndex={0}
      data-testid="chat-changes-file"
      data-path={path}
      data-opens-in-files-tab={opensInFilesTab ? 'true' : 'false'}
      data-is-plan={isPlan ? 'true' : 'false'}
      onClick={() => onOpen(path, opensInFilesTab)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(path, opensInFilesTab)
        }
      }}
    >
      <span className="fname">{basenamePath(path)}</span>
      {isPlan ? (
        <span className="chat-changes-plan-tag" data-testid="chat-changes-plan-tag">
          Plan
        </span>
      ) : null}
      <span className="chat-changes-stats">
        {additions > 0 && <span className="chat-changes-add">+{additions}</span>}
        {deletions > 0 && <span className="chat-changes-del">−{deletions}</span>}
      </span>
    </div>
  )
}

export default function ChatUncommittedChanges({
  items,
  onOpenFile
}: {
  items: SessionChangesCapItem[] | null | undefined
  onOpenFile: (path: string, opensInFilesTab: boolean) => void
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(true)

  const rows = items ?? []
  if (rows.length === 0) return null

  const title = `${rows.length} change${rows.length === 1 ? '' : 's'}`

  return (
    <div
      className={`chat-changes-card${collapsed ? ' collapsed' : ''}`}
      data-testid="chat-uncommitted-changes"
    >
      <div className="chat-changes-head">
        <button
          type="button"
          className="chat-changes-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="chat-changes-chev">
            <ChevronDown />
          </span>
          <span className="chat-changes-title">{title}</span>
        </button>
      </div>
      {!collapsed && (
        <div className="chat-changes-body">
          {rows.map((row) => (
            <ChatChangesFileRow
              key={`file:${row.path}`}
              path={row.path}
              additions={row.additions}
              deletions={row.deletions}
              opensInFilesTab={row.opensInFilesTab}
              onOpen={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  )
}
