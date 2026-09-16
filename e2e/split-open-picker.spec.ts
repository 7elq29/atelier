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

/** Press Ctrl+X then bare 2 to open the split-open picker. */
async function openPicker(page: Page): Promise<void> {
  await page.keyboard.press('Control+x')
  await page.keyboard.press('2')
}

test.describe.configure({ mode: 'serial' })

test.describe('split-open picker (Ctrl+X 2)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let projectPath: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-split-open-picker-'))
    seedSkipOnboarding(userDataDir)
    projectPath = join(userDataDir, 'project')
    mkdirSync(projectPath, { recursive: true })
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    // Create a claude-code session to enable the picker.
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

  test('Ctrl+X 2 opens the split-open picker', async () => {
    await openPicker(page)
    await expect(page.getByTestId('split-open-picker')).toBeVisible()
    await expect(page.getByTestId('split-open-picker-input')).toBeFocused()
  })

  test('Escape closes the picker without opening a split', async () => {
    // Picker should already be open from previous test.
    await expect(page.getByTestId('split-open-picker')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('split-open-picker')).toHaveCount(0)
    // No split should have been created.
    await expect(page.getByTestId('session-workspace-tabs')).not.toHaveClass(
      /session-workspace-tabs--split/
    )
  })

  test('Workspace tools appear in the picker', async () => {
    await openPicker(page)
    const picker = page.getByTestId('split-open-picker')
    await expect(picker).toBeVisible()
    await expect(page.getByTestId('split-open-picker-item').filter({ hasText: 'Diff' })).toBeVisible()
    await expect(page.getByTestId('split-open-picker-item').filter({ hasText: 'Files' })).toBeVisible()
    await expect(page.getByTestId('split-open-picker-item').filter({ hasText: 'Terminal' })).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('Fuzzy filter narrows results', async () => {
    await openPicker(page)
    const input = page.getByTestId('split-open-picker-input')
    await input.fill('diff')
    const items = page.getByTestId('split-open-picker-item')
    // Only Diff should remain after filtering.
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText('Diff')
    await page.keyboard.press('Escape')
  })

  test('Selecting Files opens the split view with Files panel on the right', async () => {
    await openPicker(page)
    const input = page.getByTestId('split-open-picker-input')
    await input.fill('Files')
    const items = page.getByTestId('split-open-picker-item')
    await expect(items).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('split-open-picker')).toHaveCount(0)

    const workspace = page.getByTestId('session-workspace-tabs')
    await expect(workspace).toHaveClass(/session-workspace-tabs--split-row/)
    await expect(page.locator('.tab-content[data-tab="files"]')).toHaveClass(
      /workspace-split-pane--secondary/
    )

    await page.screenshot({ path: 'e2e-artifacts/split-open-picker-files.png' })
  })

  test('Clicking primary pane sets splitActivePanel to primary', async () => {
    // Split is still open from the previous test (Files on secondary).
    const primaryPane = page.locator('.workspace-split-pane--primary')
    const secondaryPane = page.locator('.workspace-split-pane--secondary')
    await expect(primaryPane).toBeVisible()
    await expect(secondaryPane).toBeVisible()

    // Click inside the secondary pane first to make primary the "not active" starting point.
    await secondaryPane.click({ position: { x: 20, y: 20 }, force: true })
    await page.waitForTimeout(100)
    const afterSecondaryClick = await page.evaluate(() => document.body.dataset.splitActivePanel)
    expect(afterSecondaryClick).toBe('secondary')

    // Now click inside the primary pane (chat transcript area).
    await primaryPane.click({ position: { x: 20, y: 20 }, force: true })
    await page.waitForTimeout(100)
    const afterPrimaryClick = await page.evaluate(() => document.body.dataset.splitActivePanel)
    expect(afterPrimaryClick).toBe('primary')

    await page.screenshot({ path: 'e2e-artifacts/split-active-pane-primary.png' })
  })

  test('Clicking backdrop closes the picker', async () => {
    // Close the split first via Ctrl+X K.
    await page.keyboard.press('Control+x')
    await page.keyboard.press('k')

    await openPicker(page)
    await expect(page.getByTestId('split-open-picker')).toBeVisible()
    // Click the backdrop (outside the dialog).
    await page.getByTestId('split-open-picker-backdrop').click({ position: { x: 5, y: 5 } })
    await expect(page.getByTestId('split-open-picker')).toHaveCount(0)
  })

  test('Selecting Terminal opens the split view with Terminal on the right', async () => {
    await openPicker(page)
    const input = page.getByTestId('split-open-picker-input')
    await input.fill('Terminal')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('split-open-picker')).toHaveCount(0)

    const workspace = page.getByTestId('session-workspace-tabs')
    await expect(workspace).toHaveClass(/session-workspace-tabs--split-row/)
    await expect(page.locator('.tab-content[data-tab="terminal"]')).toHaveClass(
      /workspace-split-pane--secondary/
    )

    await page.screenshot({ path: 'e2e-artifacts/split-open-picker-terminal.png' })
  })
})
