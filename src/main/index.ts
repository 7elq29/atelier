import { app, BrowserWindow, ipcMain, Notification, nativeImage } from 'electron'
import { homedir } from 'node:os'
import { join } from 'node:path'
import './bootstrap-branding'
import { augmentProcessPathForGuiLaunch } from './shell-path'

augmentProcessPathForGuiLaunch()
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
import { registerAppBookmarksHandlers } from './app-bookmarks/ipc'
import { registerPanelHandlers } from './panels/ipc'
import { purgeEditorBuffers } from './panels/editor-buffers'
import { registerSpendStatusHandlers } from './spend-status-ipc'
import type { PtyManager } from './panels/pty'
import type { PortForwardManager } from './panels/ports'
import { startCalendarDayMonitor } from './calendar-day'

/** Dev worktree runs via a copied .app bundle, so `app.isPackaged` alone is unreliable. */
const isDev =
  process.env['ATELIER_DEV'] === '1' ||
  process.env['ELECTRON_RENDERER_URL'] != null ||
  !app.isPackaged
let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let portManager: PortForwardManager | null = null
let sessionManager: SessionManager | null = null
let workspaceService: WorkspaceService | null = null
let stopCalendarDayMonitor: (() => void) | null = null
/** Prevents a second `before-quit` from re-entering async harness teardown. */
let appQuitHarnessShutdownDone = false

function createWindow(): BrowserWindow {
  const iconPath = resolveAppIconPath()
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined
  const isMac = process.platform === 'darwin'
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: isDev ? 'Atelier [DEV]' : 'Atelier',
    icon: icon && !icon.isEmpty() ? icon : undefined,
    // Match --bg-app so the window is not pure black while the renderer loads.
    backgroundColor: '#1c1a16',
    ...(isMac
      ? {
          // Obsidian-style integrated title bar — renderer supplies drag region;
          // macOS draws traffic lights in the inset (see TitleBar.tsx).
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 14, y: 12 }
        }
      : {
          // Native title bar on Windows/Linux until custom overlay is specced.
          titleBarStyle: 'default' as const
        }),
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

  const sendFullScreenChanged = (fullScreen: boolean): void => {
    logger.info('window fullscreen changed', { fullScreen })
    win.webContents.send('window:fullScreenChanged', { fullScreen })
  }
  win.on('enter-full-screen', () => sendFullScreenChanged(true))
  win.on('leave-full-screen', () => sendFullScreenChanged(false))

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    logger.error('renderer failed to load', { errorCode, errorDescription, validatedURL })
  })

  const rendererDevUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && rendererDevUrl) {
    logger.info('loading dev renderer', { url: rendererDevUrl })
    void win.loadURL(rendererDevUrl)
  } else {
    const rendererFile = join(__dirname, '../renderer/index.html')
    if (isDev) {
      logger.warn(
        'ELECTRON_RENDERER_URL unset in dev; loading built renderer from disk — use npm run dev (electron-vite) so Vite serves the UI',
        { path: rendererFile }
      )
    }
    void win.loadFile(rendererFile)
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
  ipcMain.handle('app:isFullScreen', () => mainWindow?.isFullScreen() ?? false)

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
  registerAppBookmarksHandlers()
  registerSessionHandlers(sessionManager, () => mainWindow)
  registerSpendStatusHandlers()
  const panelManagers = registerPanelHandlers(() => mainWindow)
  ptyManager = panelManagers.ptyManager
  portManager = panelManagers.portManager
  workspaceService?.setPtyManager(panelManagers.ptyManager)
  sessionManager.setPortForwardManager(panelManagers.portManager)
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
  workspaceService = new WorkspaceService(
    () => mainWindow,
    async (sessionId) => {
      const session = sessionStore.getSession(sessionId)
      if (!session) return { items: [] }
      const workspacePath = session.worktreePath ?? session.projectPath
      return refreshSessionChangesCap(sessionStore, sessionId, workspacePath, session.hostname)
    },
    (sessionId) => sessionStore.listSessionTouchedPaths(sessionId).map((row) => row.path)
  )
  sessionManager.setWorkspaceService(workspaceService)
  const manager = sessionManager
  manager.markStartupIdleSessions()
  registerIpcHandlers(manager)

  // Unsaved Files-editor text is scoped to one app run, so clear anything a
  // previous run (or a crash) left behind before the renderer can restore it.
  purgeEditorBuffers()

  logger.info('app ready', { version: app.getVersion(), platform: process.platform, dev: isDev })

  mainWindow = createWindow()
  stopCalendarDayMonitor = startCalendarDayMonitor(() => mainWindow)
  applyDockIconWhenReady()
  if (isDev && process.platform === 'darwin') {
    app.dock?.setBadge('DEV')
  }

  // Let the renderer paint durable "Cleaning up session…" rows before
  // resuming cleanup left by a prior quit/crash.
  setTimeout(() => manager.resumePendingSessionCleanup(), 500)

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
  // On macOS the app keeps running with zero windows (standard Electron
  // behavior). SessionStore still holds the Database handle from startup;
  // closing it here leaves session:create hitting "connection is not open"
  // when the user opens a new window from the dock. Close the DB only on
  // actual quit (before-quit below).
  if (process.platform !== 'darwin') {
    closeDatabase()
    app.quit()
  }
})

app.on('before-quit', (event) => {
  // Unsaved editor buffers never outlive the app run (re-entry is a cheap no-op).
  purgeEditorBuffers()
  stopCalendarDayMonitor?.()
  stopCalendarDayMonitor = null
  if (appQuitHarnessShutdownDone) {
    ptyManager?.killAll()
    portManager?.killAll()
    closeDatabase()
    return
  }
  if (!sessionManager) {
    ptyManager?.killAll()
    portManager?.killAll()
    closeDatabase()
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
      closeDatabase()
      app.quit()
    })
})
