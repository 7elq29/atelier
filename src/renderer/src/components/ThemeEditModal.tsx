import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { CustomTheme, CustomThemeColors } from '../../../shared/theme-types'
import { TOKEN_GROUPS, TOKEN_CSS_VARS } from '../../../shared/theme-types'

interface ThemeEditModalProps {
  isOpen: boolean
  theme: CustomTheme | null
  onClose: () => void
  onSave: (theme: CustomTheme) => void
  onDelete?: (id: string) => void
  /** Called on every color change so the app can apply the preview live. */
  onPreview: (colors: CustomThemeColors, base: 'light' | 'dark') => void
}

function getBaseTokenValue(cssVar: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || '#000000'
}

export default function ThemeEditModal({
  isOpen,
  theme,
  onClose,
  onSave,
  onDelete,
  onPreview
}: ThemeEditModalProps): JSX.Element | null {
  const [name, setName] = useState('')
  const [base, setBase] = useState<'light' | 'dark'>('dark')
  const [colors, setColors] = useState<CustomThemeColors>({})
  const [error, setError] = useState<string | null>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  const originalColors = useRef<CustomThemeColors>({})
  const originalBase = useRef<'light' | 'dark'>('dark')
  // Drag state stored in a ref so mouse-move handler never goes stale.
  const drag = useRef({ active: false, startX: 0, startY: 0, startPosX: 0, startPosY: 0 })

  // Reset form + center position when the modal opens.
  useEffect(() => {
    if (!isOpen) return
    const initialColors = theme?.colors ?? {}
    const initialBase = theme?.base ?? 'dark'
    setName(theme?.name ?? '')
    setBase(initialBase)
    setColors(initialColors)
    setError(null)
    originalColors.current = initialColors
    originalBase.current = initialBase
    // Center in the viewport.
    setPos({
      x: Math.max(0, (window.innerWidth - 560) / 2),
      y: Math.max(0, (window.innerHeight - 600) / 2)
    })
  }, [isOpen, theme])

  // Global mouse-move / mouse-up for dragging.
  useEffect(() => {
    function onMove(e: globalThis.MouseEvent): void {
      if (!drag.current.active) return
      setPos({
        x: Math.max(0, drag.current.startPosX + (e.clientX - drag.current.startX)),
        y: Math.max(0, drag.current.startPosY + (e.clientY - drag.current.startY))
      })
    }
    function onUp(): void {
      drag.current.active = false
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  if (!isOpen) return null

  function handleDragStart(e: MouseEvent<HTMLDivElement>): void {
    // Don't start drag when the user clicks a button inside the header.
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    drag.current = { active: true, startX: e.clientX, startY: e.clientY, startPosX: pos.x, startPosY: pos.y }
  }

  function handleColorChange(key: keyof CustomThemeColors, value: string): void {
    const next = { ...colors, [key]: value }
    setColors(next)
    onPreview(next, base)
  }

  function handleBaseChange(next: 'light' | 'dark'): void {
    setBase(next)
    onPreview(colors, next)
  }

  function handleSave(): void {
    const trimmed = name.trim()
    if (!trimmed) { setError('Name is required.'); return }
    onSave({ id: theme?.id ?? crypto.randomUUID(), name: trimmed, base, colors })
  }

  function handleCancel(): void {
    onPreview(originalColors.current, originalBase.current)
    onClose()
  }

  function handleDelete(): void {
    if (theme && onDelete) onDelete(theme.id)
  }

  return (
    // No backdrop — renders directly into the DOM so the app behind is fully visible.
    <div
      className="theme-edit-panel"
      data-testid="theme-edit-modal"
      style={{ left: pos.x, top: pos.y }}
    >
      {/* Draggable header */}
      <div className="modal-header" onMouseDown={handleDragStart}>
        <span className="theme-edit-drag-handle" aria-hidden>⠿</span>
        <h2>{theme ? 'Edit theme' : 'New theme'}</h2>
        <button className="btn btn-icon" onClick={handleCancel} data-testid="theme-edit-close">
          ✕
        </button>
      </div>

      <div className="modal-body">
        {/* Name */}
        <div>
          <div className="field-label">Name</div>
          <input
            className="input"
            data-testid="theme-edit-name-input"
            placeholder="My custom theme"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>

        {/* Base */}
        <div>
          <div className="field-label">Base</div>
          <div className="theme-btns">
            <button
              type="button"
              className={'btn btn-sm' + (base === 'light' ? ' sel' : '')}
              data-testid="theme-edit-base-light"
              onClick={() => handleBaseChange('light')}
            >
              Light
            </button>
            <button
              type="button"
              className={'btn btn-sm' + (base === 'dark' ? ' sel' : '')}
              data-testid="theme-edit-base-dark"
              onClick={() => handleBaseChange('dark')}
            >
              Dark
            </button>
          </div>
          <div className="field-hint">
            Inherits border and shadow styles. Color tokens below override the base values.
          </div>
        </div>

        {/* Live preview notice */}
        <div className="theme-live-hint">
          <span className="theme-live-dot" />
          Changes apply to the app instantly — drag this panel aside to see them.
        </div>

        {/* Color token groups */}
        {TOKEN_GROUPS.map((group) => (
          <div key={group.label} className="token-group">
            <div className="token-group-label">{group.label}</div>
            <div className="token-grid">
              {group.tokens.map(({ key, label, hint }) => {
                const cssVar = TOKEN_CSS_VARS[key]
                const currentValue = colors[key] ?? getBaseTokenValue(cssVar)
                return (
                  <div key={key} className="token-item" title={hint}>
                    <div className="token-swatch" style={{ background: currentValue }}>
                      <input
                        type="color"
                        value={currentValue}
                        data-testid={`theme-color-${key}`}
                        onChange={(e) => handleColorChange(key, e.target.value)}
                        aria-label={label}
                        title={hint}
                      />
                    </div>
                    <div className="token-name">{label}</div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="modal-footer">
        {theme && onDelete ? (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            data-testid="theme-edit-delete-btn"
            onClick={handleDelete}
          >
            Delete theme
          </button>
        ) : (
          <div />
        )}
        <div style={{ flex: 1 }}>
          {error && <div className="modal-error">{error}</div>}
        </div>
        <button type="button" className="btn" onClick={handleCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" data-testid="theme-edit-save-btn" onClick={handleSave}>
          Save
        </button>
      </div>
    </div>
  )
}
