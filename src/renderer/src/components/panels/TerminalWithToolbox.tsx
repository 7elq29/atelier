import { type ForwardedRef, forwardRef, useCallback, useImperativeHandle, useState } from 'react'
import { DEFAULT_TERMINAL_TOOLBOX_COMMANDS } from '../../../../shared/terminal-toolbox-types'
import {
  type TerminalPaneNode,
  countPanes,
  firstPaneId,
  removePaneNode,
  splitPaneNode,
  updateSplitRatio,
  walkPaneIds,
} from '../../../../shared/terminal-split-types'
import { useConfig } from '../../hooks/useConfig'
import TerminalSplitLayout from './TerminalSplitLayout'
import TerminalPanelHeader, { IconToolbox } from './TerminalPanelHeader'
import TerminalToolboxPanel from './TerminalToolboxPanel'

export interface TerminalWithToolboxHandle {
  injectCommand: (command: string) => void
  focus: () => void
  splitRight: () => void
  splitBelow: () => void
  closeFocused: () => void
  cycleFocusedPane: () => boolean  // returns true if it wrapped past the last pane
  hasSplit: () => boolean
}

function makeRootPane(ptyId: string): TerminalPaneNode & { type: 'pane' } {
  return { type: 'pane', id: 'root', ptyId }
}

function makeSubPaneId(): string {
  return `sp-${crypto.randomUUID().slice(0, 8)}`
}

const TerminalWithToolbox = forwardRef(function TerminalWithToolbox(
  {
    ptyId,
    cwd,
    hostname,
    shellRemoteHost,
    variant = 'default',
    active = true,
    onClose
  }: {
    ptyId: string
    cwd: string
    hostname?: string | null
    shellRemoteHost?: string | null
    variant?: 'default' | 'companion'
    active?: boolean
    onClose?: () => void
  },
  ref: ForwardedRef<TerminalWithToolboxHandle>
): JSX.Element {
  const { config, updateConfig } = useConfig()
  const [toolboxOpen, setToolboxOpen] = useState(false)
  const [paneTree, setPaneTree] = useState<TerminalPaneNode>(() => makeRootPane(ptyId))
  const [focusedPaneId, setFocusedPaneId] = useState<string>('root')

  const commands = config.terminalToolbox?.commands?.length
    ? config.terminalToolbox.commands
    : DEFAULT_TERMINAL_TOOLBOX_COMMANDS

  const saveCommands = useCallback(
    (next: typeof commands) => {
      void updateConfig({ terminalToolbox: { commands: next } })
    },
    [updateConfig]
  )

  const toggleToolbox = (): void => setToolboxOpen((o) => !o)

  // ── Split operations ──────────────────────────────────────────────────────

  const handleSplit = useCallback((id: string, dir: 'row' | 'col'): void => {
    const newPaneId = makeSubPaneId()
    const splitId = makeSubPaneId()
    const newPane: TerminalPaneNode & { type: 'pane' } = {
      type: 'pane',
      id: newPaneId,
      ptyId: `${ptyId}:${newPaneId}`,
    }
    setPaneTree((prev) => splitPaneNode(prev, id, dir, newPane, splitId))
    setFocusedPaneId(newPaneId)
  }, [ptyId])

  const handleClose = useCallback((id: string): void => {
    setPaneTree((prev) => {
      if (countPanes(prev) <= 1) return prev
      const next = removePaneNode(prev, id)
      if (next === null) return prev
      setFocusedPaneId(firstPaneId(next))
      return next
    })
  }, [])

  const handleRatioChange = useCallback((splitId: string, ratio: number): void => {
    setPaneTree((prev) => updateSplitRatio(prev, splitId, ratio))
  }, [])

  // ── Imperative handle ─────────────────────────────────────────────────────

  useImperativeHandle(ref, () => ({
    injectCommand(cmd: string) {
      // Inject into focused pane via ptyWrite
      const focusedPtyId = getFocusedPtyId(paneTree, focusedPaneId)
      if (focusedPtyId) void window.atelier.ptyWrite(focusedPtyId, cmd)
    },
    focus() {
      // xterm renders a hidden textarea (.xterm-helper-textarea) that receives key events
      const textarea = document.querySelector<HTMLElement>(
        `[data-pane-id="${focusedPaneId}"] .xterm-helper-textarea`
      )
      textarea?.focus()
    },
    splitRight() {
      handleSplit(focusedPaneId, 'row')
    },
    splitBelow() {
      handleSplit(focusedPaneId, 'col')
    },
    closeFocused() {
      handleClose(focusedPaneId)
    },
    cycleFocusedPane() {
      const ids = walkPaneIds(paneTree)
      const idx = ids.indexOf(focusedPaneId)
      const atLast = idx === ids.length - 1
      const next = ids[(idx + 1) % ids.length]
      setFocusedPaneId(next)
      if (!atLast) {
        // Move DOM focus to the next pane's textarea so the user can type there
        const ta = document.querySelector<HTMLElement>(
          `[data-pane-id="${next}"] .xterm-helper-textarea`
        )
        ta?.focus()
      }
      return atLast
    },
    hasSplit() {
      return countPanes(paneTree) > 1
    },
  }), [focusedPaneId, paneTree, handleSplit, handleClose])

  const multiPane = countPanes(paneTree) > 1

  return (
    <div className="term-shell" data-cwd={cwd} data-panel="terminal">
      <div className="term-shell-main">
        {variant === 'companion' ? (
          <TerminalPanelHeader
            cwd={cwd}
            hostname={hostname}
            shellRemoteHost={shellRemoteHost}
            variant={variant}
            toolboxOpen={toolboxOpen}
            onToggleToolbox={toggleToolbox}
            onClose={onClose}
          />
        ) : (
          <>
            <button
              type="button"
              className="term-toolbox-toggle"
              data-testid="terminal-toolbox-toggle"
              title="Command toolbox"
              aria-label="Command toolbox"
              aria-expanded={toolboxOpen}
              onClick={toggleToolbox}
            >
              <IconToolbox />
            </button>
            <button
              type="button"
              className="term-split-btn term-split-btn--below"
              title="Split below (^X 2)"
              onClick={() => handleSplit(focusedPaneId, 'col')}
            >
              ⊟
            </button>
            <button
              type="button"
              className="term-split-btn term-split-btn--right"
              title="Split right (^X 3)"
              onClick={() => handleSplit(focusedPaneId, 'row')}
            >
              ⊞
            </button>
          </>
        )}
        <TerminalSplitLayout
          node={paneTree}
          focusedId={focusedPaneId}
          cwd={cwd}
          hostname={hostname}
          active={active}
          onFocus={setFocusedPaneId}
          onSplit={handleSplit}
          onClose={handleClose}
          onRatioChange={handleRatioChange}
        />
        {multiPane && (
          <div className="term-split-statusbar" data-testid="terminal-split-statusbar">
            {walkPaneIds(paneTree).map((id, i) => (
              <span
                key={id}
                className={`term-split-statusbar-tab${id === focusedPaneId ? ' active' : ''}`}
                onClick={() => setFocusedPaneId(id)}
                role="button"
                tabIndex={-1}
              >
                {i + 1}
              </span>
            ))}
          </div>
        )}
      </div>
      {toolboxOpen ? (
        <TerminalToolboxPanel
          commands={commands}
          onChange={saveCommands}
          onInject={(command) => {
            const focusedPtyId = getFocusedPtyId(paneTree, focusedPaneId)
            if (focusedPtyId) void window.atelier.ptyWrite(focusedPtyId, command)
          }}
        />
      ) : null}
    </div>
  )
})

export default TerminalWithToolbox

// ── Private helpers ────────────────────────────────────────────────────────

function getFocusedPtyId(tree: TerminalPaneNode, focusedId: string): string {
  if (tree.type === 'pane') return tree.id === focusedId ? tree.ptyId : ''
  return getFocusedPtyId(tree.a, focusedId) || getFocusedPtyId(tree.b, focusedId)
}

