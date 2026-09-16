import { useState, useEffect, type MouseEvent } from 'react'
import { APP_DISPLAY_NAME } from '../../../shared/app-brand'
import {
  defaultClaudeModelFromConfig,
  defaultClaudeEffortFromConfig,
  defaultClaudePermissionModeFromConfig,
  DEFAULT_CLAUDE_EFFORT_OPTIONS,
  DEFAULT_CLAUDE_PERMISSION_MODE_OPTIONS,
  type AtelierConfig,
  type VaultConfig
} from '../../../shared/config'
import { worktreeRootFromConfig } from '../../../shared/worktree-path'
import type { EffortLevel, PermissionModeValue } from '../../../shared/session-types'
import type { SessionProfile } from '../../../shared/session-profile-types'
import type { SessionAuthStatusEvent } from '../../../shared/harness-ui-types'
import ProfileEditModal from './ProfileEditModal'

interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
  config: AtelierConfig
  onUpdate: (partial: Partial<AtelierConfig>) => Promise<AtelierConfig>
  onReplayOnboarding: () => void
  authStatus?: SessionAuthStatusEvent | null
  initialPane?: Pane
}

type Pane = 'theme' | 'fonts' | 'notifications' | 'vault' | 'agent' | 'sessions' | 'profiles'

/**
 * Settings modal: theme (system/light/dark, really flips `data-theme` on
 * `<html>`) and three independent font-size scales — terminal, interface,
 * agent message — each its own CSS custom property so they never share a
 * variable and never move together.
 */
export default function SettingsPanel({
  isOpen,
  onClose,
  config,
  onUpdate,
  onReplayOnboarding,
  authStatus = null,
  initialPane
}: SettingsPanelProps): JSX.Element | null {
  const [pane, setPane] = useState<Pane>(initialPane ?? 'theme')
  const [notifyStatus, setNotifyStatus] = useState<string | null>(null)
  const [vaultEdit, setVaultEdit] = useState<VaultConfig>(() => config.vault)
  const [vaultSaved, setVaultSaved] = useState(false)
  const [defaultModelEdit, setDefaultModelEdit] = useState(() => defaultClaudeModelFromConfig(config))
  const [defaultEffortEdit, setDefaultEffortEdit] = useState<EffortLevel>(() => defaultClaudeEffortFromConfig(config))
  const [defaultPermissionModeEdit, setDefaultPermissionModeEdit] = useState<PermissionModeValue>(() =>
    defaultClaudePermissionModeFromConfig(config)
  )
  const [defaultModelError, setDefaultModelError] = useState<string | null>(null)
  const [defaultModelValidating, setDefaultModelValidating] = useState(false)
  const [defaultModelSaved, setDefaultModelSaved] = useState(false)
  const [worktreeRootEdit, setWorktreeRootEdit] = useState(() => worktreeRootFromConfig(config))
  const [worktreeRootSaved, setWorktreeRootSaved] = useState(false)
  const [vaultRootFromEnv, setVaultRootFromEnv] = useState(false)
  const [profileEditOpen, setProfileEditOpen] = useState(false)
  const [editingProfile, setEditingProfile] = useState<SessionProfile | null>(null)

  useEffect(() => {
    setDefaultModelEdit(defaultClaudeModelFromConfig(config))
  }, [config.defaultClaudeModel])

  useEffect(() => {
    setDefaultEffortEdit(defaultClaudeEffortFromConfig(config))
  }, [config.defaultClaudeEffort])

  useEffect(() => {
    setDefaultPermissionModeEdit(defaultClaudePermissionModeFromConfig(config))
  }, [config.defaultClaudePermissionMode])

  useEffect(() => {
    setWorktreeRootEdit(worktreeRootFromConfig(config))
  }, [config.worktreeRoot])

  useEffect(() => {
    if (!isOpen || !initialPane) return
    setPane(initialPane)
  }, [isOpen, initialPane])

  /** Load saved vault fields when the modal opens — not on every config touch (avoids wiping unsaved edits). */
  useEffect(() => {
    if (!isOpen) return
    setVaultEdit(config.vault)
    setVaultSaved(false)
  }, [isOpen, config.vault.root, config.vault.dailyNotesFolder, config.vault.appNotesFolder, config.vault.notePathPattern, config.vault.templatePath])

  useEffect(() => {
    if (!isOpen || pane !== 'vault') return
    void window.atelier.isVaultRootFromEnv().then(setVaultRootFromEnv)
  }, [isOpen, pane])

  if (!isOpen) return null

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) onClose()
  }

  async function sendTestNotification(): Promise<void> {
    const ok = await window.atelier.debugNotify(
      APP_DISPLAY_NAME,
      'This is a test notification triggered from Settings.'
    )
    setNotifyStatus(ok ? 'Notification sent.' : 'Notifications are not supported on this platform.')
  }

  async function browseVaultRoot(): Promise<void> {
    const picked = await window.atelier.pickVaultRoot()
    if (picked) setVaultEdit((prev) => ({ ...prev, root: picked }))
  }

  async function saveVault(): Promise<void> {
    const saved = await onUpdate({ vault: vaultEdit })
    setVaultEdit(saved.vault)
    setVaultSaved(true)
    setTimeout(() => setVaultSaved(false), 2000)
  }

  async function saveDefaultModel(): Promise<void> {
    const trimmed = defaultModelEdit.trim()
    if (!trimmed) {
      setDefaultModelError('Enter a model id.')
      return
    }
    setDefaultModelValidating(true)
    setDefaultModelError(null)
    const result = await window.atelier.validateClaudeModel(trimmed)
    setDefaultModelValidating(false)
    if (!result.ok) {
      setDefaultModelError(result.error)
      return
    }
    onUpdate({
      defaultClaudeModel: trimmed,
      defaultClaudeEffort: defaultEffortEdit,
      defaultClaudePermissionMode: defaultPermissionModeEdit
    })
    setDefaultModelSaved(true)
    setTimeout(() => setDefaultModelSaved(false), 2000)
  }

  function saveWorktreeRoot(): void {
    onUpdate({ worktreeRoot: worktreeRootEdit.trim() || '~/.atelier/worktrees' })
    setWorktreeRootSaved(true)
    setTimeout(() => setWorktreeRootSaved(false), 2000)
  }

  function openProfileEdit(profile: SessionProfile | null): void {
    setEditingProfile(profile)
    setProfileEditOpen(true)
  }

  async function saveProfile(profile: SessionProfile): Promise<void> {
    const existing = config.sessionProfiles ?? []
    const next = existing.some((p) => p.id === profile.id)
      ? existing.map((p) => (p.id === profile.id ? profile : p))
      : [...existing, profile]
    await onUpdate({ sessionProfiles: next })
    setProfileEditOpen(false)
    setEditingProfile(null)
  }

  async function deleteProfile(id: string): Promise<void> {
    const next = (config.sessionProfiles ?? []).filter((p) => p.id !== id)
    await onUpdate({ sessionProfiles: next })
    setProfileEditOpen(false)
    setEditingProfile(null)
  }

  return (
    <div className="modal-backdrop" data-testid="settings-backdrop" onClick={handleBackdropClick}>
      <div className="modal-dialog settings-dialog" data-testid="settings-panel">
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="btn btn-icon" onClick={onClose} data-testid="settings-close">
            ✕
          </button>
        </div>
        <div className="modal-body settings-body">
          <div className="settings-nav">
            <button className={pane === 'theme' ? 'active' : ''} onClick={() => setPane('theme')}>
              Theme
            </button>
            <button className={pane === 'fonts' ? 'active' : ''} onClick={() => setPane('fonts')}>
              Fonts
            </button>
            <button className={pane === 'notifications' ? 'active' : ''} onClick={() => setPane('notifications')}>
              Notifications
            </button>
            <button className={pane === 'vault' ? 'active' : ''} onClick={() => setPane('vault')}>
              Vault
            </button>
            <button className={pane === 'agent' ? 'active' : ''} onClick={() => setPane('agent')}>
              Agent
            </button>
            <button
              className={pane === 'sessions' ? 'active' : ''}
              data-testid="settings-nav-sessions"
              onClick={() => setPane('sessions')}
            >
              Sessions
            </button>
            <button
              className={pane === 'profiles' ? 'active' : ''}
              data-testid="settings-nav-profiles"
              onClick={() => setPane('profiles')}
            >
              Session profiles
            </button>
            <button
              onClick={onReplayOnboarding}
              data-testid="replay-onboarding-button"
              style={{ marginTop: 'auto', color: 'var(--text-tertiary)' }}
            >
              ↻ Replay onboarding
            </button>
          </div>

          {pane === 'theme' && (
            <div className="settings-pane active" data-testid="settings-pane-theme">
              <div className="setting-row">
                <div>
                  <div className="stitle">Appearance</div>
                  <div className="ssub">System, light, or dark</div>
                </div>
                <div className="theme-btns">
                  <button
                    className={'btn btn-sm' + (config.theme === 'light' ? ' sel' : '')}
                    data-testid="theme-light-btn"
                    onClick={() => onUpdate({ theme: 'light' })}
                  >
                    Light
                  </button>
                  <button
                    className={'btn btn-sm' + (config.theme === 'dark' ? ' sel' : '')}
                    data-testid="theme-dark-btn"
                    onClick={() => onUpdate({ theme: 'dark' })}
                  >
                    Dark
                  </button>
                  <button
                    className={'btn btn-sm' + (config.theme === 'system' ? ' sel' : '')}
                    data-testid="theme-system-btn"
                    onClick={() => onUpdate({ theme: 'system' })}
                  >
                    System
                  </button>
                </div>
              </div>
            </div>
          )}

          {pane === 'fonts' && (
            <div className="settings-pane active" data-testid="settings-pane-fonts">
              <div className="setting-row">
                <div className="stitle">Terminal font size</div>
                <input
                  type="range"
                  min={10}
                  max={20}
                  step={0.5}
                  value={config.fontSizes.terminal}
                  data-testid="font-terminal-slider"
                  onChange={(e) =>
                    onUpdate({ fontSizes: { ...config.fontSizes, terminal: Number(e.target.value) } })
                  }
                />
              </div>
              <div className="setting-row">
                <div className="stitle">Interface font size</div>
                <input
                  type="range"
                  min={10}
                  max={18}
                  step={0.5}
                  value={config.fontSizes.interface}
                  data-testid="font-interface-slider"
                  onChange={(e) =>
                    onUpdate({ fontSizes: { ...config.fontSizes, interface: Number(e.target.value) } })
                  }
                />
              </div>
              <div className="setting-row">
                <div className="stitle">Agent message font size</div>
                <input
                  type="range"
                  min={10}
                  max={18}
                  step={0.5}
                  value={config.fontSizes.agentMessage}
                  data-testid="font-agent-message-slider"
                  onChange={(e) =>
                    onUpdate({ fontSizes: { ...config.fontSizes, agentMessage: Number(e.target.value) } })
                  }
                />
              </div>
            </div>
          )}

          {pane === 'notifications' && (
            <div className="settings-pane active" data-testid="settings-pane-notifications">
              <div className="setting-row">
                <div>
                  <div className="stitle">Desktop notifications</div>
                  <div className="ssub">
                    Native OS notification when a session needs attention or finishes
                  </div>
                </div>
              </div>
              <button className="btn btn-sm" data-testid="debug-notify-button" onClick={sendTestNotification}>
                Simulate a notification
              </button>
              {notifyStatus && (
                <div className="field-hint" data-testid="notify-status">
                  {notifyStatus}
                </div>
              )}
            </div>
          )}

          {pane === 'agent' && (
            <div className="settings-pane active" data-testid="settings-pane-agent">
              {authStatus?.message && (
                <div className="settings-auth-notice" data-testid="settings-auth-notice" style={{ marginBottom: 16 }}>
                  <span className="settings-auth-notice-label">Auth</span>
                  <span>{authStatus.message}</span>
                </div>
              )}
              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
                <div>
                  <div className="stitle">Default model</div>
                  <div className="ssub">
                    Used when new agent sessions are created. Any model id the SDK accepts — not only the composer
                    picker list.
                  </div>
                </div>
                <input
                  className="input"
                  type="text"
                  data-testid="default-claude-model-input"
                  value={defaultModelEdit}
                  onChange={(e) => {
                    setDefaultModelEdit(e.target.value)
                    setDefaultModelError(null)
                  }}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '13.5px' }}
                  spellCheck={false}
                />
                {defaultModelError && (
                  <div className="field-hint" data-testid="default-claude-model-error" style={{ color: 'var(--danger)' }}>
                    {defaultModelError}
                  </div>
                )}
                <div>
                  <div className="stitle">Default effort</div>
                  <div className="ssub">Reasoning effort for new agent sessions (SDK `effort`).</div>
                </div>
                <select
                  className="input"
                  data-testid="default-claude-effort-select"
                  value={defaultEffortEdit}
                  onChange={(e) => setDefaultEffortEdit(e.target.value as EffortLevel)}
                  style={{ width: '100%', fontSize: '13.5px' }}
                >
                  {DEFAULT_CLAUDE_EFFORT_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <div>
                  <div className="stitle">Default mode</div>
                  <div className="ssub">
                    Permission mode for new Claude Code sessions (same as the composer mode pill).
                  </div>
                </div>
                <select
                  className="input"
                  data-testid="default-claude-permission-mode-select"
                  value={defaultPermissionModeEdit}
                  onChange={(e) => setDefaultPermissionModeEdit(e.target.value as PermissionModeValue)}
                  style={{ width: '100%', fontSize: '13.5px' }}
                >
                  {DEFAULT_CLAUDE_PERMISSION_MODE_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <button
                    className="btn btn-sm btn-primary"
                    data-testid="default-claude-model-save-btn"
                    onClick={() => void saveDefaultModel()}
                    disabled={defaultModelValidating}
                  >
                    {defaultModelValidating ? 'Validating…' : 'Save'}
                  </button>
                  {defaultModelSaved && (
                    <span className="field-hint" data-testid="default-claude-model-save-status">
                      Saved.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {pane === 'sessions' && (
            <div className="settings-pane active" data-testid="settings-pane-sessions">
              <div>
                <div className="field-label">Default worktree location</div>
                <input
                  className="input"
                  type="text"
                  data-testid="worktree-root-input"
                  value={worktreeRootEdit}
                  placeholder="~/.atelier/worktrees"
                  onChange={(e) => setWorktreeRootEdit(e.target.value)}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '13.5px' }}
                  spellCheck={false}
                />
                <div className="field-hint">
                  Parent folder for <strong>Use worktree</strong> sessions. Each session gets its own subdirectory named
                  with the session id. Supports <code>~</code> on local and remote hosts.
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '10px' }}>
                  <button
                    className="btn btn-sm btn-primary"
                    data-testid="worktree-root-save-btn"
                    onClick={saveWorktreeRoot}
                  >
                    Save
                  </button>
                  {worktreeRootSaved && (
                    <span className="field-hint" data-testid="worktree-root-save-status">
                      Saved.
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {pane === 'profiles' && (
            <div className="settings-pane active" data-testid="settings-pane-profiles">
              <div className="field-hint" style={{ marginBottom: 12 }}>
                Profiles bundle a workspace (terminal, diff, harness cwd) with extra directories shown in the Files
                tab and file quick open.
              </div>
              <div className="profile-list">
                {(config.sessionProfiles ?? []).map((profile) => (
                  <div className="profile-row" key={profile.id} data-testid={`profile-row-${profile.id}`}>
                    <div className="profile-row-main">
                      <div className="profile-row-name">{profile.name}</div>
                      <div className="profile-row-meta">
                        {profile.workspace} · {profile.fileDirectories.length} file dir
                        {profile.fileDirectories.length === 1 ? '' : 's'}
                      </div>
                    </div>
                    <div className="profile-row-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-testid={`profile-edit-btn-${profile.id}`}
                        onClick={() => openProfileEdit(profile)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        data-testid={`profile-delete-btn-${profile.id}`}
                        onClick={() => void deleteProfile(profile.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginTop: 12 }}
                data-testid="profile-add-btn"
                onClick={() => openProfileEdit(null)}
              >
                + Add profile
              </button>
            </div>
          )}

          {pane === 'vault' && (
            <div className="settings-pane active" data-testid="settings-pane-vault">
              <div>
                <div className="field-label">Vault root</div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <input
                    className="input"
                    type="text"
                    data-testid="vault-root-input"
                    value={vaultEdit.root}
                    placeholder="Not configured"
                    onChange={(e) => setVaultEdit((prev) => ({ ...prev, root: e.target.value }))}
                    style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '13.5px' }}
                  />
                  <button className="btn btn-sm" data-testid="vault-browse-btn" onClick={browseVaultRoot}>
                    Browse…
                  </button>
                </div>
                <div className="field-hint">Absolute path to your Obsidian vault.</div>
                {vaultRootFromEnv ? (
                  <div className="field-hint" data-testid="vault-env-override-hint" style={{ color: 'var(--warning)' }}>
                    ATELIER_VAULT_ROOT is set in your shell and overrides this saved path for daily and weekly notes.
                    Settings still stores the path below for when the env var is unset.
                  </div>
                ) : null}
              </div>
              <div>
                <div className="field-label">Daily notes folder</div>
                <input
                  className="input"
                  type="text"
                  data-testid="vault-daily-folder-input"
                  value={vaultEdit.dailyNotesFolder}
                  onChange={(e) => setVaultEdit((prev) => ({ ...prev, dailyNotesFolder: e.target.value }))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '13.5px' }}
                />
                <div className="field-hint">Folder inside the vault root where daily notes live.</div>
              </div>
              <div>
                <div className="field-label">Atelier notes folder</div>
                <input
                  className="input"
                  type="text"
                  data-testid="vault-app-notes-folder-input"
                  value={vaultEdit.appNotesFolder}
                  onChange={(e) => setVaultEdit((prev) => ({ ...prev, appNotesFolder: e.target.value }))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '13.5px' }}
                />
                <div className="field-hint">
                  Folder inside the vault root for Markdown notes tagged <code>atelier</code>.
                </div>
              </div>
              <div>
                <div className="field-label">Note path pattern</div>
                <input
                  className="input"
                  type="text"
                  data-testid="vault-note-pattern-input"
                  value={vaultEdit.notePathPattern}
                  onChange={(e) => setVaultEdit((prev) => ({ ...prev, notePathPattern: e.target.value }))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '13.5px' }}
                />
                <div className="field-hint">
                  Relative to the daily notes folder. Tokens: {'{yyyy}'} year, {'{MMM}'} month abbrev,{' '}
                  {'{ww}'} ISO week, {'{date}'} full date.
                </div>
              </div>
              <div>
                <div className="field-label">Template path</div>
                <input
                  className="input"
                  type="text"
                  data-testid="vault-template-input"
                  value={vaultEdit.templatePath}
                  onChange={(e) => setVaultEdit((prev) => ({ ...prev, templatePath: e.target.value }))}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '13.5px' }}
                />
                <div className="field-hint">
                  Vault-relative path to the daily note template. Leave blank to use the built-in skeleton.
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <button className="btn btn-sm btn-primary" data-testid="vault-save-btn" onClick={saveVault}>
                  Save
                </button>
                {vaultSaved && (
                  <span className="field-hint" data-testid="vault-save-status">
                    Saved.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <ProfileEditModal
        isOpen={profileEditOpen}
        profile={editingProfile}
        onClose={() => {
          setProfileEditOpen(false)
          setEditingProfile(null)
        }}
        onSave={(profile) => void saveProfile(profile)}
        onDelete={editingProfile ? (id) => void deleteProfile(id) : undefined}
      />
    </div>
  )
}
