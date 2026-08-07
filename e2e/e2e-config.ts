import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page } from '@playwright/test'

/** Select a closed session in History and reconnect via the main disconnected gate. */
export async function reconnectClosedSessionFromHistory(page: Page, sessionId: string): Promise<void> {
  const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
  await historyRow.click()
  await expect(page.getByTestId('session-disconnected-panel')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('session-reconnect-button').click()
  await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 90_000 })
}

/** Default Claude model for every e2e userData profile — fast/cheap vs production Sonnet 5. */
export const E2E_DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5'

/** Default effort for e2e — lower latency/cost than production High. */
export const E2E_DEFAULT_CLAUDE_EFFORT = 'low' as const

export function e2eConfigPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config.json')
}

/** Pre-seeds config.json before launching Electron (onboarding dismissed + e2e default model). */
export function seedE2eConfig(userDataDir: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(
    e2eConfigPath(userDataDir),
    JSON.stringify({
      onboardingCompleted: true,
      defaultClaudeModel: E2E_DEFAULT_CLAUDE_MODEL,
      defaultClaudeEffort: E2E_DEFAULT_CLAUDE_EFFORT,
      ...extra
    })
  )
}

/** @deprecated Prefer `seedE2eConfig` — kept so existing specs need minimal import renames. */
export function seedSkipOnboarding(userDataDir: string): void {
  seedE2eConfig(userDataDir)
}
