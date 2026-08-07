import type { DiffSummary, FileTreeNode, WorkspaceFileEntry } from './panel-types'

/** Workspace data loaded at session open and updated via main-process refresh. */
export interface SessionWorkspacePayload {
  sessionId: string
  workspacePath: string
  hostname: string | null
  diff: DiffSummary
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
