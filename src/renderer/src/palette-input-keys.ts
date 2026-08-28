import type { KeyboardEvent } from 'react'

/** Emacs C-k: kill to end of line; at EOL kill newline; on empty line remove the line. */
export function killLineInText(value: string, cursor: number): { value: string; cursor: number } {
  const lineStart = value.lastIndexOf('\n', cursor - 1) + 1
  const nextNewline = value.indexOf('\n', cursor)
  const lineEnd = nextNewline === -1 ? value.length : nextNewline
  const lineContent = value.slice(lineStart, lineEnd)

  if (cursor < lineEnd) {
    return {
      value: value.slice(0, cursor) + value.slice(lineEnd),
      cursor
    }
  }

  // Cursor at end of line.
  if (lineContent.length > 0) {
    if (nextNewline !== -1) {
      return {
        value: value.slice(0, nextNewline) + value.slice(nextNewline + 1),
        cursor
      }
    }
    return { value, cursor }
  }

  // Empty line — remove it.
  if (nextNewline !== -1) {
    return {
      value: value.slice(0, lineStart) + value.slice(nextNewline + 1),
      cursor: lineStart
    }
  }
  if (lineStart > 0) {
    return {
      value: value.slice(0, lineStart - 1),
      cursor: lineStart - 1
    }
  }
  return { value, cursor }
}

export function lineBoundsInText(value: string, cursor: number): [number, number] {
  const start = value.lastIndexOf('\n', cursor - 1) + 1
  let end = value.indexOf('\n', cursor)
  if (end === -1) end = value.length
  return [start, end]
}

function forwardWordPos(value: string, cursor: number): number {
  let pos = cursor
  while (pos < value.length && !/\w/.test(value[pos])) pos++
  while (pos < value.length && /\w/.test(value[pos])) pos++
  return pos
}

function backwardWordPos(value: string, cursor: number): number {
  let pos = cursor
  while (pos > 0 && !/\w/.test(value[pos - 1])) pos--
  while (pos > 0 && /\w/.test(value[pos - 1])) pos--
  return pos
}

function backwardWordStartForKill(value: string, cursor: number): number {
  let start = cursor
  while (start > 0 && /\s/.test(value[start - 1])) start--
  while (start > 0 && !/\s/.test(value[start - 1])) start--
  return start
}

function forwardWordEndForKill(value: string, cursor: number): number {
  let end = cursor
  while (end < value.length && /\s/.test(value[end])) end++
  while (end < value.length && !/\s/.test(value[end])) end++
  return end
}

function moveVertical(value: string, cursor: number, delta: number): number {
  const [lineStart, lineEnd] = lineBoundsInText(value, cursor)
  const column = cursor - lineStart
  const lineIndex = value.slice(0, lineStart).split('\n').length - 1
  const lines = value.split('\n')
  const newLine = Math.max(0, Math.min(lines.length - 1, lineIndex + delta))
  const newLineStart = lines.slice(0, newLine).join('\n').length + (newLine > 0 ? 1 : 0)
  const newLineLen = lines[newLine]?.length ?? 0
  return newLineStart + Math.min(column, newLineLen)
}

function setTextareaCursor(ta: HTMLTextAreaElement, pos: number): void {
  requestAnimationFrame(() => ta.setSelectionRange(pos, pos))
}

function isCtrlOnly(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'code'>): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey
}

function isMetaKey(e: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'code'>): boolean {
  return e.altKey && !e.ctrlKey && !e.metaKey
}

function isCtrlK(e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'code'>): boolean {
  return e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyK'
}

/** Readline/Emacs navigation for multiline textareas (composer inbox). Uses e.code for alt/meta keys on macOS. */
export function applyEmacsNavigationToTextarea(
  e: KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  setValue: (next: string) => void
): boolean {
  const ta = e.currentTarget
  const cursor = ta.selectionStart ?? value.length

  if (isMetaKey(e)) {
    if (e.code === 'KeyF') {
      e.preventDefault()
      setTextareaCursor(ta, forwardWordPos(value, cursor))
      return true
    }
    if (e.code === 'KeyB') {
      e.preventDefault()
      setTextareaCursor(ta, backwardWordPos(value, cursor))
      return true
    }
    if (e.code === 'KeyD') {
      e.preventDefault()
      const end = forwardWordEndForKill(value, cursor)
      setValue(value.slice(0, cursor) + value.slice(end))
      setTextareaCursor(ta, cursor)
      return true
    }
    if (e.code === 'KeyV') {
      e.preventDefault()
      ta.scrollTop = Math.max(0, ta.scrollTop - ta.clientHeight)
      return true
    }
    if (e.shiftKey && e.code === 'Comma') {
      e.preventDefault()
      setTextareaCursor(ta, 0)
      return true
    }
    if (e.shiftKey && e.code === 'Period') {
      e.preventDefault()
      setTextareaCursor(ta, value.length)
      return true
    }
  }

  if (isCtrlOnly(e)) {
    if (e.code === 'KeyV') {
      e.preventDefault()
      ta.scrollTop = Math.min(ta.scrollHeight - ta.clientHeight, ta.scrollTop + ta.clientHeight)
      return true
    }
    if (e.code === 'KeyA') {
      e.preventDefault()
      setTextareaCursor(ta, lineBoundsInText(value, cursor)[0])
      return true
    }
    if (e.code === 'KeyE') {
      e.preventDefault()
      setTextareaCursor(ta, lineBoundsInText(value, cursor)[1])
      return true
    }
    if (e.code === 'KeyF') {
      e.preventDefault()
      setTextareaCursor(ta, Math.min(value.length, cursor + 1))
      return true
    }
    if (e.code === 'KeyB') {
      e.preventDefault()
      setTextareaCursor(ta, Math.max(0, cursor - 1))
      return true
    }
    if (e.code === 'KeyN') {
      e.preventDefault()
      setTextareaCursor(ta, moveVertical(value, cursor, 1))
      return true
    }
    if (e.code === 'KeyP') {
      e.preventDefault()
      setTextareaCursor(ta, moveVertical(value, cursor, -1))
      return true
    }
    if (e.code === 'KeyU') {
      e.preventDefault()
      const [lineStart] = lineBoundsInText(value, cursor)
      setValue(value.slice(0, lineStart) + value.slice(cursor))
      setTextareaCursor(ta, lineStart)
      return true
    }
    if (e.code === 'KeyW') {
      e.preventDefault()
      const start = backwardWordStartForKill(value, cursor)
      setValue(value.slice(0, start) + value.slice(cursor))
      setTextareaCursor(ta, start)
      return true
    }
  }

  return false
}

/** Ctrl+K in a single-line input. */
export function applyCtrlKillLineToInput(
  e: KeyboardEvent<HTMLInputElement>,
  value: string,
  setValue: (next: string) => void
): boolean {
  if (!isCtrlK(e)) return false
  e.preventDefault()
  const input = e.currentTarget
  const cursor = input.selectionStart ?? value.length
  const { value: next, cursor: nextCursor } = killLineInText(value, cursor)
  setValue(next)
  requestAnimationFrame(() => input.setSelectionRange(nextCursor, nextCursor))
  return true
}

/** Readline/Emacs bindings for any multiline textarea editor surface. */
export function handleEmacsTextareaKeyDown(
  e: KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  setValue: (next: string) => void
): boolean {
  if (applyEmacsNavigationToTextarea(e, value, setValue)) return true
  if (applyCtrlKillLineToTextarea(e, value, setValue)) return true
  return false
}

/** Ctrl+K in a multiline textarea (composer inbox). */
export function applyCtrlKillLineToTextarea(
  e: KeyboardEvent<HTMLTextAreaElement>,
  value: string,
  setValue: (next: string) => void
): boolean {
  if (!isCtrlK(e)) return false
  e.preventDefault()
  const ta = e.currentTarget
  const cursor = ta.selectionStart ?? value.length
  const { value: next, cursor: nextCursor } = killLineInText(value, cursor)
  setValue(next)
  requestAnimationFrame(() => ta.setSelectionRange(nextCursor, nextCursor))
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
