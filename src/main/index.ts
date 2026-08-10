import { app, BrowserWindow, ipcMain, Notification, nativeImage } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import './bootstrap-branding'
import { applyDockIconWhenReady, resolveAppIconPath } from './app-branding'
import { loadConfig, saveConfig } from './config'
import { closeDatabase, openDatabase } from './db'
import { getLogFilePath, logger, rendererLogger } from './logger'
import { migrateLegacyUserDataFromGardeniaProfiles } from './migrations/gardenia-to-atelier'
import type { AtelierConfig } from '../shared/config'
import { registerDailyNoteHandlers } from './daily-notes-handlers'
import { registerWeeklyPlanHandlers } from './weekly-notes-handlers'
import { ClaudeAgentSdkHarness } from './harness'
import { SessionStore } from './sessions/store'
import { SessionManager } from './sessions/manager'
import { WorkspaceService } from './sessions/workspace-service'
import { refreshSessionChangesCap } from './sessions/session-changes-cap'
import { createStaticHostResolver } from './sessions/hosts'
import { registerSessionHandlers } from './sessions/ipc'
import { registerAppNotesHandlers } from './app-notes/ipc'
import { registerPanelHandlers } from './panels/ipc'
import { registerSpendStatusHandlers } from './spend-status-ipc'
import type { PtyManager } from './panels/pty'
import type { PortForwardManager } from './panels/ports'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let portManager: PortForwardManager | null = null
let sessionManager: SessionManager | null = null
let workspaceService: WorkspaceService | null = null
/** Prevents a second `before-quit` from re-entering async harness teardown. */
let appQuitHarnessShutdownDone = false

function createWindow(): BrowserWindow {
  const iconPath = resolveAppIconPath()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Atelier',
    icon: icon && !icon.isEmpty() ? icon : undefined,
    // Native title bar — desktop-only, no custom chrome.
    titleBarStyle: 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  return win
}

function registerIpcHandlers(sessionManager: SessionManager): void {
  ipcMain.handle('app:getVersion', () => {
    const version = app.getVersion()
    logger.info('ipc app:getVersion invoked', { version })
    return version
  })

  ipcMain.handle('app:getLogFilePath', () => {
    return getLogFilePath()
  })

  ipcMain.handle('app:getHomedir', () => homedir())

  ipcMain.on('renderer:log', (_event, payload: { level: string; msg: string; extra?: Record<string, unknown> }) => {
    const { level, msg, extra } = payload
    const fn =
      level === 'error'
        ? rendererLogger.error
        : level === 'warn'
          ? rendererLogger.warn
          : level === 'debug'
            ? rendererLogger.debug
            : rendererLogger.info
    fn(msg, extra)
  })

  ipcMain.handle('config:get', () => loadConfig())

  ipcMain.handle('config:set', (_event, partial: Partial<AtelierConfig>) => saveConfig(partial))

  ipcMain.handle('config:validateClaudeModel', (_event, model: string) => sessionManager.validateClaudeModel(model))

  // Debug-only trigger for desktop notifications: there's no real "session
  // needs attention" event yet (that lands with the session/chat surfaces),
  // so this is the one real, testable path that exercises Electron's actual
  // Notification API end-to-end.
  ipcMain.handle('notification:debugTrigger', (_event, payload: { title: string; body: string }) => {
    const { title, body } = payload
    if (!Notification.isSupported()) {
      logger.warn('desktop notifications not supported on this platform', { title, body })
      return false
    }
    const notification = new Notification({ title, body })
    notification.show()
    logger.info('notification shown', { title, body })
    return true
  })

  registerDailyNoteHandlers(() => mainWindow)
  registerWeeklyPlanHandlers()
  registerAppNotesHandlers()
  registerSessionHandlers(sessionManager, () => mainWindow)
  registerSpendStatusHandlers()
  const panelManagers = registerPanelHandlers(() => mainWindow)
  ptyManager = panelManagers.ptyManager
  portManager = panelManagers.portManager
  workspaceService?.setPtyManager(panelManagers.ptyManager)
}

app.whenReady().then(() => {
  // Gardenia → Atelier rename: pull SQLite/config from the old Application Support
  // folder before openDatabase() (npm run dev changed userData when package name changed).
  migrateLegacyUserDataFromGardeniaProfiles()

  // Initialize logging + DB helper before anything else so "app ready" is
  // always the first line every later feature's e2e proof can grep for.
  const db = openDatabase()
  const sessionStore = new SessionStore(db)
  // Single harness instance for the app's lifetime (per 01-harness-abstraction's
  // guidance) — sessions/turns are keyed off its own internal map, not
  // re-created per IPC call.
  const harness = new ClaudeAgentSdkHarness()
  sessionManager = new SessionManager(sessionStore, harness, createStaticHostResolver(), () => mainWindow)
  workspaceService = new WorkspaceService(() => mainWindow, async (sessionId, opts) => {
    const session = sessionStore.getSession(sessionId)
    if (!session) return { items: [] }
    const workspacePath = session.worktreePath ?? session.projectPath
    return refreshSessionChangesCap(sessionStore, sessionId, workspacePath, session.hostname, opts)
  })
  sessionManager.setWorkspaceService(workspaceService)
  const manager = sessionManager
  manager.markStartupIdleSessions()
  registerIpcHandlers(manager)

  logger.info('app ready', { version: app.getVersion(), platform: process.platform })

  mainWindow = createWindow()
  applyDockIconWhenReady()

  // Fire-and-forget: probe each session's recoverability in the background
  // and push session:stale events to the renderer for any that can't resume.
  // Deliberately delayed so the window has time to render before SSH probes start.
  setTimeout(() => manager.startupReconnect(), 1500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
}).catch((err: unknown) => {
  logger.error('app startup failed', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined
  })
  app.quit()
})

app.on('window-all-closed', () => {
  // Real pty/ssh child processes hold ref'd handles that would otherwise
  // keep the app process alive indefinitely after the last window closes.
  ptyManager?.killAll()
  portManager?.killAll()
  closeDatabase()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (appQuitHarnessShutdownDone) {
    ptyManager?.killAll()
    portManager?.killAll()
    return
  }
  if (!sessionManager) {
    ptyManager?.killAll()
    portManager?.killAll()
    return
  }
  event.preventDefault()
  void sessionManager
    .shutdownAllHarnessSessionsForAppQuit()
    .catch((err) => {
      logger.error('app quit harness shutdown failed', {
        error: err instanceof Error ? err.message : String(err)
      })
    })
    .finally(() => {
      appQuitHarnessShutdownDone = true
      ptyManager?.killAll()
      portManager?.killAll()
      app.quit()
    })
})
