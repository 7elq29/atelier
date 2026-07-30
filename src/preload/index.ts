import { contextBridge, ipcRenderer } from 'electron'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const api = {
  /** Round-trip IPC call to main: asks for the real app version string. */
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),
  /** Path of the main-process structured log file, for debugging/e2e use. */
  getLogFilePath: (): Promise<string> => ipcRenderer.invoke('app:getLogFilePath'),
  /** Forward a structured log line from the renderer to the main-process logger. */
  log: (level: LogLevel, msg: string, extra?: Record<string, unknown>): void => {
    ipcRenderer.send('renderer:log', { level, msg, extra })
  }
}

contextBridge.exposeInMainWorld('gardenia', api)

export type GardeniaApi = typeof api
