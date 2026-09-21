/**
 * Full-page theme editor rendered in the detached theme-editor BrowserWindow.
 * It fetches the initial theme from the main process, applies live-preview
 * updates to its own <html> (so the editor itself uses the palette being edited),
 * and relays every change back to the main window via IPC.
 */
import { useEffect, useRef, useState } from 'react'
import type { CustomTheme, CustomThemeColors } from '../../../shared/theme-types'
import { TOKEN_GROUPS, TOKEN_CSS_VARS } from '../../../shared/theme-types'

function getBaseTokenValue(cssVar: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim() || '#000000'
}

function applyColors(colors: CustomThemeColors, base: 'light' | 'dark'): void {
  const el = document.documentElement
  el.setAttribute('data-theme', base)
  for (const [key, cssVar] of Object.entries(TOKEN_CSS_VARS)) {
    const val = colors[key as keyof CustomThemeColors]
    if (val) el.style.setProperty(cssVar, val)
    else el.style.removeProperty(cssVar)
  }
}

export default function ThemeEditorWindow(): JSX.Element {
  const [theme, setTheme] = useState<CustomTheme | null>(null)
  const [name, setName] = useState('')
  const [base, setBase] = useState<'light' | 'dark'>('dark')
  const [colors, setColors] = useState<CustomThemeColors>({})
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const originalColors = useRef<CustomThemeColors>({})
  const originalBase = useRef<'light' | 'dark'>('dark')

  useEffect(() => {
    window.atelier.getThemeEditorInitialTheme().then((t) => {
      setTheme(t)
      const initColors = t?.colors ?? {}
      const initBase = t?.base ?? 'dark'
      setName(t?.name ?? '')
      setBase(initBase)
      setColors(initColors)
      originalColors.current = initColors
      originalBase.current = initBase
      applyColors(initColors, initBase)
      setLoading(false)
    })
  }, [])

  function handleColorChange(key: keyof CustomThemeColors, value: string): void {
    const next = { ...colors, [key]: value }
    setColors(next)
    applyColors(next, base)
    window.atelier.themeEditorPreview(next, base)
  }

  function handleBaseChange(next: 'light' | 'dark'): void {
    setBase(next)
    applyColors(colors, next)
    window.atelier.themeEditorPreview(colors, next)
  }

  function handleSave(): void {
    const trimmed = name.trim()
    if (!trimmed) { setError('Name is required.'); return }
    window.atelier.themeEditorSave({
      id: theme?.id ?? crypto.randomUUID(),
      name: trimmed,
      base,
      colors
    })
  }

  function handleCancel(): void {
    applyColors(originalColors.current, originalBase.current)
    window.atelier.themeEditorCancel()
  }

  // Keyboard shortcuts for the popup window. Because this is a separate
  // BrowserWindow from the main app, none of the main window's global
  // shortcut listeners (App.tsx) receive events while this window has focus.
  // We wire them locally so the popup isn't keyboard-dead.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      // Escape — cancel / close (mirrors the main window's modal-close behaviour)
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        handleCancel()
        return
      }
      // Cmd+S (Mac) / Ctrl+S (Win/Linux) — save
      if (e.key === 's' && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors, name, base]) // re-register when save/cancel deps change

  if (loading) {
    return <div style={{ padding: 32, color: 'var(--text-tertiary)', fontFamily: 'var(--font-ui)' }}>Loading…</div>
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      background: 'var(--bg-panel)', color: 'var(--text-primary)',
      fontFamily: 'var(--font-ui)', fontSize: 'var(--text-sm)'
    }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 8,
        flexShrink: 0
      }}>
        <h2 style={{ margin: 0, fontSize: 'var(--text-md)', fontWeight: 600, flex: 1 }}>
          {theme ? 'Edit theme' : 'New theme'}
        </h2>
      </div>

      {/* Body — scrollable */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 18 }}>
        {/* Name */}
        <div>
          <div className="field-label">Name</div>
          <input
            className="input"
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
            <button type="button" className={'btn btn-sm' + (base === 'light' ? ' sel' : '')} onClick={() => handleBaseChange('light')}>Light</button>
            <button type="button" className={'btn btn-sm' + (base === 'dark' ? ' sel' : '')} onClick={() => handleBaseChange('dark')}>Dark</button>
          </div>
          <div className="field-hint">Inherits border and shadow styles. Color tokens below override the base values.</div>
        </div>

        {/* Live preview notice */}
        <div className="theme-live-hint">
          <span className="theme-live-dot" />
          This window uses the palette you're editing — changes apply live.
        </div>

        {/* Token groups */}
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

      {/* Footer */}
      <div style={{
        padding: '12px 20px', borderTop: '1px solid var(--border-subtle)',
        display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0
      }}>
        {theme ? (
          <button type="button" className="btn btn-danger btn-sm" onClick={() => {
            window.atelier.themeEditorDelete(theme.id)
          }}>
            Delete theme
          </button>
        ) : <div />}
        <div style={{ flex: 1 }}>
          {error && <div className="modal-error">{error}</div>}
        </div>
        <button type="button" className="btn" onClick={handleCancel}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={handleSave}>Save</button>
      </div>
    </div>
  )
}
