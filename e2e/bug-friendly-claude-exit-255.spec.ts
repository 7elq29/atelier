import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, reconnectClosedSessionFromHistory } from './e2e-config'
import { CLAUDE_CODE_EXIT_255_NOTICE } from '../src/shared/harness-error-copy'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The SDK surfaces a dead Claude Code process as
 * "Claude Code process exited with code 255". That string used to land
 * verbatim in the transcript. This spec seeds that real persisted payload
 * (same debugExecDb channel other bug specs use) and asserts the chat
 * shows the plain-language rewrite instead.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

const RAW_EXIT_255 = 'Error: Claude Code process exited with code 255'

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test('transcript rewrites Claude Code exit 255 into plain language', async () => {
  test.setTimeout(180_000)
  mkdirSync(artifactsDir, { recursive: true })
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-exit-255-copy-'))
  seedE2eConfig(userDataDir)
  const projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-exit-255-project-'))
  writeFileSync(join(projectDir, 'README.md'), '# test project\n')

  const { app, page } = await launchApp(userDataDir)
  try {
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect(page.getByTestId('session-connecting-state')).toHaveCount(0, { timeout: 90_000 })

    await row.getByTestId('session-menu-button').click()
    await page.getByTestId('menu-close').click()
    const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 10_000 })

    await page.evaluate(
      ({ sql, params }) => window.atelier.debugExecDb(sql, params),
      {
        sql: `INSERT INTO messages (session_id, role, content, raw_event, created_at) VALUES (?, 'system', ?, NULL, ?)`,
        params: [sessionId, RAW_EXIT_255, new Date().toISOString()]
      }
    )

    await reconnectClosedSessionFromHistory(page, sessionId)
    await expect(page.getByTestId('session-connecting-state')).toHaveCount(0, { timeout: 90_000 })

    const systemMsg = page.locator('[data-testid="transcript-message"][data-role="system"]').last()
    await expect(systemMsg).toContainText(CLAUDE_CODE_EXIT_255_NOTICE, { timeout: 15_000 })
    await expect(systemMsg).not.toContainText('code 255')
    await expect(systemMsg).not.toContainText('process exited')

    await page.screenshot({ path: join(artifactsDir, 'friendly-claude-exit-255.png') })
  } finally {
    await app.close()
  }
})
