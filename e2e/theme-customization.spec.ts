/**
 * E2E tests for the custom theme feature:
 *   - Create a custom theme via Settings > Theme pane
 *   - Verify it is immediately applied (inline CSS variables on <html>)
 *   - Edit name and a color — verify the persisted state updates
 *   - Switch back to a built-in theme — verify custom variables are removed
 *   - Re-select the custom theme — verify variables re-appear
 *   - Delete the theme — verify the list is empty and built-in is restored
 *   - Cancel in editor reverts the live preview without saving
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig } from './e2e-config'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Open Settings and navigate to the Theme pane (which now contains custom themes). */
async function openThemePane(page: Page): Promise<void> {
  await page.getByTestId('open-settings-button').click()
  await expect(page.getByTestId('settings-panel')).toBeVisible()
  // Use exact text match to avoid ambiguity with other buttons.
  await page.locator('.settings-nav button', { hasText: /^Theme$/ }).click()
  await expect(page.getByTestId('settings-pane-theme')).toBeVisible()
}

/** Read the persisted config from disk (not from the running app). */
function readConfig(userDataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(userDataDir), 'utf-8')) as Record<string, unknown>
}

/**
 * Set a color <input type="color"> value in a way that React's synthetic event
 * system picks up. Plain `new Event('change')` is ignored by React; we must go
 * through the native value setter on HTMLInputElement.prototype.
 */
async function setColorInput(page: Page, testId: string, color: string): Promise<void> {
  await page.evaluate(
    ([tid, c]: [string, string]) => {
      const input = document.querySelector(`[data-testid="${tid}"]`) as HTMLInputElement | null
      if (!input) throw new Error(`color input not found: ${tid}`)
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      if (setter) setter.call(input, c)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
    [testId, color] as [string, string]
  )
}

test.describe('theme customization', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-themes-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    seedE2eConfig(userDataDir)
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test('Theme pane shows built-in selector and empty custom theme list', async () => {
    await openThemePane(page)
    await expect(page.getByTestId('custom-theme-list')).toBeVisible()
    await expect(page.getByTestId('custom-theme-list')).toContainText('No custom themes yet')
    await page.screenshot({ path: join(artifactsDir, 'theme-custom-empty.png') })
  })

  test('Create a new theme — modal opens, save persists and applies it', async () => {
    await page.getByTestId('theme-add-btn').click()
    await expect(page.getByTestId('theme-edit-modal')).toBeVisible()

    await page.getByTestId('theme-edit-name-input').fill('My Blue Theme')
    await page.getByTestId('theme-edit-base-dark').click()

    // Set App bg to a distinctive test color.
    await setColorInput(page, 'theme-color-bgApp', '#1a2a3a')

    await page.screenshot({ path: join(artifactsDir, 'theme-edit-modal.png') })

    await page.getByTestId('theme-edit-save-btn').click()
    await expect(page.getByTestId('theme-edit-modal')).toHaveCount(0)

    // Row appears selected.
    const row = page.locator('[data-testid^="theme-row-"]').first()
    await expect(row).toBeVisible()
    await expect(row).toHaveClass(/selected/)
    await expect(row).toContainText('My Blue Theme')

    await page.screenshot({ path: join(artifactsDir, 'theme-custom-created.png') })
  })

  test('Active custom theme writes inline CSS properties on <html>', async () => {
    const bgApp = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bg-app').trim()
    )
    expect(bgApp).toBe('#1a2a3a')

    const dataTheme = await page.evaluate(() => document.documentElement.dataset.theme)
    expect(dataTheme).toBe('dark')
  })

  test('activeCustomThemeId is persisted to config.json', async () => {
    const cfg = readConfig(userDataDir)
    expect(typeof cfg.activeCustomThemeId).toBe('string')
    expect((cfg.customThemes as unknown[]).length).toBe(1)
  })

  test('Edit theme — rename and change a color — updates applied theme live', async () => {
    const row = page.locator('[data-testid^="theme-row-"]').first()
    const themeId = (await row.getAttribute('data-testid'))?.replace('theme-row-', '') as string

    await page.getByTestId(`theme-edit-btn-${themeId}`).click()
    await expect(page.getByTestId('theme-edit-modal')).toBeVisible()

    await page.getByTestId('theme-edit-name-input').fill('Ocean Night')
    await setColorInput(page, 'theme-color-bgSidebar', '#162232')

    // Live preview: sidebar var should be set already.
    const liveSidebar = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bg-sidebar').trim()
    )
    expect(liveSidebar).toBe('#162232')

    await page.getByTestId('theme-edit-save-btn').click()
    await expect(page.getByTestId('theme-edit-modal')).toHaveCount(0)

    await expect(page.locator('[data-testid^="theme-row-"]').first()).toContainText('Ocean Night')
    await page.screenshot({ path: join(artifactsDir, 'theme-custom-edited.png') })
  })

  test('Clicking built-in Light removes all inline custom properties', async () => {
    await page.getByTestId('theme-light-btn').click()

    const bgApp = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bg-app').trim()
    )
    expect(bgApp).toBe('')

    const dataTheme = await page.evaluate(() => document.documentElement.dataset.theme)
    expect(dataTheme).toBe('light')

    await expect(page.locator('.theme-row.selected')).toHaveCount(0)
    await page.screenshot({ path: join(artifactsDir, 'theme-custom-builtin-light.png') })
  })

  test('Re-selecting the custom theme re-applies inline props', async () => {
    const row = page.locator('[data-testid^="theme-row-"]').first()
    await row.click()
    await expect(row).toHaveClass(/selected/)

    const bgApp = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bg-app').trim()
    )
    expect(bgApp).toBe('#1a2a3a')

    await page.screenshot({ path: join(artifactsDir, 'theme-custom-reselected.png') })
  })

  test('Delete the theme — list is empty, built-in theme takes over', async () => {
    const row = page.locator('[data-testid^="theme-row-"]').first()
    const themeId = (await row.getAttribute('data-testid'))?.replace('theme-row-', '') as string

    await page.getByTestId(`theme-delete-btn-${themeId}`).click()

    await expect(page.locator(`[data-testid="theme-row-${themeId}"]`)).toHaveCount(0)
    await expect(page.getByTestId('custom-theme-list')).toContainText('No custom themes yet')

    const bgApp = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bg-app').trim()
    )
    expect(bgApp).toBe('')

    await page.screenshot({ path: join(artifactsDir, 'theme-custom-deleted.png') })
  })

  test('Cancel in theme editor reverts live preview without saving', async () => {
    // Start from dark built-in (activeCustomThemeId should be null after delete).
    await page.getByTestId('theme-dark-btn').click()

    await page.getByTestId('theme-add-btn').click()
    await expect(page.getByTestId('theme-edit-modal')).toBeVisible()

    await page.getByTestId('theme-edit-name-input').fill('Temp Theme')
    await setColorInput(page, 'theme-color-bgApp', '#ff0000')

    // Live preview fires during editing.
    const liveBg = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bg-app').trim()
    )
    expect(liveBg).toBe('#ff0000')

    // Cancel — preview should revert, no theme saved.
    await page.getByTestId('theme-edit-close').click()
    await expect(page.getByTestId('theme-edit-modal')).toHaveCount(0)

    const revertedBg = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue('--bg-app').trim()
    )
    expect(revertedBg).not.toBe('#ff0000')

    await expect(page.getByTestId('custom-theme-list')).toContainText('No custom themes yet')
  })
})
