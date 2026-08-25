import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

const MENU_WIDTH = 190

interface SessionMenuPopupProps {
  anchorRef: RefObject<HTMLElement | null>
  menuRef?: RefObject<HTMLDivElement>
  testId?: string
  children: ReactNode
  onClick?: (e: React.MouseEvent) => void
}

/** Session sidebar context menu — portaled + fixed like the UI mock (06-session-organization). */
export function SessionMenuPopup({
  anchorRef,
  menuRef,
  testId,
  children,
  onClick
}: SessionMenuPopupProps): JSX.Element | null {
  const internalRef = useRef<HTMLDivElement>(null)
  const ref = menuRef ?? internalRef
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor) return

    function updatePosition(): void {
      const rect = anchor!.getBoundingClientRect()
      setPosition({
        top: rect.bottom + 4,
        left: Math.max(8, rect.right - MENU_WIDTH)
      })
    }

    updatePosition()
    window.addEventListener('scroll', updatePosition, true)
    window.addEventListener('resize', updatePosition)
    return () => {
      window.removeEventListener('scroll', updatePosition, true)
      window.removeEventListener('resize', updatePosition)
    }
  }, [anchorRef])

  if (!position) return null

  return createPortal(
    <div
      ref={ref}
      className="session-menu-popup"
      data-testid={testId}
      style={{ top: position.top, left: position.left }}
      onClick={onClick}
    >
      {children}
    </div>,
    document.body
  )
}
