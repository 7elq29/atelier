import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { CreateSessionBookmarkInput } from '../../../../shared/session-bookmarks'

export interface ChatBookmarkMenuState {
  x: number
  y: number
  bookmark: CreateSessionBookmarkInput
}

export default function ChatBookmarkContextMenu({
  state,
  bookmarked,
  onToggle,
  onClose
}: {
  state: ChatBookmarkMenuState
  bookmarked: boolean
  onToggle: (bookmark: CreateSessionBookmarkInput, bookmarked: boolean) => void
  onClose: () => void
}): JSX.Element {
  useEffect(() => {
    const close = (): void => onClose()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('blur', close)
    window.addEventListener('scroll', close, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const left = Math.min(state.x, window.innerWidth - 198)
  const top = Math.min(state.y, window.innerHeight - 42)

  return createPortal(
    <div
      className="session-menu-popup chat-bookmark-menu"
      data-testid="chat-bookmark-context-menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="smi"
        data-testid="chat-bookmark-toggle"
        onClick={() => {
          onToggle(state.bookmark, bookmarked)
          onClose()
        }}
      >
        {bookmarked ? 'Remove bookmark' : 'Bookmark'}
      </button>
    </div>,
    document.body
  )
}
