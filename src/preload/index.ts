import { contextBridge, ipcRenderer } from 'electron'
import type { GardeniaConfig } from '../shared/config'
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
  SessionGroupEvent,
  SessionGroupRecord,
  SessionLifecycleEvent,
  SessionRecord,
  SessionStatus,
  SessionStatusEvent,
  SessionStreamDeltaEvent,
  SessionStreamEvent,
  SessionTurnStateEvent
} from '../shared/session-types'
import type {
  CommitInfo,
  DiffSummary,
  FileReadResult,
  FileTreeNode,
  PortForward,
  WorktreeInfo
} from '../shared/panel-types'
import type { SpendStatus } from '../shared/spend-status-types'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const api = {
  /** Round-trip IPC call to main: asks for the real app version string. */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  /** Path of the main-process structured log file, for debugging/e2e use. */
  getLogFilePath: (): Promise<string> => ipcRenderer.invoke('app:getLogFilePath'),
  /** Forward a structured log line from the renderer to the main-process logger. */
  log: (level: LogLevel, msg: string, extra?: Record<string, unknown>): void => {
    ipcRenderer.send('renderer:log', { level, msg, extra })
  },
  /** Reads the persisted app config (theme, font sizes, onboarding flag, etc). */
  getConfig: (): Promise<GardeniaConfig> => ipcRenderer.invoke('config:get'),
  /** Merges + persists a partial config update, returns the resulting full config. */
  setConfig: (partial: Partial<GardeniaConfig>): Promise<GardeniaConfig> =>
    ipcRenderer.invoke('config:set', partial),
  /** Debug-only: fires a real OS notification via Electron's Notification API. */
  debugNotify: (title: string, body: string): Promise<boolean> =>
    ipcRenderer.invoke('notification:debugTrigger', { title, body }),

  // ── Daily notes (Obsidian integration) ──────────────────────────
  getVaultRoot: (): Promise<string | null> => ipcRenderer.invoke('daily-note:getVaultRoot'),
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
  listActiveSessions: (): Promise<SessionRecord[]> => ipcRenderer.invoke('session:listActive'),
  listHistorySessions: (): Promise<SessionRecord[]> => ipcRenderer.invoke('session:listHistory'),
  listSessionMessages: (sessionId: string): Promise<MessageRecord[]> =>
    ipcRenderer.invoke('session:listMessages', sessionId),
  /** Cross-session content search (10b-enrichment-full-text-search), backed by SQLite FTS5 over plain user/assistant message text. */
  searchMessages: (query: string): Promise<MessageSearchHit[]> => ipcRenderer.invoke('session:searchMessages', query),
  createSession: (opts: CreateSessionOptions): Promise<SessionRecord> => ipcRenderer.invoke('session:create', opts),
  resumeSession: (sessionId: string): Promise<{ session: SessionRecord; messages: MessageRecord[] }> =>
    ipcRenderer.invoke('session:resume', sessionId),
  sendSessionMessage: (sessionId: string, text: string, modelSelection?: ModelSelection, image?: ImageAttachment): Promise<void> =>
    ipcRenderer.invoke('session:sendMessage', sessionId, text, modelSelection, image),
  interruptSession: (sessionId: string): Promise<void> => ipcRenderer.invoke('session:interrupt', sessionId),
  forkSession: (sessionId: string): Promise<SessionRecord> => ipcRenderer.invoke('session:fork', sessionId),
  restartSession: (sessionId: string): Promise<SessionRecord> => ipcRenderer.invoke('session:restart', sessionId),
  closeSession: (sessionId: string): Promise<SessionRecord> => ipcRenderer.invoke('session:close', sessionId),
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
  /** Test-only: raw read-only SQL query against the real SQLite DB (see session:debugQueryDb handler). */
  debugQueryDb: <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> =>
    ipcRenderer.invoke('debug:queryDb', sql, params),
  /** Test-only: raw mutating SQL statement (INSERT/UPDATE/DELETE) against the real SQLite DB (see debug:execDb handler). */
  debugExecDb: (sql: string, params: unknown[] = []): Promise<{ changes: number }> =>
    ipcRenderer.invoke('debug:execDb', sql, params),

  // ── Secondary panels (07-secondary-panels) ──────────────────────────
  gitDiff: (projectPath: string): Promise<DiffSummary> => ipcRenderer.invoke('panel:git:diff', projectPath),
  gitCommits: (projectPath: string): Promise<CommitInfo[]> => ipcRenderer.invoke('panel:git:commits', projectPath),
  gitWorktrees: (projectPath: string): Promise<WorktreeInfo[]> => ipcRenderer.invoke('panel:git:worktrees', projectPath),
  gitWorktreeAdd: (projectPath: string, worktreePath: string, branch: string): Promise<void> =>
    ipcRenderer.invoke('panel:git:worktreeAdd', projectPath, worktreePath, branch),
  gitWorktreeRemove: (projectPath: string, worktreePath: string): Promise<void> =>
    ipcRenderer.invoke('panel:git:worktreeRemove', projectPath, worktreePath),
  gitWorktreeMerge: (projectPath: string, branch: string): Promise<void> =>
    ipcRenderer.invoke('panel:git:worktreeMerge', projectPath, branch),

  filesTree: (projectPath: string): Promise<FileTreeNode[]> => ipcRenderer.invoke('panel:files:tree', projectPath),
  filesRead: (path: string): Promise<FileReadResult> => ipcRenderer.invoke('panel:files:read', path),

  ptySpawn: (opts: { id: string; cwd: string; hostname?: string | null; cols: number; rows: number }): Promise<boolean> =>
    ipcRenderer.invoke('panel:pty:spawn', opts),
  ptyWrite: (id: string, data: string): Promise<void> => ipcRenderer.invoke('panel:pty:write', id, data),
  ptyResize: (id: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke('panel:pty:resize', id, cols, rows),
  ptyKill: (id: string): Promise<void> => ipcRenderer.invoke('panel:pty:kill', id),
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

  getSpendStatus: (): Promise<SpendStatus | null> => ipcRenderer.invoke('spendStatus:get')
}

contextBridge.exposeInMainWorld('gardenia', api)

export type GardeniaApi = typeof api

