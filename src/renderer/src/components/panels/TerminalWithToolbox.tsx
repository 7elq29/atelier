import { useCallback, useRef, useState } from 'react'
import { DEFAULT_TERMINAL_TOOLBOX_COMMANDS } from '../../../../shared/terminal-toolbox-types'
import { useConfig } from '../../hooks/useConfig'
import TerminalPanel, { type TerminalPanelHandle } from './TerminalPanel'
import TerminalPanelHeader from './TerminalPanelHeader'
import TerminalToolboxPanel from './TerminalToolboxPanel'

export default function TerminalWithToolbox({
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
}): JSX.Element {
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

  return (
    <div className="term-shell">
      <div className="term-shell-main">
        <TerminalPanelHeader
          cwd={cwd}
          hostname={hostname}
          shellRemoteHost={shellRemoteHost}
          variant={variant}
          toolboxOpen={toolboxOpen}
          onToggleToolbox={() => setToolboxOpen((o) => !o)}
          onClose={onClose}
        />
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
}
