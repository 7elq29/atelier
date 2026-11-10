/**
 * IPC handler for the org-wide AI harness-pool spend indicator
 * (see `spend-status.ts`). A single pull-based channel — the renderer
 * polls on its own schedule (`SpendStatusChip.tsx`).
 */
import { ipcMain } from 'electron'
import {
  getSpendStatusAuthDebug,
  getSpendStatusSnapshot,
  renewSpendStatusUsso
} from './spend-status'
import type { SpendStatusSnapshot } from '../shared/spend-status-types'

export function registerSpendStatusHandlers(): void {
  ipcMain.handle('spendStatus:get', async (): Promise<SpendStatusSnapshot> => {
    return getSpendStatusSnapshot()
  })

  ipcMain.handle(
    'spendStatus:renewUsso',
    async (): Promise<{
      ok: boolean
      interactiveFetchCount: number
      webloginOpenCount: number
    }> => {
      return renewSpendStatusUsso()
    }
  )

  ipcMain.handle('spendStatus:authDebug', (): {
    interactiveFetchCount: number
    autoInteractiveFetchAttempted: boolean
    webloginOpenCount: number
  } => {
    return getSpendStatusAuthDebug()
  })
}
