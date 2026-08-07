import { useState } from 'react'
import type { DiffFileChange, DiffSummary } from '../../../../shared/panel-types'

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
  diffSummary,
  onOpenFile
}: {
  diffSummary: DiffSummary | null | undefined
  onOpenFile: (path: string) => void
}): JSX.Element | null {
  const [collapsed, setCollapsed] = useState(true)

  const files = diffSummary?.isRepo ? diffSummary.files : []
  if (files.length === 0) return null

  const title = `${files.length} File${files.length === 1 ? '' : 's'}`

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
          {files.map((f: DiffFileChange) => (
            <div
              key={f.path}
              className="chat-changes-file"
              role="button"
              tabIndex={0}
              data-testid="chat-changes-file"
              data-path={f.path}
              onClick={() => onOpenFile(f.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onOpenFile(f.path)
                }
              }}
            >
              <span className="fname">{basenamePath(f.path)}</span>
              <span className="chat-changes-stats">
                {f.additions > 0 && <span className="chat-changes-add">+{f.additions}</span>}
                {f.deletions > 0 && <span className="chat-changes-del">−{f.deletions}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
