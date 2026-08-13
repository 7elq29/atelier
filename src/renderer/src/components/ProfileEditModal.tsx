import { useEffect, useState } from 'react'
import type { SessionProfile } from '../../../shared/session-profile-types'

interface ProfileEditModalProps {
  isOpen: boolean
  profile: SessionProfile | null
  onClose: () => void
  onSave: (profile: SessionProfile) => void
  onDelete?: (id: string) => void
}

export default function ProfileEditModal({
  isOpen,
  profile,
  onClose,
  onSave,
  onDelete
}: ProfileEditModalProps): JSX.Element | null {
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [fileDirectories, setFileDirectories] = useState<string[]>([''])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setName(profile?.name ?? '')
    setWorkspace(profile?.workspace ?? '')
    setFileDirectories(profile?.fileDirectories.length ? [...profile.fileDirectories] : [''])
    setError(null)
  }, [isOpen, profile])

  if (!isOpen) return null

  async function browseWorkspace(): Promise<void> {
    const picked = await window.atelier.pickProjectFolder()
    if (picked) setWorkspace(picked)
  }

  function updateFileDirectory(index: number, value: string): void {
    setFileDirectories((rows) => rows.map((row, i) => (i === index ? value : row)))
  }

  function removeFileDirectory(index: number): void {
    setFileDirectories((rows) => (rows.length <= 1 ? [''] : rows.filter((_, i) => i !== index)))
  }

  function addFileDirectory(): void {
    setFileDirectories((rows) => [...rows, ''])
  }

  function handleSave(): void {
    const trimmedName = name.trim()
    const trimmedWorkspace = workspace.trim()
    const trimmedDirs = fileDirectories.map((d) => d.trim()).filter(Boolean)
    if (!trimmedName || !trimmedWorkspace) {
      setError('Name and workspace are required.')
      return
    }
    onSave({
      id: profile?.id ?? crypto.randomUUID(),
      name: trimmedName,
      workspace: trimmedWorkspace,
      fileDirectories: trimmedDirs.length ? trimmedDirs : ['src']
    })
  }

  return (
    <div
      className="modal-backdrop profile-edit-backdrop"
      data-testid="profile-edit-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-dialog profile-edit-dialog">
        <div className="modal-header">
          <h2>{profile ? 'Edit profile' : 'Add profile'}</h2>
          <button className="btn btn-icon" onClick={onClose} data-testid="profile-edit-close">
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div>
            <div className="field-label">Name</div>
            <input
              className="input"
              data-testid="profile-edit-name-input"
              placeholder="e.g. Gardenia dev"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="field-label">Workspace location</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="input"
                type="text"
                data-testid="profile-edit-workspace-input"
                value={workspace}
                placeholder="~/code/my-project"
                onChange={(e) => setWorkspace(e.target.value)}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '13.5px' }}
                spellCheck={false}
              />
              <button
                className="btn btn-sm"
                type="button"
                data-testid="profile-edit-browse-btn"
                onClick={() => void browseWorkspace()}
              >
                Browse…
              </button>
            </div>
            <div className="field-hint">Terminal, diff, and agent cwd use this path.</div>
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="field-label">File directories</div>
            <div className="field-hint">
              Relative paths (e.g. <code>src</code>, <code>docs</code>) are resolved from the session workspace — or
              from the worktree when <strong>Use worktree</strong> is checked. Absolute paths (<code>~/…</code>,{' '}
              <code>/…</code>) are used as-is.
            </div>
            <div className="file-dir-list">
              {fileDirectories.map((dir, index) => (
                <div className="file-dir-row" key={index}>
                  <input
                    className="input file-dir-input"
                    value={dir}
                    placeholder="src or ~/absolute/path"
                    onChange={(e) => updateFileDirectory(index, e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-icon btn-sm"
                    title="Remove"
                    onClick={() => removeFileDirectory(index)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={addFileDirectory}>
              + Add directory
            </button>
          </div>
        </div>
        <div className="modal-footer">
          {profile && onDelete ? (
            <button
              type="button"
              className="btn btn-danger btn-sm"
              data-testid="profile-edit-delete-btn"
              onClick={() => onDelete(profile.id)}
            >
              Delete
            </button>
          ) : (
            <div />
          )}
          <div style={{ flex: 1 }}>
            {error && <div className="modal-error">{error}</div>}
          </div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" data-testid="profile-edit-save-btn" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
