import { contextBridge, ipcRenderer } from 'electron'
import type { GardeniaConfig } from '../shared/config'
import type { DailyNote, ReadDailyNoteResult } from '../shared/daily-note-types'

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
  testDelayNextWrite: (ms: number): Promise<void> => ipcRenderer.invoke('daily-note:testDelayNextWrite', ms)
}

contextBridge.exposeInMainWorld('gardenia', api)

export type GardeniaApi = typeof api

