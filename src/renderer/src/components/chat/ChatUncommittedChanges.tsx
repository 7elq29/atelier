import { useState } from 'react'
import type { SessionChangesCapItem } from '../../../../shared/session-changes-cap'

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

export default function ChatUncommittedChanges({
  items,
  onOpenFile,
  onOpenCommit
}: {
  items: SessionChangesCapItem[] | null | undefined
  onOpenFile: (path: string) => void
  onOpenCommit: (hash: string) => void
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
          {rows.map((row) =>
            row.kind === 'file' ? (
              <div
                key={`file:${row.path}`}
                className="chat-changes-file"
                role="button"
                tabIndex={0}
                data-testid="chat-changes-file"
                data-path={row.path}
                onClick={() => onOpenFile(row.path)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpenFile(row.path)
                  }
                }}
              >
                <span className="fname">{basenamePath(row.path)}</span>
                <span className="chat-changes-stats">
                  {row.additions > 0 && <span className="chat-changes-add">+{row.additions}</span>}
                  {row.deletions > 0 && <span className="chat-changes-del">−{row.deletions}</span>}
                </span>
              </div>
            ) : (
              <div
                key={`commit:${row.hash}`}
                className="chat-changes-commit"
                role="button"
                tabIndex={0}
                data-testid="chat-changes-commit"
                data-hash={row.hash}
                onClick={() => onOpenCommit(row.hash)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpenCommit(row.hash)
                  }
                }}
              >
                <span className="chat-changes-commit-label">{row.subject}</span>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}
