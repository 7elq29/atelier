import { useEffect, useRef, useState } from 'react'
import type { CreateSessionOptions, RemoteHostOption, SessionMode } from '../../../shared/session-types'
import type { ProjectPathSuggestion } from '../../../shared/project-path-autocomplete'
import { worktreeRootFromConfig } from '../../../shared/worktree-path'
import type { AtelierConfig } from '../../../shared/config'

interface NewSessionModalProps {
  isOpen: boolean
  hosts: RemoteHostOption[]
  config: AtelierConfig
  onClose: () => void
  onCreate: (opts: CreateSessionOptions) => Promise<void>
}

/**
 * New Session dialog (02-session-lifecycle): free-text project path (local or
 * remote), Terminal/Claude Code segmented mode, host picker (Local +
 * devpod-us-or, verified running via `devpod ps`), optional initial prompt
 * for Claude Code mode. Matches mocks/index.html's #modal-new-session.
 */
export default function NewSessionModal({ isOpen, hosts, config, onClose, onCreate }: NewSessionModalProps): JSX.Element | null {
  const [projectPath, setProjectPath] = useState('')
  const [mode, setMode] = useState<SessionMode>('claude-code')
  const [hostId, setHostId] = useState<string>('local')
  const [prompt, setPrompt] = useState('')
  const [planMode, setPlanMode] = useState(false)
  const [useWorktree, setUseWorktree] = useState(false)
  const [creating, setCreating] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [recentPaths, setRecentPaths] = useState<string[]>([])
  const [suggestions, setSuggestions] = useState<ProjectPathSuggestion[]>([])
  const [suggestionIdx, setSuggestionIdx] = useState(0)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestGenRef = useRef(0)

  useEffect(() => {
    if (isOpen) {
      setMode('claude-code')
      setHostId('local')
      setPrompt('')
      setPlanMode(false)
      setUseWorktree(false)
      setCreating(false)
      setErrorMessage(null)
      setSuggestions([])
      setSuggestionIdx(0)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setProjectPath('')
    setRecentPaths([])
    window.atelier
      .listRecentProjectPaths(hostId)
      .then((paths) => {
        if (!cancelled) {
          setRecentPaths(paths)
          setProjectPath(paths[0] ?? '')
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecentPaths([])
          setProjectPath('')
        }
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, hostId])

  function scheduleSuggestions(query: string): void {
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    suggestTimerRef.current = setTimeout(() => {
      const gen = ++suggestGenRef.current
      void window.atelier.suggestProjectPaths(hostId, query).then((items) => {
        if (gen !== suggestGenRef.current) return
        setSuggestions(items)
        setSuggestionIdx(0)
      })
    }, 120)
  }

  useEffect(() => {
    if (!isOpen) return
    scheduleSuggestions(projectPath)
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    }
  }, [isOpen, hostId, projectPath])

  function acceptSuggestion(item: ProjectPathSuggestion): void {
    setProjectPath(item.value)
    setSuggestions([])
    scheduleSuggestions(item.value)
  }

  if (!isOpen) return null

  const trimmedProjectPath = projectPath.trim()
  const isRemote = hostId !== 'local'
  const worktreeRootLabel = worktreeRootFromConfig(config)
  const showSuggestions = suggestions.length > 0

  async function handleCreate(): Promise<void> {
    if (!trimmedProjectPath || creating) return
    setCreating(true)
    setErrorMessage(null)
    try {
      await onCreate({
        projectPath: trimmedProjectPath,
        mode,
        hostId,
        prompt: mode === 'claude-code' && prompt.trim() ? prompt.trim() : undefined,
        planMode: mode === 'claude-code' ? planMode : undefined,
        useWorktree: mode === 'claude-code' ? useWorktree : undefined
      })
      onClose()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
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
          <div className="project-path-field">
            <div className="field-label">Project path</div>
            <input
              className="input"
              style={{ width: '100%' }}
              data-testid="project-path"
              placeholder={isRemote ? '/home/user/code/my-project' : '/Users/you/code/my-project'}
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              onKeyDown={(e) => {
                if (showSuggestions) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setSuggestionIdx((i) => Math.min(i + 1, suggestions.length - 1))
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setSuggestionIdx((i) => Math.max(i - 1, 0))
                    return
                  }
                  if (e.key === 'Tab' || (e.key === 'Enter' && suggestions.length > 0)) {
                    e.preventDefault()
                    const item = suggestions[suggestionIdx]
                    if (item) acceptSuggestion(item)
                    return
                  }
                }
                if (e.key === 'Escape') {
                  setSuggestions([])
                }
              }}
            />
            <datalist id="project-path-history" data-testid="project-path-history">
              {recentPaths.map((path) => (
                <option key={path} value={path} />
              ))}
            </datalist>
            {showSuggestions && (
              <div className="project-path-suggestions" data-testid="project-path-suggestions">
                {suggestions.map((item, i) => (
                  <div
                    key={`${item.kind}:${item.value}`}
                    className={`mention-item${i === suggestionIdx ? ' selected' : ''}`}
                    data-testid={item.kind === 'history' ? 'project-path-suggestion-history' : 'project-path-suggestion-dir'}
                    onMouseDown={(ev) => {
                      ev.preventDefault()
                      acceptSuggestion(item)
                    }}
                    onMouseEnter={() => setSuggestionIdx(i)}
                  >
                    <span className="project-path-suggestion-label">{item.label}</span>
                    {item.kind === 'history' && <span className="project-path-suggestion-tag">Recent</span>}
                  </div>
                ))}
              </div>
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
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 14.5, color: 'var(--text-secondary)' }}>
                <input
                  type="checkbox"
                  data-testid="use-worktree-checkbox"
                  checked={useWorktree}
                  onChange={(e) => setUseWorktree(e.target.checked)}
                />
                <span>
                  Use worktree
                  <span style={{ color: 'var(--text-tertiary)', marginLeft: 4 }}>
                    — isolated copy at {worktreeRootLabel}/&lt;id&gt;
                  </span>
                </span>
              </label>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <div style={{ flex: 1 }}>
            {errorMessage && <div className="modal-error">{errorMessage}</div>}
          </div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            data-testid="start-session-button"
            disabled={!trimmedProjectPath || creating}
            onClick={handleCreate}
          >
            {creating ? 'Starting…' : 'Start Session'}
          </button>
        </div>
      </div>
    </div>
  )
}
