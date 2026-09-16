/**
 * Shared config shape for main, preload, and renderer. Pure types + a default
 * value object — no Electron/Node imports here so it can be pulled into any
 * of the three processes without pulling in unwanted runtime deps.
 */

import type { EffortLevel, PermissionModeValue } from './session-types'
import type { SessionProfile } from './session-profile-types'
import type { TerminalToolboxConfig } from './terminal-toolbox-types'
import { DEFAULT_TERMINAL_TOOLBOX_COMMANDS } from './terminal-toolbox-types'

export type { SessionProfile } from './session-profile-types'

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

export interface VaultConfig {
  /** Absolute path to the Obsidian vault root. Empty string = not configured. */
  root: string
  /** Folder inside the vault root where daily notes live, e.g. "01.dailynotes". */
  dailyNotesFolder: string
  /** Folder inside the vault root containing Markdown notes managed by Atelier. */
  appNotesFolder: string
  /** Internal marker preventing legacy database notes from being re-imported after deletion. */
  appNotesMigrated: boolean
  /**
   * Path pattern relative to dailyNotesFolder. Tokens: {yyyy} {MMM} {ww} {date}.
   * e.g. "{yyyy}/{MMM}/{ww}/{date}.md"
   */
  notePathPattern: string
  /** Vault-relative path to the daily note template. Empty = use built-in skeleton. */
  templatePath: string
}

/** Harness / composer fallback when no per-session model is stored. */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5'

export function defaultClaudeModelFromConfig(config: Pick<AtelierConfig, 'defaultClaudeModel'>): string {
  const trimmed = config.defaultClaudeModel?.trim()
  return trimmed || DEFAULT_CLAUDE_MODEL
}

export const DEFAULT_CLAUDE_EFFORT: EffortLevel = 'high'

export function defaultClaudeEffortFromConfig(config: Pick<AtelierConfig, 'defaultClaudeEffort'>): EffortLevel {
  return config.defaultClaudeEffort ?? DEFAULT_CLAUDE_EFFORT
}

/** Curated effort tiers for Settings and the composer picker (matches mocks). */
export const DEFAULT_CLAUDE_EFFORT_OPTIONS: { id: EffortLevel; label: string }[] = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' }
]

/** Composer / SDK permission mode for new agent sessions when config does not override. */
export const DEFAULT_CLAUDE_PERMISSION_MODE: PermissionModeValue = 'default'

export function defaultClaudePermissionModeFromConfig(
  config: Pick<AtelierConfig, 'defaultClaudePermissionMode'>
): PermissionModeValue {
  return config.defaultClaudePermissionMode ?? DEFAULT_CLAUDE_PERMISSION_MODE
}

/** Curated permission modes for Settings (matches composer mode pill labels). */
export const DEFAULT_CLAUDE_PERMISSION_MODE_OPTIONS: { id: PermissionModeValue; label: string }[] = [
  { id: 'default', label: 'Default' },
  { id: 'plan', label: 'Plan mode' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'auto', label: 'Auto' }
]

export interface AtelierConfig {
  /** First-run wizard has been completed — never show it again once true. */
  onboardingCompleted: boolean
  theme: ThemeMode
  sidebarCollapsed: boolean
  /**
   * Global default Claude model id for new agent sessions and harness starts
   * when no per-session override exists. Validated via SDK before save in Settings.
   */
  defaultClaudeModel: string
  /** Global default reasoning effort for new agent sessions (SDK `effort`). */
  defaultClaudeEffort: EffortLevel
  /** Global default SDK permission mode for new Claude Code sessions. */
  defaultClaudePermissionMode: PermissionModeValue
  /**
   * Three independent font-size scales. Deliberately three separate numbers
   * (not one shared scale) — terminal, general interface chrome, and
   * agent/assistant chat messages are allowed to diverge from each other.
   */
  fontSizes: FontSizes
  gitIdentity: GitIdentity
  vault: VaultConfig
  /**
   * Parent directory for session git worktrees (use-worktree). Each session
   * gets `<worktreeRoot>/<session-id>`. Supports `~` on local and remote hosts.
   */
  worktreeRoot: string
  /** Saved shell snippets — double-click in toolbox pastes into the active terminal. */
  terminalToolbox: TerminalToolboxConfig
  /** Named workspace + file-directory bundles for New Session and Files tab. */
  sessionProfiles: SessionProfile[]
}

export const DEFAULT_CONFIG: AtelierConfig = {
  onboardingCompleted: false,
  theme: 'dark',
  sidebarCollapsed: false,
  defaultClaudeModel: DEFAULT_CLAUDE_MODEL,
  defaultClaudeEffort: DEFAULT_CLAUDE_EFFORT,
  defaultClaudePermissionMode: DEFAULT_CLAUDE_PERMISSION_MODE,
  fontSizes: {
    terminal: 14,
    interface: 14,
    agentMessage: 15.5
  },
  gitIdentity: {
    name: '',
    email: ''
  },
  vault: {
    root: '',
    dailyNotesFolder: '01.dailynotes',
    appNotesFolder: 'Atelier',
    appNotesMigrated: false,
    notePathPattern: '{yyyy}/{MMM}/{ww}/{date}.md',
    templatePath: '92.templates/Daily Note Template.md'
  },
  worktreeRoot: '~/.atelier/worktrees',
  terminalToolbox: {
    commands: [...DEFAULT_TERMINAL_TOOLBOX_COMMANDS]
  },
  sessionProfiles: []
}
