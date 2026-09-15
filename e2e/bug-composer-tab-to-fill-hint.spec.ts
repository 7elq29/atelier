import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

const SUGGESTION = 'mark the tier-1 pairs unknown too'

function activeComposer(page: Page) {
  return page.locator('.composer-cache-entry.active')
}

/**
 * Pushes the same `session:promptSuggestion` IPC the real harness sends from
 * `SessionManager` when the SDK emits `prompt_suggestion`, so the ghost-
 * suggestion composer state is reachable without depending on whether a
 * given live SDK turn happens to emit that optional event.
 */
async function pushPromptSuggestion(app: ElectronApplication, sessionId: string): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('session:promptSuggestion', payload)
    },
    { sessionId, suggestion: SUGGESTION }
  )
}

test('composer shows a ghost prompt suggestion without a "Tab to fill" hint', async ({}, testInfo) => {
  testInfo.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-tab-hint-'))
  seedSkipOnboarding(userDataDir)
  const projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-tab-hint-project-'))
  execFileSync('git', ['init'], { cwd: projectDir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: projectDir })

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: READY.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    const composer = activeComposer(page)
    const input = composer.getByTestId('composer-input')
    await expect(composer.getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 90_000 })
    await expect(composer.getByTestId('send-button')).toBeVisible()

    await pushPromptSuggestion(app, sessionId)
    await expect(input).toHaveAttribute('placeholder', SUGGESTION, { timeout: 10_000 })

    // The hint this bug is about: gone from the footer, in the exact state
    // (idle turn + empty input + live suggestion) that used to render it.
    await expect(composer.getByTestId('composer-suggestion-hint')).toHaveCount(0)
    await expect(composer.locator('.composer-footer')).not.toContainText('Tab to fill')
    await expect(composer).not.toContainText('Tab to fill')

    mkdirSync(artifactsDir, { recursive: true })
    await composer.screenshot({ path: join(artifactsDir, 'bug-composer-tab-to-fill-hint-removed.png') })

    // Tab still accepts the suggestion — only the hint text was removed.
    await input.click()
    await input.press('Tab')
    await expect(input).toHaveValue(SUGGESTION)
    await expect(composer).not.toContainText('Tab to fill')
  } finally {
    await app.close()
  }
})
