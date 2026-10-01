import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ForwardedRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useConfig } from '../../hooks/useConfig'
import '@xterm/xterm/css/xterm.css'

// Read from the actual container element so descendant CSS variable overrides
// (e.g. --bg-app on the active split pane) are reflected in the xterm theme
// rather than always falling back to the root-level token values.
function readTheme(el: Element): ITheme {
  const style = getComputedStyle(el)
  const v = (name: string): string => style.getPropertyValue(name).trim()
  return {
    background: v('--bg-app'),
    foreground: v('--text-primary'),
    cursor: v('--text-primary'),
    selectionBackground: v('--accent-dim'),
    black: v('--bg-panel'),
    brightBlack: v('--text-tertiary'),
    red: v('--danger'),
    brightRed: v('--danger'),
    green: v('--success'),
    brightGreen: v('--accent'),
    yellow: v('--warning'),
    brightYellow: v('--warning'),
    blue: v('--sc-blue'),
    brightBlue: v('--sc-blue'),
    magenta: v('--sc-purple'),
    brightMagenta: v('--sc-purple'),
    cyan: v('--sc-cyan'),
    brightCyan: v('--sc-cyan'),
    white: v('--text-primary'),
    brightWhite: v('--text-primary')
  }
}

/**
 * Real terminal surface (07-secondary-panels §5): spawns/attaches a real
 * `node-pty` process keyed by `ptyId` (see main/panels/pty.ts) and streams
 * its actual output through a real `@xterm/xterm` instance, which owns all
 * ANSI/VT100 parsing, cursor/erase semantics, and key encoding — this
 * component only wires it to the pty IPC bridge. Used for creation-time
 * "Terminal-only" sessions and the session Terminal tab.
 *
 * If the backing client exits while this panel stays mounted (keep-alive),
 * we auto-respawn once (attach existing tmux, or create a new one if gone).
 * On failure the panel shows an explicit reconnect control instead of a
 * silent dead shell that swallows keystrokes.
 */
export interface TerminalPanelHandle {
  injectCommand: (command: string) => void
  focus: () => void
}

type ConnState = 'connecting' | 'live' | 'reconnecting' | 'disconnected'

const TerminalPanel = forwardRef(function TerminalPanel(
  {
    ptyId,
    cwd,
    hostname,
    active = true
  }: {
    ptyId: string
    cwd: string
    hostname?: string | null
    active?: boolean
  },
  ref: ForwardedRef<TerminalPanelHandle>
): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const { config } = useConfig()
  const [connState, setConnState] = useState<ConnState>('connecting')
  const connStateRef = useRef<ConnState>('connecting')
  const disposedRef = useRef(false)
  const reconnectingRef = useRef(false)
  const spawnOptsRef = useRef({ ptyId, cwd, hostname })
  spawnOptsRef.current = { ptyId, cwd, hostname }

  const setConn = useCallback((next: ConnState) => {
    connStateRef.current = next
    setConnState(next)
  }, [])

  const spawnPty = useCallback(async (): Promise<void> => {
    const term = termRef.current
    const fitAddon = fitAddonRef.current
    const { ptyId: id, cwd: spawnCwd, hostname: spawnHost } = spawnOptsRef.current
    const dims = fitAddon?.proposeDimensions()
    const cols = dims?.cols || term?.cols || 100
    const rows = dims?.rows || term?.rows || 30
    await window.atelier.ptySpawn({
      id,
      cwd: spawnCwd,
      hostname: spawnHost ?? null,
      cols,
      rows
    })
    if (term) void window.atelier.ptyResize(id, term.cols, term.rows)
  }, [])

  const reconnect = useCallback(async (): Promise<void> => {
    if (disposedRef.current || reconnectingRef.current) return
    reconnectingRef.current = true
    setConn('reconnecting')
    try {
      await spawnPty()
      if (disposedRef.current) return
      setConn('live')
      termRef.current?.focus()
    } catch {
      if (!disposedRef.current) setConn('disconnected')
    } finally {
      reconnectingRef.current = false
    }
  }, [setConn, spawnPty])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    disposedRef.current = false
    reconnectingRef.current = false
    // Stay non-live until the first spawn succeeds so keystrokes are not
    // silently dropped into a missing pty (write no-ops when no entry).
    setConn('connecting')

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: config.fontSizes.terminal,
      theme: readTheme(container),
      cursorBlink: true,
      allowProposedApi: true,
      // Make the Option key send ESC-prefixed sequences so that readline/zsh
      // interprets it as Meta: opt+f → forward-word, opt+b → backward-word,
      // opt+d → delete-word, etc. Without this, macOS swallows alt+key and
      // the shell never sees the Meta sequences.
      macOptionIsMeta: true
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(container)
    termRef.current = term
    fitAddonRef.current = fitAddon

    void spawnPty()
      .then(() => {
        if (disposedRef.current) return
        setConn('live')
        if (active) term.focus()
      })
      .catch(() => {
        if (!disposedRef.current) setConn('disconnected')
      })

    const dataDisposable = term.onData((data) => {
      if (connStateRef.current !== 'live') return
      void window.atelier.ptyWrite(ptyId, data)
    })
    const unsubData = window.atelier.onPtyData(({ id, data }) => {
      if (id !== ptyId) return
      term.write(data)
    })
    const unsubExit = window.atelier.onPtyExit(({ id }) => {
      if (id !== ptyId || disposedRef.current) return
      void reconnect()
    })

    fitAddon.fit()
    void window.atelier.ptyResize(ptyId, term.cols, term.rows)

    return () => {
      disposedRef.current = true
      unsubExit()
      unsubData()
      dataDisposable.dispose()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
      void window.atelier.ptyKill(ptyId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId])

  // Becoming the visible tab/drawer (or first mounting as one) should behave
  // like a real terminal: typing should work right away, not only after an
  // extra click. Without this, clicking the "Terminal" tab button leaves
  // keyboard focus on that <button> (browser default), so keystrokes never
  // reach xterm's internal textarea at all — reported as "can't type
  // anything". Re-fitting here also matters because the terminal tab-content
  // gets a `hidden` class while inactive, so a hidden container can't report
  // a useful size to ResizeObserver the moment it becomes visible again.
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    const fitAddon = fitAddonRef.current
    if (!term || !fitAddon) return
    // Only auto-focus if focus is not already held by a different app panel.
    // This prevents stealing focus from chat when ^X O cycles past the last
    // terminal sub-pane and jumps to chat (the sub-pane state resets, making
    // this pane "active" again, which would otherwise re-steal focus).
    const focused = document.activeElement
    const focusedPanel = focused?.closest?.('[data-panel]')?.getAttribute('data-panel')
    if (focusedPanel && focusedPanel !== 'terminal') {
      fitAddon.fit()
      void window.atelier.ptyResize(ptyId, term.cols, term.rows)
      return
    }
    if (connStateRef.current === 'live') term.focus()
    fitAddon.fit()
    void window.atelier.ptyResize(ptyId, term.cols, term.rows)
  }, [active, ptyId])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => {
      const term = termRef.current
      const fitAddon = fitAddonRef.current
      if (!term || !fitAddon) return
      fitAddon.fit()
      void window.atelier.ptyResize(ptyId, term.cols, term.rows)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [ptyId])

  useEffect(() => {
    const term = termRef.current
    const fitAddon = fitAddonRef.current
    const container = containerRef.current
    if (!term || !fitAddon || !container) return
    term.options.theme = readTheme(container)
    term.options.fontSize = config.fontSizes.terminal
    fitAddon.fit()
    void window.atelier.ptyResize(ptyId, term.cols, term.rows)
  }, [config.theme, config.fontSizes.terminal, ptyId])

  useImperativeHandle(ref, () => ({
    injectCommand(command: string) {
      const term = termRef.current
      if (!term || connStateRef.current !== 'live') return
      term.paste(command)
      term.focus()
    },
    focus() {
      if (connStateRef.current === 'live') termRef.current?.focus()
    }
  }))

  return (
    <div className="term-body-wrap" data-testid={active ? 'terminal-body-wrap' : undefined}>
      <div
        ref={containerRef}
        className="term-body"
        data-hint-exclude-root=""
        data-testid={active ? 'terminal-body' : undefined}
      />
      {connState === 'reconnecting' || connState === 'disconnected' ? (
        <div className="term-reconnect-overlay" data-testid="terminal-reconnect-overlay">
          <span className="term-reconnect-message">
            {connState === 'reconnecting' ? 'Reconnecting…' : 'Terminal disconnected'}
          </span>
          {connState === 'disconnected' ? (
            <button
              type="button"
              className="btn btn-sm"
              data-testid="terminal-reconnect-button"
              onClick={() => void reconnect()}
            >
              Reconnect
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

export default TerminalPanel
