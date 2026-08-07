/**
 * Shared config shape for main, preload, and renderer. Pure types + a default
 * value object — no Electron/Node imports here so it can be pulled into any
 * of the three processes without pulling in unwanted runtime deps.
 */

export type ThemeMode = 'system' | 'light' | 'dark'

export interface FontSizes {
  /** px */
  terminal: number
  /** px */
  interface: number
  /** px */
  agentMessage: number
}

export interface GitIdentity {
  name: string
  email: string
}

export interface AtelierConfig {
  /** First-run wizard has been completed — never show it again once true. */
  onboardingCompleted: boolean
  theme: ThemeMode
  sidebarCollapsed: boolean
  /**
   * Three independent font-size scales. Deliberately three separate numbers
   * (not one shared scale) — terminal, general interface chrome, and
   * agent/assistant chat messages are allowed to diverge from each other.
   */
  fontSizes: FontSizes
  gitIdentity: GitIdentity
}

export const DEFAULT_CONFIG: AtelierConfig = {
  onboardingCompleted: false,
  theme: 'dark',
  sidebarCollapsed: false,
  fontSizes: {
    terminal: 14,
    interface: 14,
    agentMessage: 15.5
  },
  gitIdentity: {
    name: '',
    email: ''
  }
}
