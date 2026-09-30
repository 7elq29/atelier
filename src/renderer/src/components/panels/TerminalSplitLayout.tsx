import { useEffect, useRef } from 'react'
import type { TerminalPaneNode } from '../../../../shared/terminal-split-types'
import TerminalPanel from './TerminalPanel'

interface TerminalSplitLayoutProps {
  node: TerminalPaneNode
  focusedId: string
  cwd: string
  hostname?: string | null
  active: boolean
  onFocus: (id: string) => void
  onSplit: (id: string, dir: 'row' | 'col') => void
  onClose: (id: string) => void
  onRatioChange: (splitId: string, ratio: number) => void
}

// Shared child props (everything except `node`)
type ChildProps = Omit<TerminalSplitLayoutProps, 'node'>

export default function TerminalSplitLayout({ node, ...childProps }: TerminalSplitLayoutProps): JSX.Element {
  if (node.type === 'pane') {
    return <TerminalPane paneNode={node} {...childProps} />
  }
  return <TerminalSplitNode splitNode={node} {...childProps} />
}

// ── Pane (leaf) ────────────────────────────────────────────────────────────

function TerminalPane({
  paneNode,
  focusedId,
  cwd,
  hostname,
  active,
  onFocus,
}: { paneNode: TerminalPaneNode & { type: 'pane' } } & ChildProps): JSX.Element {
  const isFocused = paneNode.id === focusedId

  return (
    <div
      className="term-pane-wrapper"
      data-focused={isFocused ? 'true' : 'false'}
      data-pane-id={paneNode.id}
      onMouseDown={() => onFocus(paneNode.id)}
    >
      <TerminalPanel
        ptyId={paneNode.ptyId}
        cwd={cwd}
        hostname={hostname}
        active={active && isFocused}
      />
    </div>
  )
}

// ── Split (branch) ─────────────────────────────────────────────────────────

function TerminalSplitNode({
  splitNode,
  ...childProps
}: { splitNode: TerminalPaneNode & { type: 'split' } } & ChildProps): JSX.Element {
  const { onRatioChange } = childProps
  const containerRef = useRef<HTMLDivElement>(null)
  const aWrapRef = useRef<HTMLDivElement>(null)
  const dividerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ lastRatio: number } | null>(null)

  useEffect(() => {
    return () => { dragRef.current = null }
  }, [])

  function startDrag(e: React.MouseEvent): void {
    e.preventDefault()
    dragRef.current = { lastRatio: splitNode.ratio }
    dividerRef.current?.classList.add('dragging')

    function onMove(ev: MouseEvent): void {
      if (!dragRef.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      let ratio: number
      if (splitNode.dir === 'row') {
        ratio = ((ev.clientX - rect.left) / rect.width) * 100
      } else {
        ratio = ((ev.clientY - rect.top) / rect.height) * 100
      }
      ratio = Math.max(15, Math.min(85, ratio))
      dragRef.current.lastRatio = ratio
      // Direct DOM update for smooth drag — no React re-render mid-drag
      if (aWrapRef.current) aWrapRef.current.style.flex = `0 0 ${ratio}%`
    }

    function onUp(): void {
      if (dragRef.current) {
        onRatioChange(splitNode.id, dragRef.current.lastRatio)
      }
      dragRef.current = null
      dividerRef.current?.classList.remove('dragging')
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div ref={containerRef} className={`term-split-layout ${splitNode.dir}`}>
      <div ref={aWrapRef} style={{ flex: `0 0 ${splitNode.ratio}%`, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <TerminalSplitLayout node={splitNode.a} {...childProps} />
      </div>
      <div ref={dividerRef} className={`term-split-divider ${splitNode.dir}`} onMouseDown={startDrag} />
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
        <TerminalSplitLayout node={splitNode.b} {...childProps} />
      </div>
    </div>
  )
}
