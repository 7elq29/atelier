import { useCallback, useState } from 'react'
import type { TerminalToolboxCommand } from '../../../../shared/terminal-toolbox-types'

function IconPlus(): JSX.Element {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function IconPencil(): JSX.Element {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 20l1-4.2L15.6 5.2a1.7 1.7 0 0 1 2.4 0l1 1a1.7 1.7 0 0 1 0 2.4L8.2 19.2z" />
      <path d="M13.5 6.7l3.8 3.8" />
    </svg>
  )
}

function IconClose(): JSX.Element {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

interface TerminalToolboxPanelProps {
  commands: TerminalToolboxCommand[]
  onChange: (commands: TerminalToolboxCommand[]) => void
  onInject: (command: string) => void
}

export default function TerminalToolboxPanel({
  commands,
  onChange,
  onInject
}: TerminalToolboxPanelProps): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftLabel, setDraftLabel] = useState('')
  const [draftCommand, setDraftCommand] = useState('')
  const [adding, setAdding] = useState(false)
  const [addLabel, setAddLabel] = useState('')
  const [addCommand, setAddCommand] = useState('')

  const startEdit = useCallback((cmd: TerminalToolboxCommand) => {
    setEditingId(cmd.id)
    setDraftLabel(cmd.label)
    setDraftCommand(cmd.command)
    setAdding(false)
  }, [])

  const cancelEdit = useCallback(() => {
    setEditingId(null)
    setDraftLabel('')
    setDraftCommand('')
  }, [])

  const saveEdit = useCallback(() => {
    if (!editingId) return
    const label = draftLabel.trim()
    const command = draftCommand.trim()
    if (!label || !command) return
    onChange(
      commands.map((c) => (c.id === editingId ? { ...c, label, command } : c))
    )
    cancelEdit()
  }, [editingId, draftLabel, draftCommand, commands, onChange, cancelEdit])

  const remove = useCallback(
    (id: string) => {
      onChange(commands.filter((c) => c.id !== id))
      if (editingId === id) cancelEdit()
    },
    [commands, onChange, editingId, cancelEdit]
  )

  const openAdd = useCallback(() => {
    setAdding(true)
    setAddLabel('')
    setAddCommand('')
    cancelEdit()
  }, [cancelEdit])

  const saveAdd = useCallback(() => {
    const label = addLabel.trim()
    const command = addCommand.trim()
    if (!label || !command) return
    onChange([
      ...commands,
      { id: `tb-${crypto.randomUUID()}`, label, command }
    ])
    setAdding(false)
    setAddLabel('')
    setAddCommand('')
  }, [addLabel, addCommand, commands, onChange])

  return (
    <aside
      className="term-toolbox-panel open"
      data-testid="terminal-toolbox-panel"
      aria-hidden="false"
    >
      <div className="term-toolbox-head">
        <span>Commands</span>
        <span className="spacer" />
        <button
          type="button"
          className="term-toolbox-icon-btn"
          data-testid="terminal-toolbox-add"
          title="Add command"
          aria-label="Add command"
          onClick={openAdd}
        >
          <IconPlus />
        </button>
      </div>
      <div className="term-toolbox-list" data-testid="terminal-toolbox-list">
        {commands.map((cmd) =>
          editingId === cmd.id ? (
            <div key={cmd.id} className="term-toolbox-row editing" data-cmd-id={cmd.id}>
              <div className="term-toolbox-edit-fields">
                <input
                  type="text"
                  value={draftLabel}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  placeholder="Label"
                />
                <input
                  type="text"
                  className="mono"
                  value={draftCommand}
                  onChange={(e) => setDraftCommand(e.target.value)}
                  placeholder="Command"
                />
                <div className="term-toolbox-add-actions">
                  <button type="button" className="btn btn-sm" onClick={cancelEdit}>
                    Cancel
                  </button>
                  <button type="button" className="btn btn-sm btn-primary" onClick={saveEdit}>
                    Save
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div
              key={cmd.id}
              className="term-toolbox-row"
              data-cmd-id={cmd.id}
              title="Double-click to paste"
              onDoubleClick={(e) => {
                if ((e.target as HTMLElement).closest('button')) return
                onInject(cmd.command)
              }}
            >
              <div className="term-toolbox-row-body">
                <span className="term-toolbox-row-label">{cmd.label}</span>
                <span className="term-toolbox-row-cmd">{cmd.command}</span>
              </div>
              <div className="term-toolbox-row-side">
                <button
                  type="button"
                  className="term-toolbox-icon-btn tb-edit"
                  title="Edit"
                  aria-label="Edit"
                  onClick={() => startEdit(cmd)}
                >
                  <IconPencil />
                </button>
                <button
                  type="button"
                  className="term-toolbox-icon-btn tb-remove"
                  title="Remove"
                  aria-label="Remove"
                  onClick={() => remove(cmd.id)}
                >
                  <IconClose />
                </button>
              </div>
            </div>
          )
        )}
      </div>
      {adding ? (
        <div className="term-toolbox-add-form" data-testid="terminal-toolbox-add-form">
          <input
            type="text"
            data-testid="terminal-toolbox-add-label"
            placeholder="Label"
            value={addLabel}
            onChange={(e) => setAddLabel(e.target.value)}
          />
          <input
            type="text"
            className="mono"
            data-testid="terminal-toolbox-add-command"
            placeholder="Command to paste"
            value={addCommand}
            onChange={(e) => setAddCommand(e.target.value)}
          />
          <div className="term-toolbox-add-actions">
            <button
              type="button"
              className="btn btn-sm"
              data-testid="terminal-toolbox-add-cancel"
              onClick={() => setAdding(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              data-testid="terminal-toolbox-add-save"
              onClick={saveAdd}
            >
              Save
            </button>
          </div>
        </div>
      ) : null}
      <p className="term-toolbox-hint">Double-click a command to paste into this terminal.</p>
    </aside>
  )
}
