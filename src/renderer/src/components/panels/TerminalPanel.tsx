import { useEffect, useRef, useState } from 'react'

// Strips common ANSI escape sequences (CSI/OSC) so a real pty's output is
// readable in a plain `<pre>` without implementing a full terminal emulator
// (spec: real pty required, full VT100 rendering is not — see progress.md).
// Built via RegExp() rather than a literal to keep raw control characters
// (ESC, CSI) out of the source text itself.
const ANSI_RE = new RegExp('[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:;\\d{0,4})*)?[a-zA-Z]', 'g')

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r/g, '')
}

/**
 * Real terminal surface (07-secondary-panels §5): spawns/attaches a real
 * `node-pty` process keyed by `ptyId` (see main/panels/pty.ts) and streams
 * its actual output. Used both for creation-time "Terminal-only" sessions
 * (mounted as the session's whole main view) and the companion terminal
 * drawer — the two never share a pty id, so they're genuinely independent
 * shells.
 */
export default function TerminalPanel({
  ptyId,
  cwd,
  hostname,
  active = true
}: {
  ptyId: string
  cwd: string
  hostname?: string | null
  active?: boolean
}): JSX.Element {
  const [output, setOutput] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.gardenia.ptySpawn({ id: ptyId, cwd, hostname: hostname ?? null, cols: 100, rows: 30 })
    const unsub = window.gardenia.onPtyData(({ id, data }) => {
      if (id !== ptyId) return
      setOutput((prev) => (prev + stripAnsi(data)).slice(-200_000))
    })
    return () => {
      unsub()
      void window.gardenia.ptyKill(ptyId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId])

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight
  }, [output])

  // Becoming the visible tab/drawer (or first mounting as one) should behave
  // like a real terminal: typing should work right away, not only after an
  // extra click. Without this, clicking the "Terminal" tab button leaves
  // keyboard focus on that <button> (browser default), so keystrokes never
  // reach this panel's onKeyDown at all — reported as "can't type anything".
  useEffect(() => {
    if (active) bodyRef.current?.focus()
  }, [active])

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void {
    e.preventDefault()
    if (e.key === 'Enter') {
      void window.gardenia.ptyWrite(ptyId, '\r')
    } else if (e.key === 'Backspace') {
      void window.gardenia.ptyWrite(ptyId, '\x7f')
    } else if (e.key === 'Tab') {
      void window.gardenia.ptyWrite(ptyId, '\t')
    } else if (e.ctrlKey && e.key.length === 1) {
      const code = e.key.toUpperCase().charCodeAt(0) - 64
      if (code >= 0 && code < 32) void window.gardenia.ptyWrite(ptyId, String.fromCharCode(code))
    } else if (e.key.length === 1) {
      void window.gardenia.ptyWrite(ptyId, e.key)
    }
  }

  return (
    <div
      ref={bodyRef}
      className="term-body"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={() => bodyRef.current?.focus()}
      data-testid="terminal-body"
    >
      {output}
      <span className="cursor-block" />
    </div>
  )
}
