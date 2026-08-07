import { useEffect, useRef, type KeyboardEvent } from 'react'

/**
 * In-conversation "Find in conversation" search bar (10b-enrichment-full-
 * text-search). Markup/classes copied verbatim from
 * Features/UI-Design/mocks/index.html's `.search-bar-inline`/`.smatches`
 * rules and its `#icon-search` `<symbol>` (inlined here as a real SVG,
 * following the same pattern `MessageActions.tsx` used for `#icon-copy`/
 * `#icon-speaker`) — reimplemented as real React state + `ChatTranscript`'s
 * `highlightMatches` for the actual highlighting/navigation, rather than the
 * mock's static-page `searchTranscript()`/`clearSearchHighlights()` DOM-Range
 * demo JS.
 *
 * Behavior: typing filters `ChatTranscript`'s highlighted matches live
 * (case-insensitive substring); Enter/ArrowDown move to the next match,
 * Shift+Enter/ArrowUp move to the previous one (wrapping both ways); Escape
 * closes the bar and clears highlighting.
 */
export default function TranscriptSearchBar({
  open,
  query,
  matchCount,
  onQueryChange,
  onNavigate,
  onToggle,
  onClose
}: {
  open: boolean
  query: string
  matchCount: number
  onQueryChange: (query: string) => void
  onNavigate: (direction: 1 | -1) => void
  onToggle: () => void
  onClose: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onNavigate(e.shiftKey ? -1 : 1)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      onNavigate(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      onNavigate(-1)
    }
  }

  return (
    <>
      <div className={`search-bar-inline${open ? ' show' : ''}`} data-testid="transcript-search-bar">
        <input
          ref={inputRef}
          data-testid="transcript-search-input"
          placeholder="Find in conversation…"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="smatches" data-testid="transcript-search-matches">
          {query ? (matchCount > 0 ? `${matchCount} match${matchCount > 1 ? 'es' : ''}` : 'No matches') : ''}
        </span>
      </div>
      <button
        className="btn btn-icon btn-sm"
        title="Search this conversation (Ctrl+S)"
        data-testid="toggle-transcript-search"
        onClick={onToggle}
      >
        <svg className="icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      </button>
    </>
  )
}
