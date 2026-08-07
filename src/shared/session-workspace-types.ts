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
