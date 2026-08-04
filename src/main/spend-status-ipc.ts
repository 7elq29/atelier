/**
 * IPC handler for the org-wide AI harness-pool spend indicator
 * (see `spend-status.ts`). A single pull-based channel — the renderer
 * polls on its own schedule (`SpendStatusChip.tsx`).
 */
import { ipcMain } from 'electron'
import { logger } from './logger'
import { getSpendStatus } from './spend-status'
import type { SpendStatus } from '../shared/spend-status-types'

export function registerSpendStatusHandlers(): void {
  ipcMain.handle('spendStatus:get', async (): Promise<SpendStatus | null> => {
    try {
      return await getSpendStatus()
    } catch (err) {
      logger.warn('spend status unavailable', { error: err instanceof Error ? err.message : String(err) })
      return null
    }
  })
}
