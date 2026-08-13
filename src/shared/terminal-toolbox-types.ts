export interface TerminalToolboxCommand {
  id: string
  label: string
  command: string
}

export interface TerminalToolboxConfig {
  commands: TerminalToolboxCommand[]
}

export const DEFAULT_TERMINAL_TOOLBOX_COMMANDS: TerminalToolboxCommand[] = [
  { id: 'default-git-status', label: 'git status', command: 'git status' },
  { id: 'default-npm-build', label: 'npm run build', command: 'npm run build' }
]
