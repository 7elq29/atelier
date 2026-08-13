import { useEffect, useMemo, useRef, useState } from 'react'
import type { CreateSessionOptions, RemoteHostOption, SessionMode } from '../../../shared/session-types'
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

type ProjectSelection =
  | { kind: 'path'; value: string }
  | { kind: 'profile'; profileId: string }

type PickerItem =
  | { kind: 'path'; value: string; label: string }
  | { kind: 'profile'; profile: SessionProfile }
  | { kind: 'directory'; suggestion: ProjectPathSuggestion }

/**
 * New Session dialog (02-session-lifecycle): free-text project path or saved
 * profile (local or remote), Terminal/Claude Code segmented mode, host picker.
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
  const [mode, setMode] = useState<SessionMode>('claude-code')
  const [hostId, setHostId] = useState<string>('local')
  const [prompt, setPrompt] = useState('')
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
    if (!resolvedProjectPath || creating) return
    setCreating(true)
    setErrorMessage(null)
    try {
      await onCreate({
        projectPath: resolvedProjectPath,
        profileId: selectedProfile?.id,
        mode,
        hostId,
        prompt: mode === 'claude-code' && prompt.trim() ? prompt.trim() : undefined,
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
    <div className="modal-backdrop" data-testid="new-session-modal">
      <div className="modal-dialog" style={{ width: 560 }}>
        <div className="modal-header">
          <h2>New Session</h2>
          <button className="btn btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="project-path-field">
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
                  onKeyDown={(e) => {
                    handleEmacsTextareaKeyDown(e, prompt, setPrompt)
                  }}
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
            disabled={!resolvedProjectPath || creating}
            onClick={handleCreate}
          >
            {creating ? 'Starting…' : 'Start Session'}
          </button>
        </div>
      </div>
    </div>
  )
}
