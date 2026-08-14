import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { flushSync } from 'react-dom'
import {
  completeDirQuerySegment,
  expandDisplayPath,
  formatPathForDisplay,
  normalizePath,
  parentDirectory,
  resolveDirEditorQuery,
  resolveSearchListDir
} from '../../../shared/file-quick-open-path'
import { fileQuickOpenSearchMatch, fileQuickOpenSubstringMatch } from '../../../shared/file-quick-open-search'
import type { FileTreeNode, WorkspaceFileEntry } from '../../../shared/panel-types'
import { applyCtrlKillLineToInput, applyCtrlListNav } from '../palette-input-keys'

function focusInputCaret(input: HTMLInputElement | null, pos: number): void {
  if (!input) return
  requestAnimationFrame(() => {
    input.focus()
    input.setSelectionRange(pos, pos)
    const style = getComputedStyle(input)
    const ctx = document.createElement('canvas').getContext('2d')
    if (!ctx) return
    ctx.font = style.font
    const caretX = ctx.measureText(input.value.slice(0, pos)).width
    const pad = 12
    if (caretX + pad > input.scrollLeft + input.clientWidth) {
      input.scrollLeft = caretX - input.clientWidth + pad
    } else if (caretX < input.scrollLeft + pad) {
      input.scrollLeft = Math.max(0, caretX - pad)
    }
  })
}

export type QuickOpenRow =
  | { kind: 'dir'; name: string; path: string }
  | { kind: 'file'; name: string; path: string }

type FocusPane = 'dir' | 'search'

function pathRelativeToDir(filePath: string, listDir: string): string {
  const dir = normalizePath(listDir)
  if (filePath.startsWith(`${dir}/`)) return filePath.slice(dir.length + 1)
  return filePath
}

function directoryParent(absPath: string): string {
  const n = normalizePath(absPath)
  if (n === '/') return '/'
  const i = n.lastIndexOf('/')
  return i <= 0 ? '/' : n.slice(0, i)
}

function treeNodesToRows(nodes: FileTreeNode[]): QuickOpenRow[] {
  const dirs = nodes.filter((n) => n.type === 'dir').map((n) => ({ kind: 'dir' as const, name: n.name, path: n.path }))
  const files = nodes.filter((n) => n.type === 'file').map((n) => ({ kind: 'file' as const, name: n.name, path: n.path }))
  return [...dirs, ...files]
}

function workspaceFilesToRows(entries: WorkspaceFileEntry[]): QuickOpenRow[] {
  return entries.map((e) => ({ kind: 'file' as const, name: e.name, path: e.path }))
}

interface FileQuickOpenPaletteProps {
  isOpen: boolean
  onClose: () => void
  workspaceRoot: string
  hostname?: string | null
  onOpenFile: (absolutePath: string) => void
}

export default function FileQuickOpenPalette({
  isOpen,
  onClose,
  workspaceRoot,
  hostname,
  onOpenFile
}: FileQuickOpenPaletteProps): JSX.Element | null {
  const sessionRoot = normalizePath(workspaceRoot)
  const [currentDir, setCurrentDir] = useState(sessionRoot)
  const [focusPane, setFocusPane] = useState<FocusPane>('search')
  const [dirQuery, setDirQuery] = useState('')
  const [searchFilter, setSearchFilter] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [shallowRows, setShallowRows] = useState<QuickOpenRow[]>([])
  const [deepFiles, setDeepFiles] = useState<WorkspaceFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [homeDir, setHomeDir] = useState<string | undefined>(undefined)
  const dirInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const loadSeq = useRef(0)
  const pendingDirCaret = useRef<number | null>(null)

  const dirContext = useMemo(
    () => resolveDirEditorQuery(dirQuery, sessionRoot, currentDir),
    [dirQuery, sessionRoot, currentDir]
  )

  const searchScope = useMemo(
    () => resolveSearchListDir(currentDir, searchFilter, sessionRoot),
    [currentDir, searchFilter, sessionRoot]
  )

  const filteredRows = useMemo((): QuickOpenRow[] => {
    if (focusPane === 'dir') {
      return shallowRows.filter((r) => fileQuickOpenSubstringMatch(dirContext.segmentFilter, r.name))
    }
    return workspaceFilesToRows(deepFiles).filter((r) => {
      const rel = pathRelativeToDir(r.path, searchScope.listDir)
      return fileQuickOpenSearchMatch(searchScope.nameFilter, r.name, rel, r.path)
    })
  }, [focusPane, dirContext.segmentFilter, searchScope, shallowRows, deepFiles])

  const displayPath = useCallback(
    (absPath: string) => formatPathForDisplay(absPath, homeDir),
    [homeDir]
  )

  useEffect(() => {
    void window.atelier.getHomedir().then(setHomeDir)
  }, [])

  const resetState = useCallback(() => {
    setCurrentDir(sessionRoot)
    setFocusPane('search')
    setDirQuery(displayPath(sessionRoot))
    setSearchFilter('')
    setSelectedIndex(0)
  }, [sessionRoot, displayPath])

  const enterDirMode = useCallback(() => {
    setDirQuery(displayPath(currentDir))
    setFocusPane('dir')
    setTimeout(() => focusInputCaret(dirInputRef.current, dirInputRef.current?.value.length ?? 0), 0)
  }, [currentDir, displayPath])

  useEffect(() => {
    if (!isOpen) return undefined
    resetState()
    const timer = setTimeout(() => searchInputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [isOpen, sessionRoot, resetState])

  useEffect(() => {
    if (focusPane !== 'dir') return
    focusInputCaret(dirInputRef.current, dirInputRef.current?.value.length ?? 0)
  }, [focusPane])

  useEffect(() => {
    if (focusPane !== 'dir' || pendingDirCaret.current == null) return
    const pos = pendingDirCaret.current
    pendingDirCaret.current = null
    focusInputCaret(dirInputRef.current, pos)
  }, [dirQuery, focusPane])

  useEffect(() => {
    if (!isOpen || focusPane !== 'search') return undefined
    const id = window.setTimeout(() => searchInputRef.current?.focus(), 0)
    return () => clearTimeout(id)
  }, [isOpen, focusPane, currentDir])

  const shallowListDir = focusPane === 'dir' ? dirContext.listDir : currentDir

  useEffect(() => {
    if (!isOpen) return undefined
    setLoading(true)
    const seq = ++loadSeq.current
    const timer = setTimeout(() => {
      if (focusPane === 'dir') {
        void window.atelier
          .filesDir(sessionRoot, shallowListDir, hostname)
          .then((nodes) => {
            if (loadSeq.current === seq) setShallowRows(treeNodesToRows(nodes))
          })
          .finally(() => {
            if (loadSeq.current === seq) setLoading(false)
          })
      } else {
        void window.atelier
          .filesList(sessionRoot, searchScope.listDir, hostname)
          .then((entries) => {
            if (loadSeq.current === seq) setDeepFiles(entries)
          })
          .finally(() => {
            if (loadSeq.current === seq) setLoading(false)
          })
      }
    }, 80)
    return () => clearTimeout(timer)
  }, [isOpen, sessionRoot, shallowListDir, searchScope.listDir, currentDir, focusPane, hostname, searchFilter])

  useEffect(() => {
    setSelectedIndex(0)
  }, [focusPane, dirQuery, searchFilter, shallowListDir, currentDir, shallowRows.length, deepFiles.length])

  if (!isOpen) return null

  function openFile(path: string): void {
    onOpenFile(path)
    onClose()
  }

  function commitDirAndSearch(absDir: string): void {
    const dir = normalizePath(absDir)
    flushSync(() => {
      setCurrentDir(dir)
      setDirQuery(displayPath(dir))
      setFocusPane('search')
      setSearchFilter('')
    })
  }

  function commitDirFromEditorQuery(): void {
    const abs = expandDisplayPath(dirQuery, sessionRoot, currentDir)
    const fileMatch = shallowRows.find(
      (r) => r.kind === 'file' && normalizePath(r.path) === normalizePath(abs)
    )
    commitDirAndSearch(fileMatch ? directoryParent(abs) : abs)
  }

  function descendIntoDir(path: string): void {
    commitDirAndSearch(path)
  }

  function runRow(row: QuickOpenRow): void {
    if (row.kind === 'dir') descendIntoDir(row.path)
    else openFile(row.path)
  }

  function handleDirKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (applyCtrlKillLineToInput(e, dirQuery, setDirQuery)) return
    if (applyCtrlListNav(e, setSelectedIndex, filteredRows.length - 1)) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, Math.max(filteredRows.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const row = filteredRows[selectedIndex] ?? filteredRows[0]
      const canComplete =
        dirContext.segmentFilter.length > 0 &&
        filteredRows.length > 0 &&
        row != null &&
        dirContext.segmentFilter !== row.name &&
        fileQuickOpenSubstringMatch(dirContext.segmentFilter, row.name)
      if (canComplete) {
        const { value, cursor } = completeDirQuerySegment(dirQuery, sessionRoot, currentDir, row.name)
        pendingDirCaret.current = cursor
        flushSync(() => {
          setDirQuery(value)
        })
        focusInputCaret(dirInputRef.current, cursor)
      } else {
        commitDirFromEditorQuery()
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = filteredRows[selectedIndex]
      if (row) runRow(row)
      else commitDirFromEditorQuery()
    } else if (e.key === 'Backspace' && dirQuery.trim() === '') {
      const parent = parentDirectory(sessionRoot, currentDir)
      if (parent) {
        e.preventDefault()
        setCurrentDir(parent)
        setDirQuery(displayPath(parent))
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  function handleSearchKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (applyCtrlKillLineToInput(e, searchFilter, setSearchFilter)) return
    if (applyCtrlListNav(e, setSelectedIndex, filteredRows.length - 1)) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, Math.max(filteredRows.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = filteredRows[selectedIndex]
      if (row?.kind === 'file') openFile(row.path)
    } else if (e.key === 'Backspace' && searchFilter === '') {
      e.preventDefault()
      enterDirMode()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="modal-backdrop" data-testid="file-quick-open-backdrop" onClick={handleBackdropClick}>
      <div className="modal-dialog cp-dialog fqo-dialog" data-testid="file-quick-open">
        <div className={'fqo-head' + (focusPane === 'dir' ? ' fqo-head--dir-active' : '')}>
          <div className="fqo-dir-row">
            <span className="fqo-dir-label" aria-hidden>
              Dir
            </span>
            {focusPane === 'dir' ? (
              <input
                ref={dirInputRef}
                className="fqo-dir-input"
                data-testid="file-quick-open-dir"
                value={dirQuery}
                onChange={(e) => setDirQuery(e.target.value)}
                onKeyDown={handleDirKeyDown}
              />
            ) : (
              <button
                type="button"
                tabIndex={-1}
                className="fqo-dir-display"
                data-testid="file-quick-open-dir"
                onClick={enterDirMode}
              >
                {displayPath(currentDir)}
              </button>
            )}
          </div>
          <div className="fqo-sep" role="separator" aria-orientation="horizontal" />
          <div className="fqo-search-row">
            <input
              ref={searchInputRef}
              className="fqo-search-input"
              data-testid="file-quick-open-input"
              placeholder="Search files under this folder…"
              value={searchFilter}
              onFocus={() => setFocusPane('search')}
              onChange={(e) => setSearchFilter(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
        </div>
        <div className="cp-results" data-testid="file-quick-open-results">
          {loading && (
            <div className="cp-empty" data-testid="file-quick-open-loading">
              Loading…
            </div>
          )}
          {!loading && filteredRows.length === 0 && (
            <div className="cp-empty" data-testid="file-quick-open-empty">
              No results
            </div>
          )}
          {!loading &&
            filteredRows.map((row, idx) => (
              <div
                key={`${row.kind}-${row.path}`}
                className={'cp-item' + (idx === selectedIndex ? ' selected' : '')}
                data-testid="file-quick-open-item"
                data-path={row.path}
                data-kind={row.kind}
                onMouseEnter={() => setSelectedIndex(idx)}
                onClick={() => runRow(row)}
              >
                <span className={'fqo-row-name' + (row.kind === 'dir' ? ' fqo-row-name--dir' : '')}>
                  {row.kind === 'dir' ? `${row.name}/` : row.name}
                </span>
                {focusPane === 'search' && (
                  <span className="cpsub">{pathRelativeToDir(row.path, searchScope.listDir) || row.name}</span>
                )}
              </div>
            ))}
        </div>
        <div className="fqo-hint" data-testid="file-quick-open-hint">
          {focusPane === 'dir'
            ? 'Edit path · one level listed · Ctrl+P/N move · Ctrl+K kill line · Tab completes · Tab again → search'
            : 'Recursive search · Ctrl+P/N move · Ctrl+K kill line · Backspace at empty edits directory'}
        </div>
      </div>
    </div>
  )
}
