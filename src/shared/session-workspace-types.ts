import type { DiffSummary, FileTreeNode, WorkspaceFileEntry } from './panel-types'
import type { SessionChangesCap } from './session-changes-cap'

/** Workspace data loaded at session open and updated via main-process refresh. */
export interface SessionWorkspacePayload {
  sessionId: string
  workspacePath: string
  hostname: string | null
  diff: DiffSummary
  sessionChangesCap: SessionChangesCap
  filesTree: FileTreeNode[]
  filesList: WorkspaceFileEntry[]
  tabTerminalPtyId: string
  loadedAt: number
}

export interface SessionOpenReadyEvent {
  sessionId: string
  workspace: SessionWorkspacePayload
}

export interface SessionWorkspaceUpdatedEvent {
  sessionId: string
  workspace: SessionWorkspacePayload
}

export interface SessionWorkspaceRefreshingEvent {
  sessionId: string
  refreshing: boolean
}

/** In-flight essential preload step (SSH, files, terminal, git probe). */
export type SessionConnectStep = 'ssh' | 'files' | 'terminal' | 'git-probe'

export interface SessionConnectProgressEvent {
  sessionId: string
  step: SessionConnectStep
  /** Human-readable label for the connecting gate. */
  label: string
}

/** Structured connect timing — logged and available to e2e via main.log. */
export interface SessionOpenTimingEvent {
  sessionId: string
  phase: 'essential' | 'background'
  /** Wall-clock ms for the essential path that clears `connecting`. */
  essentialMs: number
  sshWarmMs?: number
  filesTreeMs?: number
  filesListMs?: number
  ptyMs?: number
  gitProbeMs?: number
  /** Full git diff + hunk hydration (background only — must not block connect). */
  backgroundGitMs?: number
  backgroundCapMs?: number
  backgroundTotalMs?: number
  /** True when full diff preload was deferred after openReady. */
  gitDeferred: boolean
}
