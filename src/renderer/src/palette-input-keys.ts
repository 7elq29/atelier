import type { KeyboardEvent } from 'react'

/** Ctrl+K: delete from cursor to end of line (single-line input). */
export function applyCtrlKillLineToInput(
  e: KeyboardEvent<HTMLInputElement>,
  value: string,
  setValue: (next: string) => void
): boolean {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.code !== 'KeyK') return false
  e.preventDefault()
  const input = e.currentTarget
  const cursor = input.selectionStart ?? value.length
  setValue(value.slice(0, cursor))
  requestAnimationFrame(() => input.setSelectionRange(cursor, cursor))
  return true
}

/** Ctrl+P / Ctrl+N: move selection up/down in a palette result list. */
export function applyCtrlListNav(
  e: KeyboardEvent,
  setSelectedIndex: (update: (i: number) => number) => void,
  lastIndex: number
): boolean {
  if (!e.ctrlKey || e.metaKey || e.altKey) return false
  if (e.code === 'KeyP') {
    e.preventDefault()
    setSelectedIndex((i) => Math.max(i - 1, 0))
    return true
  }
  if (e.code === 'KeyN') {
    e.preventDefault()
    setSelectedIndex((i) => Math.min(i + 1, Math.max(lastIndex, 0)))
    return true
  }
  return false
}
