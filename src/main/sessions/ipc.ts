/**
 * IPC handlers for the session lifecycle (02-session-lifecycle), following
 * the same registration pattern as daily-notes-handlers.ts / app:* handlers
 * in index.ts.
 */
import { ipcMain, dialog, type BrowserWindow } from 'electron'
import type { CreateSessionOptions, PromptDecision } from '../../shared/session-types'
import { logger } from '../logger'
import { openDatabase } from '../db'
import type { SessionManager } from './manager'

export function registerSessionHandlers(manager: SessionManager, getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('session:pickProjectFolder', async () => {
    const win = getWindow()
    const options = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Test-only: runs a read-only SQL query against the app's real, already-open
  // SQLite connection. Exists so e2e tests can verify DB state directly
  // (per e2e-test-plan.md, "query the DB directly ... don't just trust the
  // UI") without needing a second connection compiled for a different Node
  // ABI — better-sqlite3's native binary here is built against Electron's
  // ABI (see 00-app-shell's postinstall step), which a plain-Node Playwright
  // test process can't load directly.
  ipcMain.handle('debug:queryDb', (_event, sql: string, params: unknown[] = []) => {
    return openDatabase().prepare(sql).all(...params)
  })

  ipcMain.handle('session:listHosts', () => manager.listHosts())

  ipcMain.handle('session:listActive', () => manager.listActive())

  ipcMain.handle('session:listHistory', () => manager.listHistory())

  ipcMain.handle('session:listMessages', (_event, sessionId: string) => manager.listMessages(sessionId))

  ipcMain.handle('session:create', async (_event, opts: CreateSessionOptions) => {
    logger.info('session:create invoked', { projectPath: opts.projectPath, mode: opts.mode, hostId: opts.hostId })
    return manager.createSession(opts)
  })

  ipcMain.handle('session:resume', (_event, sessionId: string) => {
    const snapshot = manager.resumeSnapshot(sessionId)
    // Live reconnect happens AFTER this handler returns, so the renderer
    // always has the full stored transcript rendered first.
    void manager.reconnect(sessionId).catch((err) =>
      logger.error('session reconnect failed', { sessionId, error: err instanceof Error ? err.message : String(err) })
    )
    return snapshot
  })

  ipcMain.handle('session:sendMessage', (_event, sessionId: string, text: string) => {
    logger.info('session:sendMessage invoked', { sessionId, textLength: text.length })
    return manager.sendUserMessage(sessionId, text)
  })

  ipcMain.handle('session:interrupt', (_event, sessionId: string) => manager.interrupt(sessionId))

  ipcMain.handle('session:fork', (_event, sessionId: string) => manager.forkSession(sessionId))

  ipcMain.handle('session:restart', (_event, sessionId: string) => manager.restartSession(sessionId))

  ipcMain.handle('session:close', (_event, sessionId: string) => manager.closeSession(sessionId))

  ipcMain.handle('session:delete', (_event, sessionId: string) => manager.deleteSession(sessionId))

  ipcMain.handle('session:rename', (_event, sessionId: string, name: string) => manager.renameSession(sessionId, name))

  ipcMain.handle('session:setPinned', (_event, sessionId: string, pinned: boolean) => manager.setPinned(sessionId, pinned))

  // 05-interactive-prompts: resolves a permission/AskUserQuestion/plan card.
  ipcMain.handle('session:respondToPrompt', (_event, sessionId: string, requestId: string, decision: PromptDecision) =>
    manager.respondToPrompt(sessionId, requestId, decision)
  )
}
