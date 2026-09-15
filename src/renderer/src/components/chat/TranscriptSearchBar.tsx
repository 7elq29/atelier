import { useEffect, useRef, type KeyboardEvent } from 'react'

/**
 * In-conversation "Find in conversation" search bar (10b-enrichment-full-
 * text-search). Markup/classes copied verbatim from
 * Features/UI-Design/mocks/index.html's `.search-bar-inline`/`.smatches`
 * rules. Opened with Ctrl+S (no topbar search icon). Highlighting/navigation
 * live in `ChatTranscript`'s `highlightMatches`, not the mock's DOM-Range
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
  onClose
}: {
  open: boolean
  query: string
  matchCount: number
  onQueryChange: (query: string) => void
  onNavigate: (direction: 1 | -1) => void
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
    </>
  )
}
