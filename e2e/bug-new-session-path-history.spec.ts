import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Path history on New Session: creating a Claude Code session records the
 * project path; reopening the modal auto-fills the latest path and offers it
 * in the suggestions list (including after relaunch via SQLite).
 *
 * Terminal is no longer offered in this modal — Claude Code create (no
 * initial prompt) is enough to hit recordProjectPathUsage without an SDK turn.
 */

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: projectRoot })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe('bug-repro: new-session project path history', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let localDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-path-history-'))
    seedSkipOnboarding(userDataDir)
    localDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-path-ac-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('creating a session records the path, which is auto-filled as the latest on reopen', async () => {
    await openNewSessionModal(page)
    await expect(page.getByTestId('mode-terminal')).toHaveCount(0)
    await expect(page.getByTestId('mode-claude-code')).toHaveClass(/selected/)
    await expect(page.getByTestId('mode-cortana')).toBeVisible()
    await expect(page.getByTestId('mode-minion')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, 'new-session-modal-redesign.png') })

    const pathInput = page.getByTestId('project-path')
    await pathInput.fill(localDir)
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await openNewSessionModal(page)
    const reopened = page.getByTestId('project-path')
    await expect(reopened).toHaveValue(localDir, { timeout: 5_000 })
    await reopened.click()
    await expect(page.getByTestId('project-path-suggestions')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('project-path-suggestion-history').first()).toContainText(localDir)

    await page.screenshot({ path: join(artifactsDir, 'fix-new-session-path-history-after-reopen.png') })
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('path history persists across an app relaunch (read from SQLite, not just in-memory state)', async () => {
    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    await openNewSessionModal(page)
    await expect(page.getByTestId('project-path')).toHaveValue(localDir)
    await page.getByTestId('project-path').click()
    await expect(page.getByTestId('project-path-suggestion-history').first()).toContainText(localDir)

    await page.screenshot({ path: join(artifactsDir, 'fix-new-session-path-history-after-relaunch.png') })
    await page.getByRole('button', { name: 'Cancel' }).click()
  })

  test('local project path shows history and directory suggestions while typing', async () => {
    await openNewSessionModal(page)
    const reopened = page.getByTestId('project-path')
    await expect(reopened).toHaveValue(localDir, { timeout: 5_000 })
    await reopened.click()
    await reopened.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    const partial = localDir.slice(0, Math.max(4, localDir.length - 3))
    await reopened.pressSequentially(partial, { delay: 10 })

    await expect(page.getByTestId('project-path-suggestions')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('project-path-suggestion-history').first()).toContainText(localDir)

    await page.getByRole('button', { name: 'Cancel' }).click()
  })
})
