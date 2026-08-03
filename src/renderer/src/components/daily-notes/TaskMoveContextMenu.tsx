import { useEffect, useRef } from 'react'
import type { MoveDateOptions } from './move-date-options'

interface TaskMoveContextMenuProps {
  x: number
  y: number
  options: MoveDateOptions
  onSelect: (targetDate: string) => void
  onClose: () => void
}

/**
 * "Move to..." context menu (16-task-move-to-date), shared between
 * Timeline.tsx (right-click a `.dn-tblock`) and TaskItem.tsx's Unscheduled
 * usage (right-click a `.dn-task-chip`). Modeled after the existing
 * `.session-menu-popup`/`.export-menu-pop` popup pattern (`.smi` row /
 * `.sm-sep` separator classes, same background/border/shadow/hover tokens —
 * see daily-notes.css's `.dn-move-menu-popup`) rather than inventing a new
 * visual language, but positioned at the cursor (`position: fixed`,
 * inline `left`/`top`) instead of anchored to a trigger button.
 */
export default function TaskMoveContextMenu({
  x,
  y,
  options,
  onSelect,
  onClose
}: TaskMoveContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)

  // Closes on outside click / Escape, same as .session-menu-popup.
  useEffect(() => {
    function handleOutsideClick(e: MouseEvent): void {
      if (ref.current && ref.current.contains(e.target as Node)) return
      onClose()
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('click', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  function choose(date: string): void {
    onSelect(date)
    onClose()
  }

  return (
    <div
      ref={ref}
      className="dn-move-menu-popup"
      data-testid="task-move-context-menu"
      style={{ left: `${x}px`, top: `${y}px` }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {options.days.map((opt) => (
        <div
          key={opt.date}
          className="smi"
          data-testid="task-move-option"
          data-date={opt.date}
          onClick={() => choose(opt.date)}
        >
          {opt.label}
        </div>
      ))}
      <div className="sm-sep" />
      <div
        className="smi"
        data-testid="task-move-option-next-week"
        data-date={options.nextWeek.date}
        onClick={() => choose(options.nextWeek.date)}
      >
        {options.nextWeek.label}
      </div>
    </div>
  )
}
