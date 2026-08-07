import { contextBridge, ipcRenderer } from 'electron'
import type { AtelierConfig } from '../shared/config'
import type { DailyNote, ReadDailyNoteResult } from '../shared/daily-note-types'
import type {
  CreateSessionOptions,
  ImageAttachment,
  MessageRecord,
  ModelSelection,
  MessageSearchHit,
  PromptDecision,
  RemoteHostOption,
  SessionCommandsEvent,
  SessionHarnessCwdEvent,
  SessionGroupEvent,
  SessionGroupRecord,
  SessionLifecycleEvent,
  SessionRecord,
  SessionStaleEvent,
  SessionStatus,
  SessionStatusEvent,
  SessionStreamDeltaEvent,
  SessionStreamEvent,
  SessionTokenUsageEvent,
  SessionTurnStateEvent,
  SessionWorktreeProgressEvent,
  ModelValidationResult
} from '../shared/session-types'
import type {
  CommitInfo,
  DiffFileChange,
  DiffFileContentPair,
  DiffFileStatus,
  DiffSummary,
  FileReadResult,
  FileTreeNode,
  FileWriteResult,
  PortForward,
  WorktreeInfo,
  WorkspaceFileEntry
} from '../shared/panel-types'
import type { SpendStatus } from '../shared/spend-status-types'
import type { AppNoteRecord, AppNoteUpdate } from '../shared/app-note-types'
import type { ProjectPathSuggestion } from '../shared/project-path-autocomplete'
import type {
  SessionOpenReadyEvent,
  SessionWorkspacePayload,
  SessionWorkspaceUpdatedEvent
} from '../shared/session-workspace-types'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const api = {
  /** Round-trip IPC call to main: asks for the real app version string. */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  /** Path of the main-process structured log file, for debugging/e2e use. */
  getLogFilePath: (): Promise<string> => ipcRenderer.invoke('app:getLogFilePath'),
  getHomedir: (): Promise<string> => ipcRenderer.invoke('app:getHomedir'),
  /** Forward a structured log line from the renderer to the main-process logger. */
  log: (level: LogLevel, msg: string, extra?: Record<string, unknown>): void => {
    ipcRenderer.send('renderer:log', { level, msg, extra })
  },
  /** Reads the persisted app config (theme, font sizes, onboarding flag, etc). */
  getConfig: (): Promise<AtelierConfig> => ipcRenderer.invoke('config:get'),
  /** Merges + persists a partial config update, returns the resulting full config. */
  setConfig: (partial: Partial<AtelierConfig>): Promise<AtelierConfig> =>
    ipcRenderer.invoke('config:set', partial),
  /** Validates a global default model id against the live SDK (Settings). */
  validateClaudeModel: (model: string): Promise<ModelValidationResult> =>
    ipcRenderer.invoke('config:validateClaudeModel', model),
  /** Debug-only: fires a real OS notification via Electron's Notification API. */
  debugNotify: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke('notification:debugTrigger', { title, body }),

  // ── Daily notes (Obsidian integration) ──────────────────────────
  getVaultRoot: (): Promise<string | null> => ipcRenderer.invoke('daily-note:getVaultRoot'),
  pickVaultRoot: (): Promise<string | null> => ipcRenderer.invoke('daily-note:pickVaultRoot'),
  getDefaultDate: (): Promise<string> => ipcRenderer.invoke('daily-note:getDefaultDate'),
  readDailyNote: (date: string): Promise<ReadDailyNoteResult> => ipcRenderer.invoke('daily-note:read', date),
  createDailyNote: (date: string): Promise<ReadDailyNoteResult> => ipcRenderer.invoke('daily-note:create', date),
  writeDailyNote: (date: string, note: DailyNote): Promise<{ note: DailyNote }> =>
    ipcRenderer.invoke('daily-note:write', date, note),
  watchDailyNote: (date: string): Promise<void> => ipcRenderer.invoke('daily-note:watch', date),
  unwatchDailyNote: (): Promise<void> => ipcRenderer.invoke('daily-note:unwatch'),
  onDailyNoteChanged: (callback: (note: DailyNote) => void): (() => void) => {
    const listener = (_event: unknown, note: DailyNote): void => callback(note)
    ipcRenderer.on('daily-note:changed', listener)
    return () => ipcRenderer.removeListener('daily-note:changed', listener)
  },
  /** Test-only: delays the next write-daily-note call. No-op if not registered (test builds only). */
  testDelayNextWrite: (ms: number): Promise<void> => ipcRenderer.invoke('daily-note:testDelayNextWrite', ms),
  /** 16-task-move-to-date: moves a task from sourceDate's note to targetDate's note's Backlog, creating targetDate's note from the template if needed. */
  moveTaskToDate: (
    sourceDate: string,
    taskId: string,
    targetDate: string
  ): Promise<{ sourceNote: DailyNote; targetNote: DailyNote }> =>
    ipcRenderer.invoke('daily-note:move-task', sourceDate, taskId, targetDate),

  // ── Sessions (02-session-lifecycle) ──────────────────────────────
  pickProjectFolder: (): Promise<string | null> => ipcRenderer.invoke('session:pickProjectFolder'),
  listHosts: (): Promise<RemoteHostOption[]> => ipcRenderer.invoke('session:listHosts'),
  /** Recently-used project paths for a host ('local' or a RemoteHostOption.id), newest first (fix-bug-triage-jul31 / bug #49). */
  listRecentProjectPaths: (hostId: string): Promise<string[]> =>
    ipcRenderer.invoke('session:listRecentProjectPaths', hostId),
  suggestProjectPaths: (hostId: string, query: string): Promise<ProjectPathSuggestion[]> =>
    ipcRenderer.invoke('session:suggestProjectPaths', hostId, query),
  listActiveSessions: (): Promise<SessionRecord[]> => ipcRenderer.invoke('session:listActive'),
  listHistorySessions: (): Promise<SessionRecord[]> => ipcRenderer.invoke('session:listHistory'),
  listSessionMessages: (sessionId: string): Promise<MessageRecord[]> =>
    ipcRenderer.invoke('session:listMessages', sessionId),
  /** Cross-session content search (10b-enrichment-full-text-search), backed by SQLite FTS5 over plain user/assistant message text. */
  searchMessages: (query: string): Promise<MessageSearchHit[]> => ipcRenderer.invoke('session:searchMessages', query),
  createSession: (opts: CreateSessionOptions): Promise<SessionRecord> => ipcRenderer.invoke('session:create', opts),
  resumeSession: (sessionId: string): Promise<{ session: SessionRecord; messages: MessageRecord[] }> =>
    ipcRenderer.invoke('session:resume', sessionId),
  reconnectSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:reconnect', sessionId),
  getSessionWorkspaceSnapshot: (sessionId: string): Promise<SessionWorkspacePayload | null> =>
    ipcRenderer.invoke('session:getWorkspaceSnapshot', sessionId),
  refreshSessionWorkspace: (sessionId: string, force: boolean): Promise<SessionWorkspacePayload | null> =>
    ipcRenderer.invoke('session:refreshWorkspace', sessionId, force),
  touchSessionActive: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:touchActive', sessionId),
  isSessionStartupIdle: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('session:isStartupIdle', sessionId),
  sendSessionMessage: (sessionId: string, text: string, modelSelection?: ModelSelection, image?: ImageAttachment): Promise<void> =>
    ipcRenderer.invoke('session:sendMessage', sessionId, text, modelSelection, image),
  interruptSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:interrupt', sessionId),
  validateModel: (sessionId: string, model: string): Promise<ModelValidationResult> =>
    ipcRenderer.invoke('session:validateModel', sessionId, model),
  forkSession: (sessionId: string): Promise<SessionRecord> => ipcRenderer.invoke('session:fork', sessionId),
  restartSession: (sessionId: string): Promise<SessionRecord> => ipcRenderer.invoke('session:restart', sessionId),
  closeSession: (sessionId: string): Promise<SessionRecord> => ipcRenderer.invoke('session:close', sessionId),
  linkDailyTask: (sessionId: string, noteDate: string, taskGid: string): Promise<SessionRecord> =>
    ipcRenderer.invoke('session:linkDailyTask', sessionId, noteDate, taskGid),
  completeLinkedDailyTask: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('session:completeLinkedDailyTask', sessionId),
  deleteSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:delete', sessionId),
  renameSession: (sessionId: string, name: string): Promise<SessionRecord> =>
    ipcRenderer.invoke('session:rename', sessionId, name),
  setSessionPinned: (sessionId: string, pinned: boolean): Promise<SessionRecord> =>
    ipcRenderer.invoke('session:setPinned', sessionId, pinned),
  /** Opens a real native Save dialog and writes the session's full transcript to disk (10c-enrichment-export-conversation). Resolves to the saved path, or null if cancelled. */
  exportTranscript: (sessionId: string, format: 'markdown' | 'json'): Promise<string | null> =>
    ipcRenderer.invoke('session:exportTranscript', sessionId, format),

  // ── Session organization (06-session-organization) ────────────────
  setSessionColor: (sessionId: string, color: string): Promise<SessionRecord> =>
    ipcRenderer.invoke('session:setColor', sessionId, color),
  setSessionNotes: (sessionId: string, notes: string): Promise<SessionRecord> =>
    ipcRenderer.invoke('session:setNotes', sessionId, notes),
  addSessionTag: (sessionId: string, tag: string): Promise<SessionRecord> =>
    ipcRenderer.invoke('session:addTag', sessionId, tag),
  removeSessionTag: (sessionId: string, tag: string): Promise<SessionRecord> =>
    ipcRenderer.invoke('session:removeTag', sessionId, tag),
  listAllTags: (): Promise<string[]> => ipcRenderer.invoke('session:listAllTags'),
  listSessionStatuses: (): Promise<Record<string, SessionStatus>> => ipcRenderer.invoke('session:listStatuses'),
  setSessionGroup: (sessionId: string, groupId: string | null): Promise<SessionRecord> =>
    ipcRenderer.invoke('session:setGroup', sessionId, groupId),
  reorderSessions: (groupId: string | null | undefined, orderedIds: string[]): Promise<SessionRecord[]> =>
    ipcRenderer.invoke('session:reorder', groupId, orderedIds),
  listGroups: (): Promise<SessionGroupRecord[]> => ipcRenderer.invoke('group:list'),
  createGroup: (name: string): Promise<SessionGroupRecord> => ipcRenderer.invoke('group:create', name),
  renameGroup: (groupId: string, name: string): Promise<SessionGroupRecord> =>
    ipcRenderer.invoke('group:rename', groupId, name),
  setGroupCollapsed: (groupId: string, collapsed: boolean): Promise<SessionGroupRecord> =>
    ipcRenderer.invoke('group:setCollapsed', groupId, collapsed),
  deleteGroup: (groupId: string): Promise<void> => ipcRenderer.invoke('group:delete', groupId),
  reorderGroups: (orderedIds: string[]): Promise<SessionGroupRecord[]> =>
    ipcRenderer.invoke('group:reorder', orderedIds),
  /** Fires whenever any session's live status (working/waiting) changes — pushed for EVERY session, not just the active one. */
  onSessionStatus: (callback: (event: SessionStatusEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionStatusEvent): void => callback(payload)
    ipcRenderer.on('session:status', listener)
    return () => ipcRenderer.removeListener('session:status', listener)
  },
  onGroupChanged: (callback: (event: SessionGroupEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionGroupEvent): void => callback(payload)
    ipcRenderer.on('group:changed', listener)
    return () => ipcRenderer.removeListener('group:changed', listener)
  },

  /** Resolves a permission/AskUserQuestion/plan card (05-interactive-prompts). */
  respondToPrompt: (sessionId: string, requestId: string, decision: PromptDecision): Promise<void> =>
    ipcRenderer.invoke('session:respondToPrompt', sessionId, requestId, decision),
  /** Shift+Tab / mode-pill click cycles default -> plan -> acceptEdits -> auto -> default (11-composer-mode-indicator). */
  cycleSessionMode: (sessionId: string): Promise<SessionRecord> => ipcRenderer.invoke('session:cycleMode', sessionId),
  /** Persists a model/effort selection immediately (fix-model-persist-on-slash-model) — called by the renderer when /model <id> fires so the selection survives a relaunch even without a subsequent message send. */
  setSessionModelSelection: (sessionId: string, selection: ModelSelection): Promise<void> =>
    ipcRenderer.invoke('session:setModelSelection', sessionId, selection),
  onSessionMessage: (callback: (event: SessionStreamEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionStreamEvent): void => callback(payload)
    ipcRenderer.on('session:message', listener)
    return () => ipcRenderer.removeListener('session:message', listener)
  },
  /** Token-level live push for an in-progress assistant message (03-chat-surface-core) — see SessionStreamDeltaEvent. */
  onSessionStreamDelta: (callback: (event: SessionStreamDeltaEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionStreamDeltaEvent): void => callback(payload)
    ipcRenderer.on('session:streamDelta', listener)
    return () => ipcRenderer.removeListener('session:streamDelta', listener)
  },
  onSessionLifecycle: (callback: (event: SessionLifecycleEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionLifecycleEvent): void => callback(payload)
    ipcRenderer.on('session:lifecycle', listener)
    return () => ipcRenderer.removeListener('session:lifecycle', listener)
  },
  /** Composer Send/Stop toggle push (04-composer-core) — see SessionTurnStateEvent. */
  onSessionTurnState: (callback: (event: SessionTurnStateEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionTurnStateEvent): void => callback(payload)
    ipcRenderer.on('session:turnState', listener)
    return () => ipcRenderer.removeListener('session:turnState', listener)
  },
  /** Live slash-command registry push (bug #56) — see SessionCommandsEvent. Fires once shortly after session start/resume and again on any mid-session SDK `commands_changed` push; always the FULL replacement list. */
  onSessionCommands: (callback: (event: SessionCommandsEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionCommandsEvent): void => callback(payload)
    ipcRenderer.on('session:commands', listener)
    return () => ipcRenderer.removeListener('session:commands', listener)
  },
  /** Claude Code working directory for the composer context bar — SDK init cwd and inferred Bash `cd`. */
  onSessionHarnessCwd: (callback: (event: SessionHarnessCwdEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionHarnessCwdEvent): void => callback(payload)
    ipcRenderer.on('session:harnessCwd', listener)
    return () => ipcRenderer.removeListener('session:harnessCwd', listener)
  },
  /** Context-window token usage push (token-usage-indicator) — fired after each completed turn with cumulative inputTokens and contextWindow for the session's active connection. */
  onSessionTokenUsage: (callback: (event: SessionTokenUsageEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionTokenUsageEvent): void => callback(payload)
    ipcRenderer.on('session:tokenUsage', listener)
    return () => ipcRenderer.removeListener('session:tokenUsage', listener)
  },
  /** Worktree creation progress push (use-worktree) — fired during `git worktree add` with the current percentage. */
  onSessionWorktreeProgress: (callback: (event: SessionWorktreeProgressEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionWorktreeProgressEvent): void => callback(payload)
    ipcRenderer.on('session:worktreeProgress', listener)
    return () => ipcRenderer.removeListener('session:worktreeProgress', listener)
  },
  /** Startup recoverability probe result — fired for sessions that can no longer be resumed. */
  onSessionStale: (callback: (event: SessionStaleEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionStaleEvent): void => callback(payload)
    ipcRenderer.on('session:stale', listener)
    return () => ipcRenderer.removeListener('session:stale', listener)
  },
  onSessionOpenReady: (callback: (event: SessionOpenReadyEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionOpenReadyEvent): void => callback(payload)
    ipcRenderer.on('session:openReady', listener)
    return () => ipcRenderer.removeListener('session:openReady', listener)
  },
  onSessionWorkspaceUpdated: (callback: (event: SessionWorkspaceUpdatedEvent) => void): (() => void) => {
    const listener = (_event: unknown, payload: SessionWorkspaceUpdatedEvent): void => callback(payload)
    ipcRenderer.on('session:workspaceUpdated', listener)
    return () => ipcRenderer.removeListener('session:workspaceUpdated', listener)
  },
  /** Test-only: raw read-only SQL query against the real SQLite DB (see session:debugQueryDb handler). */
  debugQueryDb: <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ipcRenderer.invoke('debug:queryDb', sql, params),
  /** Test-only: raw mutating SQL statement (INSERT/UPDATE/DELETE) against the real SQLite DB (see debug:execDb handler). */
  debugExecDb: (sql: string, params: unknown[] = []): Promise<{ changes: number }> =>
    ipcRenderer.invoke('debug:execDb', sql, params),

  // ── Secondary panels (07-secondary-panels) ──────────────────────────
  gitDiff: (projectPath: string, hostname?: string | null, force?: boolean): Promise<DiffSummary> =>
    ipcRenderer.invoke('panel:git:diff', projectPath, hostname, force),
  gitFileDiff: (projectPath: string, filePath: string, hostname?: string | null): Promise<DiffFileChange | null> =>
    ipcRenderer.invoke('panel:git:fileDiff', projectPath, filePath, hostname),
  gitCommitDiff: (projectPath: string, commit: string, hostname?: string | null): Promise<DiffSummary> =>
    ipcRenderer.invoke('panel:git:commitDiff', projectPath, commit, hostname),
  gitCommitFileDiff: (
    projectPath: string,
    commit: string,
    filePath: string,
    hostname?: string | null
  ): Promise<DiffFileChange | null> =>
    ipcRenderer.invoke('panel:git:commitFileDiff', projectPath, commit, filePath, hostname),
  gitWorkingTreeFilePair: (
    projectPath: string,
    filePath: string,
    status: DiffFileStatus,
    hostname?: string | null
  ): Promise<DiffFileContentPair | null> =>
    ipcRenderer.invoke('panel:git:workingTreeFilePair', projectPath, filePath, status, hostname),
  gitCommitFilePair: (
    projectPath: string,
    commit: string,
    filePath: string,
    status: DiffFileStatus,
    hostname?: string | null
  ): Promise<DiffFileContentPair | null> =>
    ipcRenderer.invoke('panel:git:commitFilePair', projectPath, commit, filePath, status, hostname),
  gitCommits: (projectPath: string, hostname?: string | null, force?: boolean): Promise<CommitInfo[]> =>
    ipcRenderer.invoke('panel:git:commits', projectPath, hostname, force),
  gitWorktrees: (projectPath: string, hostname?: string | null, force?: boolean): Promise<WorktreeInfo[]> =>
    ipcRenderer.invoke('panel:git:worktrees', projectPath, hostname, force),
  gitWarmRemote: (hostname: string): Promise<void> => ipcRenderer.invoke('panel:git:warmRemote', hostname),
  gitBranch: (projectPath: string, hostname?: string | null): Promise<string | null> =>
    ipcRenderer.invoke('panel:git:branch', projectPath, hostname),
  gitWorktreeAdd: (projectPath: string, worktreePath: string, branch: string, hostname?: string | null): Promise<void> =>
    ipcRenderer.invoke('panel:git:worktreeAdd', projectPath, worktreePath, branch, hostname),
  gitWorktreeRemove: (projectPath: string, worktreePath: string, hostname?: string | null): Promise<void> =>
    ipcRenderer.invoke('panel:git:worktreeRemove', projectPath, worktreePath, hostname),
  gitWorktreeMerge: (projectPath: string, branch: string, hostname?: string | null): Promise<void> =>
    ipcRenderer.invoke('panel:git:worktreeMerge', projectPath, branch, hostname),

  filesTree: (projectPath: string, hostname?: string | null): Promise<FileTreeNode[]> => ipcRenderer.invoke('panel:files:tree', projectPath, hostname),
  filesDir: (root: string, dir: string, hostname?: string | null): Promise<FileTreeNode[]> => ipcRenderer.invoke('panel:files:dir', root, dir, hostname),
  filesList: (workspaceRoot: string, underDir?: string | null, hostname?: string | null): Promise<WorkspaceFileEntry[]> =>
    ipcRenderer.invoke('panel:files:list', workspaceRoot, underDir, hostname),
  filesRead: (path: string, hostname?: string | null): Promise<FileReadResult> => ipcRenderer.invoke('panel:files:read', path, hostname),
  filesWrite: (path: string, content: string, hostname?: string | null): Promise<FileWriteResult> => ipcRenderer.invoke('panel:files:write', path, content, hostname),

  ptySpawn: (opts: { id: string; cwd: string; hostname?: string | null; cols: number; rows: number }): Promise<boolean> =>
    ipcRenderer.invoke('panel:pty:spawn', opts),
  ptyWrite: (id: string, data: string): Promise<void> => ipcRenderer.invoke('panel:pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke('panel:pty:resize', id, cols, rows),
  ptyKill: (id: string): Promise<void> => ipcRenderer.invoke('panel:pty:kill', id),
  /** Kill the tmux server session for this pty id (call on Atelier session delete, not close). No-op if tmux is not installed. */
  ptyKillTmuxSession: (id: string): Promise<void> => ipcRenderer.invoke('panel:pty:killTmuxSession', id),
  onPtyData: (callback: (payload: { id: string; data: string }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { id: string; data: string }): void => callback(payload)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.removeListener('pty:data', listener)
  },
  onPtyExit: (callback: (payload: { id: string; exitCode: number }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { id: string; exitCode: number }): void => callback(payload)
    ipcRenderer.on('pty:exit', listener)
    return () => ipcRenderer.removeListener('pty:exit', listener)
  },
  onPtyShellContext: (callback: (payload: { id: string; remoteHost: string | null }) => void): (() => void) => {
    const listener = (_event: unknown, payload: { id: string; remoteHost: string | null }): void => callback(payload)
    ipcRenderer.on('pty:shellContext', listener)
    return () => ipcRenderer.removeListener('pty:shellContext', listener)
  },

  portsAdd: (sessionId: string, sshHost: string, localPort: number, remoteHost: string, remotePort: number): Promise<PortForward> =>
    ipcRenderer.invoke('panel:ports:add', sessionId, sshHost, localPort, remoteHost, remotePort),
  portsRemove: (id: string): Promise<void> => ipcRenderer.invoke('panel:ports:remove', id),
  portsList: (sessionId: string): Promise<PortForward[]> => ipcRenderer.invoke('panel:ports:list', sessionId),
  onPortsUpdated: (callback: (forwards: PortForward[]) => void): (() => void) => {
    const listener = (_event: unknown, forwards: PortForward[]): void => callback(forwards)
    ipcRenderer.on('ports:updated', listener)
    return () => ipcRenderer.removeListener('ports:updated', listener)
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),

  getSpendStatus: (): Promise<SpendStatus | null> => ipcRenderer.invoke('spendStatus:get'),

  listAppNotes: (): Promise<AppNoteRecord[]> => ipcRenderer.invoke('app-note:list'),
  createAppNote: (title?: string): Promise<AppNoteRecord> => ipcRenderer.invoke('app-note:create', title),
  updateAppNote: (id: string, patch: AppNoteUpdate): Promise<AppNoteRecord> =>
    ipcRenderer.invoke('app-note:update', id, patch),
  deleteAppNote: (id: string): Promise<void> => ipcRenderer.invoke('app-note:delete', id)
}

contextBridge.exposeInMainWorld('atelier', api)

export type AtelierApi = typeof api

