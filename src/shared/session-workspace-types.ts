import type { DiffSummary, FileTreeNode, WorkspaceFileEntry } from './panel-types'
import type { SessionFileEdit } from './session-file-edits'

/** Workspace data loaded at session open and updated via main-process refresh. */
export interface SessionWorkspacePayload {
  sessionId: string
  workspacePath: string
  hostname: string | null
  diff: DiffSummary
  /** Files edited in this session via Claude file-edit tools (chat changes cap). */
  sessionFileEdits: SessionFileEdit[]
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
