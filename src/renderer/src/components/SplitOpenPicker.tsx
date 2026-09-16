import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'

export interface SplitPickerItem {
  id: string
  label: string
  /** Secondary descriptive text shown alongside the label (e.g. a file path). */
  hint?: string
  category: string
  run: () => void
}

interface SplitOpenPickerProps {
  isOpen: boolean
  onClose: () => void
  items: SplitPickerItem[]
}

/**
 * Keyboard-driven picker that opens when the user presses Ctrl+X 2.
 * Shows what can be opened in the split secondary pane, grouped by category.
 */
export default function SplitOpenPicker({ isOpen, onClose, items }: SplitOpenPickerProps): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const q = query.toLowerCase()
  const filtered = items.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.hint?.toLowerCase().includes(q) ||
      item.category.toLowerCase().includes(q)
  )

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

  function runItem(item: SplitPickerItem): void {
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

  // Group filtered items by category, preserving order.
  const categories: { name: string; startIndex: number; items: SplitPickerItem[] }[] = []
  let flatIndex = 0
  const seenCategories = new Set<string>()
  for (const item of filtered) {
    if (!seenCategories.has(item.category)) {
      seenCategories.add(item.category)
      categories.push({ name: item.category, startIndex: flatIndex, items: [] })
    }
    categories[categories.length - 1].items.push(item)
    flatIndex++
  }

  return (
    <div
      className="modal-backdrop"
      data-testid="split-open-picker-backdrop"
      onClick={handleBackdropClick}
    >
      <div className="modal-dialog cp-dialog" data-testid="split-open-picker">
        <div className="cp-input">
          <input
            ref={inputRef}
            data-testid="split-open-picker-input"
            placeholder="Open in split pane…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <div className="cp-results" data-testid="split-open-picker-results">
          {filtered.length === 0 && (
            <div className="cp-empty" data-testid="split-open-picker-empty">
              No results
            </div>
          )}
          {categories.map((cat) =>
            cat.items.map((item, idxInCat) => {
              const globalIdx = cat.startIndex + idxInCat
              const isFirst = idxInCat === 0
              return (
                <div key={item.id}>
                  {isFirst && (
                    <div className="cp-category-header" data-testid="split-open-picker-category">
                      {cat.name}
                    </div>
                  )}
                  <div
                    className={'cp-item' + (globalIdx === selectedIndex ? ' selected' : '')}
                    data-testid="split-open-picker-item"
                    data-item-id={item.id}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    onClick={() => runItem(item)}
                  >
                    <span>{item.label}</span>
                    {item.hint && <span className="cpsub">{item.hint}</span>}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
