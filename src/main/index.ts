import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { closeDatabase, openDatabase } from './db'
import { getLogFilePath, logger, rendererLogger } from './logger'

const isDev = !app.isPackaged

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

  return win
}

function registerIpcHandlers(): void {
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
}

app.whenReady().then(() => {
  // Initialize logging + DB helper before anything else so "app ready" is
  // always the first line every later feature's e2e proof can grep for.
  openDatabase()
  registerIpcHandlers()

  logger.info('app ready', { version: app.getVersion(), platform: process.platform })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  closeDatabase()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
