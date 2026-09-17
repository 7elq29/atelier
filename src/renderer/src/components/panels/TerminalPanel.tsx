import { forwardRef, useEffect, useImperativeHandle, useRef, type ForwardedRef } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useConfig } from '../../hooks/useConfig'
import '@xterm/xterm/css/xterm.css'

function readTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
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
 * component only wires it to the pty IPC bridge. Used both for creation-time
 * "Terminal-only" sessions (mounted as the session's whole main view) and
 * the companion terminal drawer — the two never share a pty id, so they're
 * genuinely independent shells.
 */
export interface TerminalPanelHandle {
  injectCommand: (command: string) => void
  focus: () => void
}

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

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
      fontSize: config.fontSizes.terminal,
      theme: readTheme(),
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

    const dims = fitAddon.proposeDimensions()
    const cols = dims?.cols || 100
    const rows = dims?.rows || 30
    void window.atelier.ptySpawn({ id: ptyId, cwd, hostname: hostname ?? null, cols, rows })

    const dataDisposable = term.onData((data) => {
      void window.atelier.ptyWrite(ptyId, data)
    })
    const unsub = window.atelier.onPtyData(({ id, data }) => {
      if (id !== ptyId) return
      term.write(data)
    })

    fitAddon.fit()
    void window.atelier.ptyResize(ptyId, term.cols, term.rows)

    return () => {
      unsub()
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
    term.focus()
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
    if (!term || !fitAddon) return
    term.options.theme = readTheme()
    term.options.fontSize = config.fontSizes.terminal
    fitAddon.fit()
    void window.atelier.ptyResize(ptyId, term.cols, term.rows)
  }, [config.theme, config.fontSizes.terminal, ptyId])

  useImperativeHandle(ref, () => ({
    injectCommand(command: string) {
      const term = termRef.current
      if (!term) return
      term.paste(command)
      term.focus()
    },
    focus() {
      termRef.current?.focus()
    }
  }))

  return (
    <div
      ref={containerRef}
      className="term-body"
      data-hint-exclude-root=""
      data-testid={active ? 'terminal-body' : undefined}
    />
  )
})

export default TerminalPanel
