import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

const SIDEBAR_WIDTH_KEY = 'atelier.app.sidebarWidth'
const DAILY_NOTES_WIDTH_KEY = 'atelier.app.dailyNotesWidth'

export const DEFAULT_SIDEBAR_WIDTH = 260
export const DEFAULT_DAILY_NOTES_WIDTH = 350
export const COLLAPSED_SIDEBAR_WIDTH = 56

const MIN_SIDEBAR_WIDTH = 200
const MIN_DAILY_NOTES_WIDTH = 280
const MIN_MAIN_WIDTH = 360

function loadWidth(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  } catch {
    return fallback
  }
}

function saveWidth(key: string, width: number): void {
  try {
    localStorage.setItem(key, String(Math.round(width)))
  } catch {
    // best-effort persistence only
  }
}

function clampSidebarWidth(width: number, containerWidth: number, dailyNotesOpen: boolean, dailyNotesWidth: number): number {
  const chrome = dailyNotesOpen ? dailyNotesWidth + 10 : 5
  const max = containerWidth - chrome - MIN_MAIN_WIDTH
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), Math.max(MIN_SIDEBAR_WIDTH, max)))
}

function clampDailyNotesWidth(
  width: number,
  containerWidth: number,
  sidebarExpanded: boolean,
  sidebarWidth: number
): number {
  const sidebar = sidebarExpanded ? sidebarWidth : COLLAPSED_SIDEBAR_WIDTH
  const max = containerWidth - sidebar - 10 - MIN_MAIN_WIDTH
  return Math.round(Math.min(Math.max(width, MIN_DAILY_NOTES_WIDTH), Math.max(MIN_DAILY_NOTES_WIDTH, max)))
}

export interface UseAppPanelWidthsResult {
  sidebarWidth: number
  dailyNotesWidth: number
  resizing: boolean
  startSidebarResize: (e: React.MouseEvent) => void
  startDailyNotesResize: (e: React.MouseEvent) => void
}

export function useAppPanelWidths(
  appBodyRef: RefObject<HTMLElement | null>,
  options: { dailyNotesOpen: boolean; sidebarExpanded: boolean }
): UseAppPanelWidthsResult {
  const [sidebarWidth, setSidebarWidth] = useState(() => loadWidth(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH))
  const [dailyNotesWidth, setDailyNotesWidth] = useState(() =>
    loadWidth(DAILY_NOTES_WIDTH_KEY, DEFAULT_DAILY_NOTES_WIDTH)
  )
  const [resizing, setResizing] = useState(false)
  const dragRef = useRef<'sidebar' | 'dailyNotes' | null>(null)
  const startRef = useRef({ x: 0, width: 0 })
  const widthsRef = useRef({ sidebarWidth, dailyNotesWidth })
  const optionsRef = useRef(options)
  widthsRef.current = { sidebarWidth, dailyNotesWidth }
  optionsRef.current = options

  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = 'sidebar'
    startRef.current = { x: e.clientX, width: widthsRef.current.sidebarWidth }
    setResizing(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }, [])

  const startDailyNotesResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = 'dailyNotes'
    startRef.current = { x: e.clientX, width: widthsRef.current.dailyNotesWidth }
    setResizing(true)
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const containerWidth = appBodyRef.current?.clientWidth ?? window.innerWidth
      const { dailyNotesOpen, sidebarExpanded } = optionsRef.current
      const { dailyNotesWidth: dailyWidth, sidebarWidth: sidebarPx } = widthsRef.current
      const delta = e.clientX - startRef.current.x
      if (drag === 'sidebar') {
        const next = clampSidebarWidth(startRef.current.width + delta, containerWidth, dailyNotesOpen, dailyWidth)
        setSidebarWidth(next)
      } else {
        const next = clampDailyNotesWidth(
          startRef.current.width - delta,
          containerWidth,
          sidebarExpanded,
          sidebarPx
        )
        setDailyNotesWidth(next)
      }
    }

    const onUp = (): void => {
      if (!dragRef.current) return
      const finished = dragRef.current
      dragRef.current = null
      setResizing(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      if (finished === 'sidebar') {
        saveWidth(SIDEBAR_WIDTH_KEY, widthsRef.current.sidebarWidth)
      } else {
        saveWidth(DAILY_NOTES_WIDTH_KEY, widthsRef.current.dailyNotesWidth)
      }
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [appBodyRef])

  useEffect(() => {
    const el = appBodyRef.current
    if (!el) return
    const clampToContainer = (): void => {
      const containerWidth = el.clientWidth
      const { dailyNotesOpen, sidebarExpanded } = optionsRef.current
      setSidebarWidth((prev) =>
        clampSidebarWidth(prev, containerWidth, dailyNotesOpen, widthsRef.current.dailyNotesWidth)
      )
      setDailyNotesWidth((prev) =>
        clampDailyNotesWidth(prev, containerWidth, sidebarExpanded, widthsRef.current.sidebarWidth)
      )
    }
    const observer = new ResizeObserver(clampToContainer)
    observer.observe(el)
    return () => observer.disconnect()
  }, [appBodyRef])

  return { sidebarWidth, dailyNotesWidth, resizing, startSidebarResize, startDailyNotesResize }
}
