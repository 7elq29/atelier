import { useEffect, useMemo, useRef, useState } from 'react'
import type { CreateSessionOptions, MinionRepo, RemoteHostOption, SessionMode } from '../../../shared/session-types'
import { parseMinionTaskId } from '../../../shared/session-types'
import type { ProjectPathSuggestion } from '../../../shared/project-path-autocomplete'
import { historyMatchesQuery } from '../../../shared/project-path-autocomplete'
import { filterSessionProfiles } from '../../../shared/session-profile-resolve'
import type { SessionProfile } from '../../../shared/session-profile-types'
import { worktreeRootFromConfig } from '../../../shared/worktree-path'
import type { AtelierConfig } from '../../../shared/config'
import { handleEmacsTextareaKeyDown } from '../palette-input-keys'

interface NewSessionModalProps {
  isOpen: boolean
  hosts: RemoteHostOption[]
  config: AtelierConfig
  onClose: () => void
  onCreate: (opts: CreateSessionOptions) => Promise<void>
  onManageProfiles?: () => void
}

const MINION_REPOS: MinionRepo[] = ['go-code', 'java-code', 'android-code', 'web-code', 'ios-code', 'uber-one', 'ml-code']

type AgentMode = Exclude<SessionMode, 'terminal'>

const AGENT_MODES: Array<{ id: AgentMode; title: string; sub: string }> = [
  { id: 'claude-code', title: 'Claude Code', sub: 'Agent in a project' },
  { id: 'cortana', title: 'Cortana', sub: 'Personal assistant' },
  { id: 'minion', title: 'Minion', sub: 'Remote DevPod task' }
]

type ProjectSelection =
  | { kind: 'path'; value: string }
  | { kind: 'profile'; profileId: string }

type PickerItem =
  | { kind: 'path'; value: string; label: string }
  | { kind: 'profile'; profile: SessionProfile }
  | { kind: 'directory'; suggestion: ProjectPathSuggestion }

/**
 * New Session dialog — type rail + conditional panel (mock: #modal-new-session).
 * Terminal is not offered here (sidebar / palette / companion Terminal).
 */
export default function NewSessionModal({
  isOpen,
  hosts,
  config,
  onClose,
  onCreate,
  onManageProfiles
}: NewSessionModalProps): JSX.Element | null {
  const [selection, setSelection] = useState<ProjectSelection>({ kind: 'path', value: '' })
  const [mode, setMode] = useState<AgentMode>('claude-code')
  const [hostId, setHostId] = useState<string>('local')
  const [prompt, setPrompt] = useState('')
  const [minionRepo, setMinionRepo] = useState<MinionRepo>('go-code')
  const [minionAttachLink, setMinionAttachLink] = useState('')
  const [useWorktree, setUseWorktree] = useState(false)
  const [creating, setCreating] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [recentPaths, setRecentPaths] = useState<string[]>([])
  const [directorySuggestions, setDirectorySuggestions] = useState<ProjectPathSuggestion[]>([])
  const [pickerIdx, setPickerIdx] = useState(0)
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const suggestGenRef = useRef(0)

  const profiles = config.sessionProfiles ?? []
  const selectedProfile =
    selection.kind === 'profile' ? profiles.find((profile) => profile.id === selection.profileId) ?? null : null
  const pathQuery = selection.kind === 'path' ? selection.value : ''
  const isRemote = hostId !== 'local'
  const worktreeRootLabel = worktreeRootFromConfig(config)

  useEffect(() => {
    if (isOpen) {
      setMode('claude-code')
      setHostId('local')
      setPrompt('')
      setMinionRepo('go-code')
      setMinionAttachLink('')
      setUseWorktree(false)
      setCreating(false)
      setErrorMessage(null)
      setDirectorySuggestions([])
      setPickerIdx(0)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setSelection({ kind: 'path', value: '' })
    setRecentPaths([])
    window.atelier
      .listRecentProjectPaths(hostId)
      .then((paths) => {
        if (!cancelled) {
          setRecentPaths(paths)
          setSelection({ kind: 'path', value: paths[0] ?? '' })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecentPaths([])
          setSelection({ kind: 'path', value: '' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [isOpen, hostId])

  function scheduleDirectorySuggestions(query: string): void {
    if (selection.kind === 'profile') {
      setDirectorySuggestions([])
      return
    }
    if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    suggestTimerRef.current = setTimeout(() => {
      const gen = ++suggestGenRef.current
      void window.atelier.suggestProjectPaths(hostId, query).then((items) => {
        if (gen !== suggestGenRef.current) return
        setDirectorySuggestions(items.filter((item) => item.kind === 'directory'))
        setPickerIdx(0)
      })
    }, 120)
  }

  useEffect(() => {
    if (!isOpen) return
    scheduleDirectorySuggestions(pathQuery)
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current)
    }
  }, [isOpen, hostId, pathQuery, selection.kind])

  const filteredRecentPaths = useMemo(
    () => recentPaths.filter((path) => historyMatchesQuery(path, pathQuery)),
    [recentPaths, pathQuery]
  )
  const filteredProfiles = useMemo(
    () => filterSessionProfiles(profiles, pathQuery),
    [profiles, pathQuery]
  )

  const pickerItems = useMemo((): PickerItem[] => {
    const items: PickerItem[] = []
    for (const path of filteredRecentPaths) {
      items.push({ kind: 'path', value: path, label: path })
    }
    for (const suggestion of directorySuggestions) {
      items.push({ kind: 'directory', suggestion })
    }
    for (const profile of filteredProfiles) {
      items.push({ kind: 'profile', profile })
    }
    return items
  }, [filteredRecentPaths, directorySuggestions, filteredProfiles])

  useEffect(() => {
    if (pickerIdx >= pickerItems.length) setPickerIdx(0)
  }, [pickerIdx, pickerItems.length])

  if (!isOpen) return null

  const agentOnly = mode === 'cortana' || mode === 'minion'
  const minionAttachTaskId = mode === 'minion' ? parseMinionTaskId(minionAttachLink) : null
  const minionCanStart =
    mode !== 'minion' || Boolean(minionAttachTaskId) || Boolean(prompt.trim())
  const resolvedProjectPath = selectedProfile?.workspace ?? pathQuery.trim()
  const showPicker = pickerItems.length > 0 || profiles.length > 0 || onManageProfiles != null

  function selectPath(path: string): void {
    setSelection({ kind: 'path', value: path })
    setDirectorySuggestions([])
    scheduleDirectorySuggestions(path)
  }

  function selectProfile(profileId: string): void {
    setSelection({ kind: 'profile', profileId })
    setDirectorySuggestions([])
  }

  function acceptPickerItem(item: PickerItem): void {
    if (item.kind === 'path') selectPath(item.value)
    else if (item.kind === 'directory') selectPath(item.suggestion.value)
    else selectProfile(item.profile.id)
  }

  async function handleCreate(): Promise<void> {
    if (!agentOnly && !resolvedProjectPath) return
    if (mode === 'minion' && !minionCanStart) return
    if (creating) return
    setCreating(true)
    setErrorMessage(null)
    try {
      const attachTaskId = mode === 'minion' ? parseMinionTaskId(minionAttachLink) : null
      if (mode === 'minion' && minionAttachLink.trim() && !attachTaskId) {
        throw new Error('Paste a Minion link with taskId=… or a bare task UUID.')
      }
      await onCreate({
        projectPath: agentOnly ? '' : resolvedProjectPath!,
        profileId: agentOnly ? undefined : selectedProfile?.id,
        mode,
        hostId: agentOnly ? 'local' : hostId,
        prompt:
          mode === 'minion' && !attachTaskId && prompt.trim() ? prompt.trim() : undefined,
        minion:
          mode === 'minion'
            ? {
                repo: minionRepo,
                runner: 'devpod',
                ...(attachTaskId ? { attachTaskId } : {})
              }
            : undefined,
        useWorktree: mode === 'claude-code' ? useWorktree : undefined
      })
      onClose()
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const projectPicker = (
    <div className="project-path-field project-field">
      <div className="field-label">Project</div>
      <input
        className={'input project-path-input' + (selectedProfile ? ' profile-selected' : '')}
        style={{ width: '100%' }}
        data-testid="project-path"
        placeholder={isRemote ? '/home/user/code/my-project' : '/Users/you/code/my-project'}
        value={selectedProfile ? selectedProfile.name : pathQuery}
        onChange={(e) => {
          setSelection({ kind: 'path', value: e.target.value })
          scheduleDirectorySuggestions(e.target.value)
        }}
        onKeyDown={(e) => {
          if (showPicker && pickerItems.length > 0) {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setPickerIdx((i) => Math.min(i + 1, pickerItems.length - 1))
              return
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setPickerIdx((i) => Math.max(i - 1, 0))
              return
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && pickerItems.length > 0)) {
              e.preventDefault()
              const item = pickerItems[pickerIdx]
              if (item) acceptPickerItem(item)
              return
            }
          }
        }}
      />
      {showPicker && (
        <div className="project-path-suggestions" data-testid="project-path-suggestions">
          {filteredRecentPaths.length > 0 && (
            <div className="project-picker-section">Recent paths</div>
          )}
          {filteredRecentPaths.map((path) => {
            const idx = pickerItems.findIndex((item) => item.kind === 'path' && item.value === path)
            const selected =
              selection.kind === 'path' && selection.value === path ? ' selected' : ''
            return (
              <div
                key={`path:${path}`}
                className={`mention-item project-picker-item${selected}${idx === pickerIdx ? ' selected' : ''}`}
                data-testid="project-path-suggestion-history"
                onMouseDown={(ev) => {
                  ev.preventDefault()
                  selectPath(path)
                }}
                onMouseEnter={() => setPickerIdx(idx)}
              >
                <span className="project-path-suggestion-label">{path}</span>
                <span className="project-path-suggestion-tag">Recent</span>
              </div>
            )
          })}
          {directorySuggestions.map((suggestion) => {
            const idx = pickerItems.findIndex(
              (item) => item.kind === 'directory' && item.suggestion.value === suggestion.value
            )
            return (
              <div
                key={`dir:${suggestion.value}`}
                className={`mention-item project-picker-item${idx === pickerIdx ? ' selected' : ''}`}
                data-testid="project-path-suggestion-dir"
                onMouseDown={(ev) => {
                  ev.preventDefault()
                  selectPath(suggestion.value)
                }}
                onMouseEnter={() => setPickerIdx(idx)}
              >
                <span className="project-path-suggestion-label">{suggestion.label}</span>
              </div>
            )
          })}
          {profiles.length > 0 && <div className="project-picker-section">Profiles</div>}
          {filteredProfiles.map((profile) => {
            const idx = pickerItems.findIndex(
              (item) => item.kind === 'profile' && item.profile.id === profile.id
            )
            const selected =
              selection.kind === 'profile' && selection.profileId === profile.id ? ' selected' : ''
            return (
              <div
                key={`profile:${profile.id}`}
                className={`mention-item project-picker-item${selected}${idx === pickerIdx ? ' selected' : ''}`}
                data-testid={`project-path-suggestion-profile-${profile.id}`}
                onMouseDown={(ev) => {
                  ev.preventDefault()
                  selectProfile(profile.id)
                }}
                onMouseEnter={() => setPickerIdx(idx)}
              >
                <span className="project-path-suggestion-label">{profile.name}</span>
                <span className="project-path-suggestion-sub">{profile.workspace}</span>
                <span className="project-path-suggestion-tag profile">Profile</span>
              </div>
            )
          })}
          {filteredProfiles.length === 0 && profiles.length > 0 && pathQuery.trim() && (
            <div className="project-picker-empty">No matching profiles</div>
          )}
          {onManageProfiles && (
            <div className="project-picker-footer">
              <button
                type="button"
                className="project-picker-manage"
                data-testid="project-path-manage-profiles"
                onMouseDown={(ev) => {
                  ev.preventDefault()
                  onManageProfiles()
                }}
              >
                Manage profiles…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="modal-backdrop" data-testid="new-session-modal" id="new-session-modal">
      <div className="modal-dialog new-session-dialog">
        <div className="modal-header">
          <h2>New Session</h2>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body new-session-body">
          <nav className="ns-rail" data-testid="mode-cards" aria-label="Session type">
            <div className="ns-rail-label">Type</div>
            {AGENT_MODES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={'ns-rail-item' + (mode === item.id ? ' selected' : '')}
                data-testid={`mode-${item.id}`}
                onClick={() => setMode(item.id)}
              >
                <span className="ns-rail-title">{item.title}</span>
                <span className="ns-rail-sub">{item.sub}</span>
              </button>
            ))}
          </nav>

          {mode === 'claude-code' && (
            <div className="ns-panel" data-testid="panel-claude">
              <p className="ns-panel-lead">
                Runs Claude Code against a project on the host you choose. Terminals stay on the
                sidebar / companion Terminal.
              </p>
              {projectPicker}
              <div>
                <div className="field-label">Host</div>
                <div className="host-options">
                  <label className={'host-option' + (hostId === 'local' ? ' selected' : '')}>
                    <input
                      type="radio"
                      name="host"
                      checked={hostId === 'local'}
                      onChange={() => setHostId('local')}
                    />
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
                      <input
                        type="radio"
                        name="host"
                        checked={hostId === host.id}
                        onChange={() => setHostId(host.id)}
                      />
                      <div className="host-option-main">
                        <div className="host-title">{host.label}</div>
                        <div className="host-sub">{host.sshHost}</div>
                      </div>
                      <span className={'status-chip ' + host.status}>{host.status}</span>
                    </label>
                  ))}
                </div>
              </div>
              <label className="toggle-row">
                <div>
                  <div className="toggle-title">Use worktree</div>
                  <div className="toggle-sub">
                    Isolated copy at {worktreeRootLabel}/&lt;id&gt;
                  </div>
                </div>
                <span className="switch">
                  <input
                    type="checkbox"
                    data-testid="use-worktree-checkbox"
                    checked={useWorktree}
                    onChange={(e) => setUseWorktree(e.target.checked)}
                  />
                  <span className="track" aria-hidden="true" />
                </span>
              </label>
            </div>
          )}

          {mode === 'cortana' && (
            <div className="ns-panel" data-testid="panel-cortana">
              <p className="ns-panel-lead">
                Starts Cortana on this machine. No project path required — open the session and chat
                from the composer.
              </p>
            </div>
          )}

          {mode === 'minion' && (
            <div className="ns-panel" data-testid="panel-minion">
              <p className="ns-panel-lead">
                Create a new Minion DevPod task, or attach an existing one via link / task UUID.
              </p>
              <div>
                <div className="field-label">Repository</div>
                <select
                  className="input"
                  style={{ width: '100%' }}
                  data-testid="minion-repo"
                  value={minionRepo}
                  onChange={(e) => setMinionRepo(e.target.value as MinionRepo)}
                  disabled={Boolean(minionAttachTaskId)}
                >
                  {MINION_REPOS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <div className="field-label">
                  Attach existing task{' '}
                  <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span>
                </div>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  data-testid="minion-attach-link"
                  placeholder="https://minion.uberinternal.com/v2?taskId=…"
                  value={minionAttachLink}
                  onChange={(e) => setMinionAttachLink(e.target.value)}
                />
                {minionAttachLink.trim() && !minionAttachTaskId && (
                  <div className="field-hint" style={{ marginTop: 6 }}>
                    Need a Minion URL with <code>taskId=</code> or a bare UUID.
                  </div>
                )}
                {minionAttachTaskId && (
                  <div className="field-hint" style={{ marginTop: 6 }} data-testid="minion-attach-parsed">
                    Will attach to <code>{minionAttachTaskId}</code>
                  </div>
                )}
                {!minionAttachTaskId && (
                  <div className="field-hint" style={{ marginTop: 6 }}>
                    Paste a Minion URL with taskId=… or a bare task UUID. Attach skips creating a new
                    task.
                  </div>
                )}
              </div>
              <div>
                <div className="field-label">Task prompt</div>
                <div className="prompt-box">
                  <textarea
                    data-testid="initial-prompt"
                    placeholder={
                      minionAttachTaskId
                        ? 'Optional note — attach does not create a new task'
                        : 'Describe the task for Minion…'
                    }
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    onKeyDown={(e) => {
                      handleEmacsTextareaKeyDown(e, prompt, setPrompt)
                    }}
                    disabled={Boolean(minionAttachTaskId)}
                  />
                </div>
                <div className="field-hint" style={{ marginTop: 6 }}>
                  Required to create a new task. Not needed when attaching.
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <div style={{ flex: 1 }}>
            {errorMessage && <div className="modal-error">{errorMessage}</div>}
            {creating && mode === 'minion' && !errorMessage && (
              <div className="modal-hint" data-testid="minion-starting-hint">
                {minionAttachTaskId
                  ? 'Attaching to Minion task…'
                  : 'Starting Minion… DevPod setup can take a minute.'}
              </div>
            )}
          </div>
          <button className="btn" onClick={onClose} disabled={creating && mode === 'minion'}>
            Cancel
          </button>
          <button
            className="btn btn-start"
            data-testid="start-session-button"
            disabled={(!agentOnly && !resolvedProjectPath) || !minionCanStart || creating}
            onClick={handleCreate}
          >
            {creating
              ? mode === 'minion'
                ? minionAttachTaskId
                  ? 'Attaching…'
                  : 'Starting Minion…'
                : 'Starting…'
              : mode === 'minion' && minionAttachTaskId
                ? 'Attach Session'
                : 'Start Session'}
          </button>
        </div>
      </div>
    </div>
  )
}
