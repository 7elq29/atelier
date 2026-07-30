import { contextBridge, ipcRenderer } from 'electron'
import type { GardeniaConfig } from '../shared/config'

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
    ipcRenderer.invoke('notification:debugTrigger', { title, body })
}

contextBridge.exposeInMainWorld('gardenia', api)

export type GardeniaApi = typeof api
