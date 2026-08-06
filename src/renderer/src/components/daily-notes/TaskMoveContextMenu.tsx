import { useEffect, useRef, useState } from 'react'
import type { MoveDateOptions } from './move-date-options'

interface TaskContextMenuProps {
  x: number
  y: number
  options: MoveDateOptions
  onSelect: (targetDate: string) => void
  onRename: () => void
  onClose: () => void
}

export default function TaskMoveContextMenu({
  x,
  y,
  options,
  onSelect,
  onRename,
  onClose
}: TaskContextMenuProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [submenuLeft, setSubmenuLeft] = useState(true) // default right; true = flip to left

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

  // Determine initial submenu direction based on available space to the right.
  useEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    const spaceRight = window.innerWidth - rect.right
    setSubmenuLeft(spaceRight < 180) // 170px submenu width + buffer
  }, [])

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
      <div
        className="smi"
        data-testid="task-rename-option"
        onClick={() => { onRename(); onClose() }}
      >
        Rename
      </div>
      <div className="sm-sep" />
      <div className="smi dn-submenu-parent" data-testid="task-move-to-parent">
        Move to…
        <span className="dn-submenu-arrow">›</span>
        <div className={`dn-submenu${submenuLeft ? ' dn-submenu-left' : ''}`}>
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
      </div>
    </div>
  )
}
