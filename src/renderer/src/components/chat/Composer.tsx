import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { FileTreeNode } from '../../../../shared/panel-types'

/** Cap in px for the textarea's auto-grow, per mocks/index.html's `.composer-box textarea { max-height: 160px }`. */
const MAX_TEXTAREA_HEIGHT = 160

/** Cap on how many `@file` matches are rendered at once — the underlying file walk is already capped (files.ts's MAX_ENTRIES), this just keeps the popover itself short and scannable. */
const MAX_MENTION_MATCHES = 20

interface ComposerProps {
  value: string
  onChange: (text: string) => void
  onSend: (text: string) => void
  onInterrupt: () => void
  /** True while a turn is in flight for the active session — swaps Send for Stop, per e2e-test-plan.md/spec.md. */
  busy: boolean
  /** Active session's project root — `@file` mentions are resolved (real, live `fs` walk via the existing Files-panel IPC) against this. Undefined/empty just disables the mention popover. */
  projectPath?: string
  /** `/fork` slash command's real action: forks the active session (same as the sidebar's fork action). */
  onFork: () => void
}

/** Flattens the Files-panel's real `fs`-backed tree (07-secondary-panels) into a flat list of `relativePath`s, files only — dirs aren't mentionable. */
function flattenFiles(nodes: FileTreeNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.type === 'file') acc.push(node.relativePath)
    else if (node.children) flattenFiles(node.children, acc)
  }
  return acc
}

interface SlashCommand {
  cmd: string
  desc: string
  run: () => void
}

type PopoverState = { kind: 'mention' | 'slash'; query: string; tokenStart: number } | null

/**
 * Composer core (04-composer-core) + `@file` mention / `/` slash-command
 * autocomplete (10e-enrichment-file-mentions-and-commands): multi-line
 * auto-grow textarea (Enter sends, Shift+Enter inserts a newline), a real
 * Send/Stop pill that swaps based on `busy`, and two live popovers that
 * trigger on keystroke — matching `mocks/index.html`'s
 * `.mention-popup`/`.slash-popup` markup+CSS and keyboard-nav interaction
 * pattern lifted from CommandPalette.tsx (arrows to move, Enter/Tab to
 * select, Escape to dismiss).
 *
 * `@partial` anywhere in the text opens a popover of REAL files under the
 * session's `projectPath` (reusing the Files panel's own `filesTree` IPC —
 * no separate file-walking implementation), filtered by substring on
 * `relativePath`/name, same `.includes()` filtering CommandPalette already
 * uses. Selecting one replaces the partial token with `@relative/path `.
 *
 * `/partial` only triggers when it's the very first token in the composer
 * (matches the mock's `val.trim() === lastWord` guard — a slash command is
 * the whole input, not a token mid-sentence) and opens a small, fixed set of
 * REAL actions (not a plugin/registration framework, per spec: "don't
 * over-engineer"):
 *   - `/clear`     — clears the composer (same as selecting-all + delete)
 *   - `/interrupt` — stops the current in-flight turn (same real IPC as the Stop button)
 *   - `/fork`      — forks the active session (same real IPC as the sidebar's fork action)
 * Selecting a slash command removes the typed token from the composer and
 * actually runs the action — unlike the static mock (which just inserts the
 * command text), this must be a real action per spec.
 *
 * Sending while `busy` is intentionally NOT held back client-side: per
 * spec.md/e2e-test-plan.md this must inject live into the still-streaming
 * turn (`SessionManager.sendUserMessage` -> `harness.streamInput()` on the
 * turn's still-open input queue, verified for real against the SDK — see
 * that function's doc comment), not queue-and-wait. The mock's own
 * `sendMessage()` shows a "queued — will be delivered..." card while
 * working; that's superseded here by the real live-injection behavior this
 * task requires, so a follow-up sent while busy renders as an ordinary
 * message immediately, just like an idle send. The Send button itself is
 * hidden while busy (matching the mock's `setWorking()` toggle exactly),
 * but Enter still submits — same as the mock's `onComposerKeydown`, which
 * calls `sendMessage()` unconditionally regardless of working state.
 */
export default function Composer({ value, onChange, onSend, onInterrupt, busy, projectPath, onFork }: ComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [popover, setPopover] = useState<PopoverState>(null)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [fileList, setFileList] = useState<string[]>([])

  // Real file list for @-mentions: same IPC the Files panel (07) already
  // uses to walk the session's real project_path on disk — no fixture/fake
  // list, no second file-walking implementation.
  useEffect(() => {
    let cancelled = false
    if (!projectPath) {
      setFileList([])
      return undefined
    }
    window.gardenia.filesTree(projectPath).then((tree) => {
      if (!cancelled) setFileList(flattenFiles(tree))
    })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const slashCommands: SlashCommand[] = useMemo(
    () => [
      { cmd: '/clear', desc: 'Clear the composer', run: () => onChange('') },
      { cmd: '/interrupt', desc: 'Stop the current in-flight turn', run: () => onInterrupt() },
      { cmd: '/fork', desc: 'Fork this session into a new one', run: () => onFork() }
    ],
    [onChange, onInterrupt, onFork]
  )

  // Auto-grow: mirrors mocks/index.html's onComposerInput exactly —
  // `height = 'auto'` first (so shrinking on delete works, not just
  // growing), then clamp to the 160px cap; beyond that the textarea's own
  // `overflow` (default for a textarea) scrolls instead of growing further.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [value])

  const mentionMatches = useMemo(() => {
    if (popover?.kind !== 'mention') return []
    const q = popover.query.toLowerCase()
    return fileList.filter((f) => f.toLowerCase().includes(q)).slice(0, MAX_MENTION_MATCHES)
  }, [popover, fileList])

  const slashMatches = useMemo(() => {
    if (popover?.kind !== 'slash') return []
    const q = popover.query.toLowerCase()
    return slashCommands.filter((c) => c.cmd.slice(1).startsWith(q))
  }, [popover, slashCommands])

  const activeMatches: (string | SlashCommand)[] =
    popover?.kind === 'mention' ? mentionMatches : popover?.kind === 'slash' ? slashMatches : []

  function handleSend(): void {
    const text = value.trim()
    if (!text) return
    onSend(text)
  }

  /** Recomputes trigger state from the token immediately before the cursor — re-run on every keystroke, mirroring the mock's `onComposerInput`, but cursor-anchored rather than end-of-value-anchored so it still works if the user edits mid-string. */
  function updatePopoverFromCursor(text: string, cursor: number): void {
    const before = text.slice(0, cursor)
    const tokenStart = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\n')) + 1
    const token = before.slice(tokenStart)

    if (token.startsWith('@')) {
      setPopover({ kind: 'mention', query: token.slice(1), tokenStart })
      setSelectedIndex(0)
      return
    }
    // Slash commands only trigger as the very first token of the composer
    // (mock's `val.trim() === lastWord` guard) — a `/` mid-sentence is just
    // a character, not a command.
    if (token.startsWith('/') && tokenStart === 0) {
      setPopover({ kind: 'slash', query: token.slice(1), tokenStart })
      setSelectedIndex(0)
      return
    }
    setPopover(null)
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>): void {
    const text = e.target.value
    onChange(text)
    updatePopoverFromCursor(text, e.target.selectionStart ?? text.length)
  }

  function selectMention(path: string): void {
    if (!popover) return
    const ta = textareaRef.current
    const cursor = ta?.selectionStart ?? value.length
    const before = value.slice(0, popover.tokenStart)
    const after = value.slice(cursor)
    const inserted = `@${path} `
    onChange(before + inserted + after)
    setPopover(null)
    const newCursor = before.length + inserted.length
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(newCursor, newCursor)
    })
  }

  function selectSlash(command: SlashCommand): void {
    if (!popover) return
    const ta = textareaRef.current
    const cursor = ta?.selectionStart ?? value.length
    const before = value.slice(0, popover.tokenStart)
    const after = value.slice(cursor)
    // Unlike the static mock (which just inserts the command text), this
    // must run a real action — so the typed `/token` is removed rather than
    // left sitting in the composer as literal text to send.
    onChange(before + after)
    setPopover(null)
    command.run()
    requestAnimationFrame(() => ta?.focus())
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (popover && activeMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, activeMatches.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const picked = activeMatches[selectedIndex]
        if (popover.kind === 'mention') selectMention(picked as string)
        else selectSlash(picked as SlashCommand)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPopover(null)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer-box">
        {popover?.kind === 'mention' && mentionMatches.length > 0 && (
          <div className="mention-popup" data-testid="mention-popover">
            {mentionMatches.map((path, idx) => {
              const name = path.split('/').pop() ?? path
              return (
                <div
                  key={path}
                  className={`mention-item${idx === selectedIndex ? ' selected' : ''}`}
                  data-testid="mention-item"
                  data-path={path}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onMouseDown={(e) => {
                    // mousedown (not click) so this fires before the
                    // textarea's blur would otherwise dismiss the popover.
                    e.preventDefault()
                    selectMention(path)
                  }}
                >
                  <span>{name}</span>
                  <span className="fpath">{path}</span>
                </div>
              )
            })}
          </div>
        )}
        {popover?.kind === 'slash' && slashMatches.length > 0 && (
          <div className="slash-popup" data-testid="slash-popover">
            {slashMatches.map((command, idx) => (
              <div
                key={command.cmd}
                className={`slash-item${idx === selectedIndex ? ' selected' : ''}`}
                data-testid="slash-item"
                data-command={command.cmd}
                onMouseEnter={() => setSelectedIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  selectSlash(command)
                }}
              >
                <span className="cmd">{command.cmd}</span>
                <span className="cmddesc">{command.desc}</span>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          data-testid="composer-input"
          placeholder="Message Gardenia…"
          rows={1}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
        />
        <div className="composer-footer">
          <div className="spacer" />
          {busy && (
            <span className="working-pill" data-testid="composer-working-pill">
              <span className="spinner" />
              Working…
            </span>
          )}
          {busy ? (
            <button className="stop-btn" data-testid="stop-button" onClick={onInterrupt}>
              ⏹ Stop
            </button>
          ) : (
            <button
              className="send-btn"
              data-testid="send-button"
              disabled={!value.trim()}
              title="Send (Enter)"
              onClick={handleSend}
            >
              <svg className="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="6 11 12 5 18 11" />
              </svg>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
