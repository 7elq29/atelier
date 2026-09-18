import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'

export interface PaletteItem {
  id: string
  label: string
  category: string
  run: () => void
}

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  items: PaletteItem[]
  placeholder?: string
}

/**
 * Keyboard-driven command palette overlay (⌘K on macOS). Filters `items`
 * as-you-type (command labels and session names). Arrow keys move selection,
 * Enter runs the selected item and closes, Escape closes without running.
 */
export default function CommandPalette({ isOpen, onClose, items, placeholder }: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      const timer = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [isOpen])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  if (!isOpen) return null

  function runItem(item: PaletteItem): void {
    item.run()
    onClose()
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) runItem(filtered[selectedIndex])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="modal-backdrop" data-testid="command-palette-backdrop" onClick={handleBackdropClick}>
      <div className="modal-dialog cp-dialog" data-testid="command-palette">
        <div className="cp-input">
          <input
            ref={inputRef}
            data-testid="command-palette-input"
            placeholder={placeholder ?? 'Type a command or search…'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="cp-results" data-testid="command-palette-results">
          {filtered.length === 0 && (
            <div className="cp-empty" data-testid="command-palette-empty">
              No results
            </div>
          )}
          {filtered.map((item, idx) => (
            <div
              key={item.id}
              className={'cp-item' + (idx === selectedIndex ? ' selected' : '')}
              data-testid="command-palette-item"
              data-item-id={item.id}
              onMouseEnter={() => setSelectedIndex(idx)}
              onClick={() => runItem(item)}
            >
              <span>{item.label}</span>
              <span className="cpsub">{item.category}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
