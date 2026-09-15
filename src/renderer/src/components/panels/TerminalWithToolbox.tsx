import { type ForwardedRef, forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react'
import { DEFAULT_TERMINAL_TOOLBOX_COMMANDS } from '../../../../shared/terminal-toolbox-types'
import { useConfig } from '../../hooks/useConfig'
import TerminalPanel, { type TerminalPanelHandle } from './TerminalPanel'
import TerminalPanelHeader, { IconToolbox } from './TerminalPanelHeader'
import TerminalToolboxPanel from './TerminalToolboxPanel'

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
  ref: ForwardedRef<TerminalPanelHandle>
): JSX.Element {
  const { config, updateConfig } = useConfig()
  const [toolboxOpen, setToolboxOpen] = useState(false)
  const termRef = useRef<TerminalPanelHandle>(null)

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

  useImperativeHandle(ref, () => ({
    injectCommand: (cmd) => termRef.current?.injectCommand(cmd),
    focus: () => termRef.current?.focus(),
  }))

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
        )}
        <TerminalPanel ref={termRef} ptyId={ptyId} cwd={cwd} hostname={hostname} active={active} />
      </div>
      {toolboxOpen ? (
        <TerminalToolboxPanel
          commands={commands}
          onChange={saveCommands}
          onInject={(command) => termRef.current?.injectCommand(command)}
        />
      ) : null}
    </div>
  )
})

export default TerminalWithToolbox
