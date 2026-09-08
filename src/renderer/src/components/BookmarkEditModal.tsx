import { useEffect, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import {
  isSupportedBookmarkUrl,
  normalizeBookmarkUrl,
  type AppBookmarkRecord
} from '../../../shared/app-bookmark-types'

export function BookmarkEditModal({
  bookmark,
  onSave,
  onClose
}: {
  /** Existing bookmark to edit, or null when adding a new one. */
  bookmark: AppBookmarkRecord | null
  onSave: (values: { url: string; title: string }) => void
  onClose: () => void
}): JSX.Element {
  const [url, setUrl] = useState(bookmark?.url ?? '')
  const [title, setTitle] = useState(bookmark?.title ?? '')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  function save(): void {
    const normalized = normalizeBookmarkUrl(url)
    if (!normalized) {
      setError('URL is required')
      return
    }
    if (!isSupportedBookmarkUrl(normalized)) {
      setError('Enter an http(s) URL')
      return
    }
    onSave({ url: normalized, title: title.trim() })
  }

  return createPortal(
    <div
      className="modal-backdrop"
      data-testid="bookmark-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal-dialog bookmark-dialog" style={{ width: 560 }}>
        <div className="modal-header">
          <h2>{bookmark ? 'Edit bookmark' : 'Add bookmark'}</h2>
          <button className="btn btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div>
            <div className="field-label">URL</div>
            <input
              className="input bookmark-url-input"
              data-testid="bookmark-url"
              autoFocus
              autoComplete="off"
              placeholder="https://…"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
              }}
            />
          </div>
          <div>
            <div className="field-label">
              Title <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>(optional)</span>
            </div>
            <input
              className="input bookmark-title-input"
              data-testid="bookmark-title"
              autoComplete="off"
              placeholder="Shown in the sidebar — leave blank to show the URL"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
              }}
            />
          </div>
        </div>
        <div className="modal-footer">
          <div style={{ flex: 1 }}>
            {error && (
              <div className="modal-error" data-testid="bookmark-error">
                {error}
              </div>
            )}
          </div>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" data-testid="bookmark-save" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
