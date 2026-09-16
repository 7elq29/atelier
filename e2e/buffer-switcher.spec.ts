import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: join(__dirname, '..')
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Press Ctrl+X then bare B to open the buffer switcher. */
async function openSwitcher(page: Page): Promise<void> {
  await page.keyboard.press('Control+x')
  await page.keyboard.press('b')
}

test.describe.configure({ mode: 'serial' })

test.describe('buffer switcher (Ctrl+X B)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let projectPath: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-buffer-switcher-'))
    seedSkipOnboarding(userDataDir)
    projectPath = join(userDataDir, 'project')
    mkdirSync(projectPath, { recursive: true })
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    // Create a claude-code session to have something to switch between.
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectPath)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: READY')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('Ctrl+X B opens the buffer switcher', async () => {
    await openSwitcher(page)
    await expect(page.getByTestId('buffer-switcher')).toBeVisible()
    await expect(page.getByTestId('buffer-switcher-input')).toBeFocused()
    await expect(page.getByTestId('buffer-switcher-input')).toHaveAttribute('placeholder', 'Switch to…')
  })

  test('Escape closes the buffer switcher', async () => {
    await expect(page.getByTestId('buffer-switcher')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('buffer-switcher')).toHaveCount(0)
  })

  test('Sessions category shows the current session', async () => {
    await openSwitcher(page)
    await expect(page.getByTestId('buffer-switcher-category').filter({ hasText: 'Sessions' })).toBeVisible()
    await expect(page.getByTestId('buffer-switcher-item').filter({ hasText: 'Reply with exactly' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('Daily Note and Weekly Plan entries are always present', async () => {
    await openSwitcher(page)
    await expect(page.getByTestId('buffer-switcher-item').filter({ hasText: 'Daily Note' })).toBeVisible()
    await expect(page.getByTestId('buffer-switcher-item').filter({ hasText: 'Weekly Plan' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('Fuzzy filter narrows results', async () => {
    await openSwitcher(page)
    await page.getByTestId('buffer-switcher-input').fill('daily')
    const items = page.getByTestId('buffer-switcher-item')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText('Daily Note')
    await page.keyboard.press('Escape')
  })

  test('Selecting Daily Note switches to the daily note view', async () => {
    await openSwitcher(page)
    await page.getByTestId('buffer-switcher-input').fill('Daily Note')
    await expect(page.getByTestId('buffer-switcher-item')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('buffer-switcher')).toHaveCount(0)
    // Daily note panel should now be visible.
    await expect(page.getByTestId('daily-note-editor')).toBeVisible({ timeout: 5_000 })

    await page.screenshot({ path: 'e2e-artifacts/buffer-switcher-daily-note.png' })
  })

  test('Selecting a Session switches back to the session', async () => {
    // From the daily note view, switch back to the session via the buffer switcher.
    await openSwitcher(page)
    await page.getByTestId('buffer-switcher-input').fill('Reply with exactly')
    const items = page.getByTestId('buffer-switcher-item')
    await expect(items).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('buffer-switcher')).toHaveCount(0)
    // Session workspace should now be visible (not daily note).
    await expect(page.getByTestId('daily-note-editor')).toHaveCount(0)
    await expect(page.getByTestId('workspace-tool-rail')).toBeVisible()

    await page.screenshot({ path: 'e2e-artifacts/buffer-switcher-session.png' })
  })

  test('Ctrl+X B is accessible from the daily note view (global shortcut)', async () => {
    // Open daily note, then open buffer switcher from within it.
    await page.getByTestId('daily-note-row').click()
    await expect(page.getByTestId('daily-note-editor')).toBeVisible({ timeout: 5_000 })
    await openSwitcher(page)
    await expect(page.getByTestId('buffer-switcher')).toBeVisible()
    await page.keyboard.press('Escape')
    // Return to session.
    await openSwitcher(page)
    await page.getByTestId('buffer-switcher-input').fill('Reply with exactly')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('daily-note-editor')).toHaveCount(0)
  })
})
