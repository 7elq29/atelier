import { useEffect, useState, type CSSProperties } from 'react'
import type { CreateSessionOptions, RemoteHostOption, SessionMode } from '../../../shared/session-types'

interface NewSessionModalProps {
  isOpen: boolean
  hosts: RemoteHostOption[]
  onClose: () => void
  onCreate: (opts: CreateSessionOptions) => Promise<void>
}

/**
 * New Session dialog (02-session-lifecycle): project folder picker (real
 * `dialog.showOpenDialog`), Terminal/Claude Code segmented mode, host picker
 * (Local + devpod-us-or, verified running via `devpod ps`), optional initial
 * prompt for Claude Code mode. Matches mocks/index.html's #modal-new-session.
 */
export default function NewSessionModal({ isOpen, hosts, onClose, onCreate }: NewSessionModalProps): JSX.Element | null {
  const [projectPath, setProjectPath] = useState<string | null>(null)
  const [mode, setMode] = useState<SessionMode>('claude-code')
  const [hostId, setHostId] = useState<string>('local')
  const [prompt, setPrompt] = useState('')
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (isOpen) {
      setProjectPath(null)
      setMode('claude-code')
      setHostId('local')
      setPrompt('')
      setCreating(false)
    }
  }, [isOpen])

  if (!isOpen) return null

  const isRemote = hostId !== 'local'

  async function pickFolder(): Promise<void> {
    const picked = await window.gardenia.pickProjectFolder()
    if (picked) setProjectPath(picked)
  }

  async function handleCreate(): Promise<void> {
    if (!projectPath || creating) return
    setCreating(true)
    try {
      await onCreate({
        projectPath,
        mode,
        hostId,
        prompt: mode === 'claude-code' && prompt.trim() ? prompt.trim() : undefined
      })
      onClose()
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      data-testid="new-session-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-dialog" style={{ width: 560 }}>
        <div className="modal-header">
          <h2>New Session</h2>
          <button className="btn btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div>
            <div className="field-label">Project</div>
            {isRemote ? (
              // Remote hosts have their own filesystem — a local folder-picker
              // dialog can't address it, so this is a plain path field
              // (matches the harness's RemoteHost model: `cwd` is interpreted
              // on the remote host when `host` is set).
              <input
                className="input"
                style={{ width: '100%' }}
                data-testid="remote-project-path"
                placeholder="/home/user/code/my-project"
                value={projectPath ?? ''}
                onChange={(e) => setProjectPath(e.target.value)}
              />
            ) : (
              <button className="project-picker" data-testid="pick-project-folder" onClick={pickFolder} style={buttonReset}>
                <span style={{ flex: 1, textAlign: 'left' }}>{projectPath ?? 'Choose a project folder…'}</span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>browse</span>
              </button>
            )}
          </div>

          <div>
            <div className="field-label">Session type</div>
            <div className="segmented">
              <button
                className={mode === 'claude-code' ? 'active' : ''}
                data-testid="mode-claude-code"
                onClick={() => setMode('claude-code')}
              >
                Claude Code
              </button>
              <button
                className={mode === 'terminal' ? 'active' : ''}
                data-testid="mode-terminal"
                onClick={() => setMode('terminal')}
              >
                Terminal
              </button>
            </div>
          </div>

          <div>
            <div className="field-label">Host</div>
            <div className="host-options">
              <label className={'host-option' + (hostId === 'local' ? ' selected' : '')}>
                <input type="radio" name="host" checked={hostId === 'local'} onChange={() => setHostId('local')} />
                <div className="host-option-main">
                  <div className="host-title">Local</div>
                  <div className="host-sub">Runs on this machine</div>
                </div>
              </label>
              {hosts.map((host) => (
                <label
                  key={host.id}
                  className={'host-option' + (hostId === host.id ? ' selected' : '')}
                  data-testid={`host-option-${host.id}`}
                >
                  <input type="radio" name="host" checked={hostId === host.id} onChange={() => setHostId(host.id)} />
                  <div className="host-option-main">
                    <div className="host-title">{host.label}</div>
                    <div className="host-sub">{host.sshHost}</div>
                  </div>
                  <span className={'status-chip ' + host.status}>{host.status}</span>
                </label>
              ))}
            </div>
          </div>

          {mode === 'claude-code' && (
            <div>
              <div className="field-label">
                Initial prompt <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span>
              </div>
              <div className="prompt-box">
                <textarea
                  data-testid="initial-prompt"
                  placeholder="What should Claude do first?"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            data-testid="start-session-button"
            disabled={!projectPath || creating}
            onClick={handleCreate}
          >
            {creating ? 'Starting…' : 'Start Session'}
          </button>
        </div>
      </div>
    </div>
  )
}

const buttonReset: CSSProperties = {
  width: '100%',
  cursor: 'pointer',
  font: 'inherit',
  color: 'inherit',
  appearance: 'none'
}
