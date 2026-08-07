import { useState, type MouseEvent } from 'react'
import type { AtelierConfig, VaultConfig } from '../../../shared/config'

interface SettingsPanelProps {
  isOpen: boolean
  onClose: () => void
  config: AtelierConfig
  onUpdate: (partial: Partial<AtelierConfig>) => void
  onReplayOnboarding: () => void
}

type Pane = 'theme' | 'fonts' | 'notifications' | 'vault'

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
  onReplayOnboarding
}: SettingsPanelProps): JSX.Element | null {
  const [pane, setPane] = useState<Pane>('theme')
  const [notifyStatus, setNotifyStatus] = useState<string | null>(null)
  const [vaultEdit, setVaultEdit] = useState<VaultConfig>(() => config.vault)
  const [vaultSaved, setVaultSaved] = useState(false)

  if (!isOpen) return null

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) onClose()
  }

  async function sendTestNotification(): Promise<void> {
    const ok = await window.atelier.debugNotify(
      'Atelier',
      'This is a test notification triggered from Settings.'
    )
    setNotifyStatus(ok ? 'Notification sent.' : 'Notifications are not supported on this platform.')
  }

  async function browseVaultRoot(): Promise<void> {
    const picked = await window.atelier.pickVaultRoot()
    if (picked) setVaultEdit((prev) => ({ ...prev, root: picked }))
  }

  function saveVault(): void {
    onUpdate({ vault: vaultEdit })
    setVaultSaved(true)
    setTimeout(() => setVaultSaved(false), 2000)
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
    </div>
  )
}
