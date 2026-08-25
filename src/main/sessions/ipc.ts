/**
 * IPC handlers for the session lifecycle (02-session-lifecycle), following
 * the same registration pattern as daily-notes-handlers.ts / app:* handlers
 * in index.ts.
 */
import { ipcMain, dialog, app, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import type { CreateSessionOptions, ImageAttachment, ModelSelection, PromptDecision } from '../../shared/session-types'
import { logger } from '../logger'
import { openDatabase } from '../db'
import type { SessionManager } from './manager'
import { formatTranscriptMarkdown, formatTranscriptJson } from './export-format'

export type ExportFormat = 'markdown' | 'json'

export function registerSessionHandlers(manager: SessionManager, getWindow: () => BrowserWindow | null): void {
  const allowDebugDb = !app.isPackaged || process.env.ATELIER_TEST_VAULT_ROOT !== undefined

  ipcMain.handle('session:pickProjectFolder', async () => {
    const win = getWindow()
    const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Unpackaged dev/e2e only — packaged production builds must not expose arbitrary SQL.
  if (allowDebugDb) {
    ipcMain.handle('debug:queryDb', (_event, sql: string, params: unknown[] = []) => {
      return openDatabase().prepare(sql).all(...params)
    })

    ipcMain.handle('debug:execDb', (_event, sql: string, params: unknown[] = []) => {
      return openDatabase().prepare(sql).run(...params)
    })
  }

  ipcMain.handle('session:listHosts', () => manager.listHosts())

  // fix-bug-triage-jul31 / bug #49: recently-used project paths for the New Session modal's history offering.
  ipcMain.handle('session:listRecentProjectPaths', (_event, hostId: string) => manager.listRecentProjectPaths(hostId))

  ipcMain.handle('session:suggestProjectPaths', (_event, hostId: string, query: string) =>
    manager.suggestProjectPaths(hostId, query)
  )

  ipcMain.handle('session:listActive', () => manager.listActive())

  ipcMain.handle('session:listHistory', () => manager.listHistory())

  ipcMain.handle(
    'session:listMessages',
    (_event, sessionId: string, opts?: { includeMessageId?: number }) =>
      manager.listMessagesForDisplay(sessionId, opts)
  )

  // 10b-enrichment-full-text-search: cross-session content search via SQLite FTS5.
  ipcMain.handle('session:searchMessages', (_event, query: string) => manager.searchMessages(query))

  ipcMain.handle('session:create', async (_event, opts: CreateSessionOptions) => {
    logger.info('session:create invoked', { projectPath: opts.projectPath, mode: opts.mode, hostId: opts.hostId })
    return manager.createSession(opts)
  })

  ipcMain.handle('session:resume', (_event, sessionId: string) => {
    const snapshot = manager.resumeSnapshot(sessionId)
    // Live reconnect after reopen — idle-session-auto-history moves stale sessions
    // into History (closed_at), so resume must reconnect even when last_active_at
    // is older than the startup-idle threshold.
    void manager.reconnect(sessionId).catch((err) =>
      logger.error('session reconnect failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
    )
    return snapshot
  })

  ipcMain.handle('session:reconnect', async (_event, sessionId: string) => {
    await manager.reconnect(sessionId)
  })

  ipcMain.handle('session:touchActive', (_event, sessionId: string) => {
    manager.touchSessionActive(sessionId)
  })

  ipcMain.handle('session:isStartupIdle', (_event, sessionId: string) => manager.isSessionStartupIdle(sessionId))

  ipcMain.handle('session:sendMessage', (_event, sessionId: string, text: string, modelSelection?: ModelSelection, image?: ImageAttachment) => {
    logger.info('session:sendMessage invoked', { sessionId, textLength: text.length, modelSelection, hasImage: Boolean(image) })
    return manager.sendUserMessage(sessionId, text, modelSelection, image)
  })

  ipcMain.handle('session:interrupt', (_event, sessionId: string) => manager.interrupt(sessionId))

  ipcMain.handle('session:validateModel', (_event, sessionId: string, model: string) => manager.validateModel(sessionId, model))

  ipcMain.handle('session:fork', (_event, sessionId: string) => manager.forkSession(sessionId))

  ipcMain.handle('session:restart', (_event, sessionId: string) => manager.restartSession(sessionId))

  ipcMain.handle('session:close', (_event, sessionId: string) => manager.closeSession(sessionId))

  ipcMain.handle(
    'session:linkDailyTask',
    async (_event, sessionId: string, noteDate: string, taskGid: string) =>
      manager.linkDailyTask(sessionId, noteDate, taskGid)
  )

  ipcMain.handle('session:completeLinkedDailyTask', async (_event, sessionId: string) => {
    await manager.completeLinkedDailyTask(sessionId)
  })

  ipcMain.handle('session:delete', (_event, sessionId: string) => manager.deleteSession(sessionId))

  ipcMain.handle('session:rename', (_event, sessionId: string, name: string) => manager.renameSession(sessionId, name))

  ipcMain.handle('session:setPinned', (_event, sessionId: string, pinned: boolean) => manager.setPinned(sessionId, pinned))

  ipcMain.handle('session:setModelSelection', (_event, sessionId: string, selection: ModelSelection) =>
    manager.persistModelSelection(sessionId, selection)
  )

  ipcMain.handle('session:setColor', (_event, sessionId: string, color: string) => manager.setColor(sessionId, color))

  ipcMain.handle('session:setNotes', (_event, sessionId: string, notes: string) => manager.setNotes(sessionId, notes))

  ipcMain.handle('session:setProjectPath', async (_event, sessionId: string, projectPath: string) =>
    manager.setProjectPath(sessionId, projectPath)
  )

  ipcMain.handle('session:addTag', (_event, sessionId: string, tag: string) => manager.addTag(sessionId, tag))

  ipcMain.handle('session:removeTag', (_event, sessionId: string, tag: string) => manager.removeTag(sessionId, tag))

  ipcMain.handle('session:listAllTags', () => manager.listAllTags())

  ipcMain.handle('session:listStatuses', () => manager.listStatuses())

  ipcMain.handle('session:setGroup', (_event, sessionId: string, groupId: string | null) =>
    manager.setSessionGroup(sessionId, groupId)
  )

  ipcMain.handle('session:reorder', (_event, groupId: string | null | undefined, orderedIds: string[]) =>
    manager.reorderSessions(groupId, orderedIds)
  )

  ipcMain.handle('group:list', () => manager.listGroups())

  ipcMain.handle('group:create', (_event, name: string) => manager.createGroup(name))

  ipcMain.handle('group:rename', (_event, groupId: string, name: string) => manager.renameGroup(groupId, name))

  ipcMain.handle('group:setCollapsed', (_event, groupId: string, collapsed: boolean) =>
    manager.setGroupCollapsed(groupId, collapsed)
  )

  ipcMain.handle('group:delete', (_event, groupId: string) => manager.deleteGroup(groupId))

  ipcMain.handle('group:reorder', (_event, orderedIds: string[]) => manager.reorderGroups(orderedIds))

  // 05-interactive-prompts: resolves a permission/AskUserQuestion/plan card.
  ipcMain.handle('session:respondToPrompt', (_event, sessionId: string, requestId: string, decision: PromptDecision) =>
    manager.respondToPrompt(sessionId, requestId, decision)
  )

  // 11-composer-mode-indicator: Shift+Tab / mode-pill click cycles
  // default -> plan -> acceptEdits -> auto -> default.
  ipcMain.handle('session:cycleMode', (_event, sessionId: string) => manager.cycleMode(sessionId))

  // 10c-enrichment-export-conversation: real native Save dialog + real file
  // write, same pattern as session:pickProjectFolder's showOpenDialog above.
  // Returns the saved path, or null if the user cancelled the dialog.
  ipcMain.handle('session:exportTranscript', async (_event, sessionId: string, format: ExportFormat) => {
    const session = manager.getSession(sessionId)
    if (!session) return null
    const messages = manager.listMessages(sessionId)

    const isMarkdown = format === 'markdown'
    const defaultExt = isMarkdown ? 'md' : 'json'
    const win = getWindow()
    const options = {
      defaultPath: `${session.name}.${defaultExt}`,
      filters: isMarkdown
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : [{ name: 'JSON', extensions: ['json'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    const contents = isMarkdown
      ? formatTranscriptMarkdown(session, messages)
      : JSON.stringify(formatTranscriptJson(session, messages), null, 2)

    await writeFile(result.filePath, contents, 'utf8')
    logger.info('session:exportTranscript wrote file', { sessionId, format, filePath: result.filePath })
    return result.filePath
  })

  ipcMain.handle('session:getWorkspaceSnapshot', (_event, sessionId: string) =>
    manager.getSessionWorkspaceSnapshot(sessionId)
  )

  ipcMain.handle('session:refreshWorkspace', async (_event, sessionId: string, force: boolean) =>
    manager.refreshSessionWorkspace(sessionId, force)
  )

  ipcMain.handle(
    'session:capOutsideFileDiff',
    (_event, sessionId: string, workspacePath: string, capPath: string) =>
      manager.getCapOutsideFileDiff(sessionId, workspacePath, capPath)
  )

  ipcMain.handle(
    'session:capGitFileDiff',
    (_event, sessionId: string, workspacePath: string, capPath: string) =>
      manager.getCapGitFileDiff(sessionId, workspacePath, capPath)
  )

  ipcMain.handle(
    'debug:registerPlanInCap',
    (
      _event,
      sessionId: string,
      args: { plan: string; planFilePath?: string; toolUseId: string }
    ) => manager.debugRegisterPlanInCap(sessionId, args)
  )

  ipcMain.handle(
    'debug:applyHarnessUiEvents',
    (_event, sessionId: string, events: import('../harness/types').HarnessEvent[]) => {
      manager.debugApplyHarnessUiEvents(sessionId, events)
    }
  )
}
