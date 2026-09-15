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
  /**
   * Cross-session content search (10b-enrichment-full-text-search): given the
   * current typed query, resolves extra `PaletteItem`s to append to the
   * "Session" results — e.g. message-content matches from
   * `window.atelier.searchMessages`. Optional so callers that don't need
   * content search (or tests exercising the palette in isolation) can omit
   * it entirely. Debounced internally; results for a stale query are
   * discarded if a newer one has since resolved.
   */
  searchContent?: (query: string) => Promise<PaletteItem[]>
}

/**
 * Keyboard-driven command palette overlay (⌘K on macOS). Real search/filter
 * as-you-type against `items`; arrow keys move selection, Enter runs the
 * selected item and closes, Escape closes without running anything.
 */
export default function CommandPalette({ isOpen, onClose, items, searchContent }: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [contentItems, setContentItems] = useState<PaletteItem[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const requestSeq = useRef(0)

  const nameMatches = items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()))
  // Content matches are appended after name matches, deduped against any
  // session-name match that's already showing the same underlying session
  // (a content match's id is `session-content-<sessionId>-<messageId>`, so
  // this only ever collides on a shared prefix, never a false match).
  const filtered = [...nameMatches, ...contentItems]

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      setContentItems([])
      const timer = setTimeout(() => inputRef.current?.focus(), 0)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [isOpen])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Debounced cross-session content search (10b-enrichment-full-text-search):
  // fires ~150ms after typing settles, and a stale response (query changed
  // again before it resolved) is discarded via the `requestSeq` token rather
  // than trusted — avoids a slow first query clobbering a faster later one.
  useEffect(() => {
    if (!searchContent || !query.trim()) {
      setContentItems([])
      return undefined
    }
    const seq = ++requestSeq.current
    const timer = setTimeout(() => {
      void searchContent(query).then((results) => {
        if (requestSeq.current === seq) setContentItems(results)
      })
    }, 150)
    return () => clearTimeout(timer)
  }, [query, searchContent])

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
            placeholder="Type a command or search…"
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
