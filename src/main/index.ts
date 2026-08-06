import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import { join } from 'node:path'
import { loadConfig, saveConfig } from './config'
import { closeDatabase, openDatabase } from './db'
import { getLogFilePath, logger, rendererLogger } from './logger'
import type { GardeniaConfig } from '../shared/config'
import { registerDailyNoteHandlers } from './daily-notes-handlers'
import { ClaudeAgentSdkHarness } from './harness'
import { SessionStore } from './sessions/store'
import { SessionManager } from './sessions/manager'
import { createStaticHostResolver } from './sessions/hosts'
import { registerSessionHandlers } from './sessions/ipc'
import { registerPanelHandlers } from './panels/ipc'
import { registerSpendStatusHandlers } from './spend-status-ipc'
import type { PtyManager } from './panels/pty'
import type { PortForwardManager } from './panels/ports'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let ptyManager: PtyManager | null = null
let portManager: PortForwardManager | null = null

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Gardenia',
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

  ipcMain.handle('config:set', (_event, partial: Partial<GardeniaConfig>) => saveConfig(partial))

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
  registerSessionHandlers(sessionManager, () => mainWindow)
  registerSpendStatusHandlers()
  const panelManagers = registerPanelHandlers(() => mainWindow)
  ptyManager = panelManagers.ptyManager
  portManager = panelManagers.portManager
}

app.whenReady().then(() => {
  // Initialize logging + DB helper before anything else so "app ready" is
  // always the first line every later feature's e2e proof can grep for.
  const db = openDatabase()
  const sessionStore = new SessionStore(db)
  // Single harness instance for the app's lifetime (per 01-harness-abstraction's
  // guidance) — sessions/turns are keyed off its own internal map, not
  // re-created per IPC call.
  const harness = new ClaudeAgentSdkHarness()
  const sessionManager = new SessionManager(sessionStore, harness, createStaticHostResolver(), () => mainWindow)
  registerIpcHandlers(sessionManager)

  logger.info('app ready', { version: app.getVersion(), platform: process.platform })

  mainWindow = createWindow()

  // Fire-and-forget: probe each session's recoverability in the background
  // and push session:stale events to the renderer for any that can't resume.
  // Deliberately delayed so the window has time to render before SSH probes start.
  setTimeout(() => sessionManager.startupReconnect(), 1500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
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

app.on('before-quit', () => {
  ptyManager?.killAll()
  portManager?.killAll()
})
