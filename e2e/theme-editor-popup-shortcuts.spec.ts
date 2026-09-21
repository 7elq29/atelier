/**
 * E2E tests for keyboard shortcuts in the theme editor popup window.
 *
 * The theme editor is a detached BrowserWindow — a separate OS-level window.
 * Before the fix, no keyboard shortcuts worked in it because all shortcuts
 * lived in the main window's renderer.
 *
 * Verifies:
 *  1. Escape closes the popup (cancel without saving)
 *  2. Cmd+S saves and closes the popup
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

/** Open Settings and navigate to the Theme pane, closing first if needed. */
async function openThemePane(page: Page): Promise<void> {
  const settingsPanel = page.getByTestId('settings-panel')
  if (await settingsPanel.isVisible()) {
    await page.keyboard.press('Escape')
    await expect(settingsPanel).toBeHidden({ timeout: 3_000 })
  }
  await page.getByTestId('open-settings-button').click()
  await expect(settingsPanel).toBeVisible({ timeout: 5_000 })
  await page.locator('.settings-nav button', { hasText: /^Theme$/ }).click()
  await expect(page.getByTestId('settings-pane-theme')).toBeVisible()
}

/** Open the popup and return its Page once the editor heading is rendered. */
async function openThemeEditorPopup(app: ElectronApplication, page: Page): Promise<Page> {
  const popupPromise = app.waitForEvent('window')
  await page.getByTestId('theme-add-btn').click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  // ThemeEditorWindow shows "Loading…" while fetching via IPC; wait for h2.
  await popup.waitForSelector('h2', { timeout: 10_000 })
  // Click inside the popup to ensure it has OS focus for keyboard events
  await popup.click('h2')
  return popup
}

/**
 * Dispatch a keydown event directly inside the popup's JS context.
 * Using page.evaluate avoids Playwright's cross-window keyboard quirks.
 */
async function dispatchKey(popup: Page, key: string, meta = false, ctrl = false): Promise<void> {
  await popup.evaluate(
    ({ key, metaKey, ctrlKey }) => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key, metaKey, ctrlKey,
        bubbles: true, cancelable: true
      }))
    },
    { key, metaKey: meta, ctrlKey: ctrl }
  )
}

test.describe('theme-editor-popup-shortcuts', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-theme-popup-'))
    seedE2eConfig(userDataDir)
    app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app.close().catch(() => undefined)
  })

  // ── 1. Escape closes the popup ─────────────────────────────────────

  test('Escape closes the theme editor popup', async () => {
    await openThemePane(page)
    const windowsBefore = app.windows().length
    const popup = await openThemeEditorPopup(app, page)

    await popup.screenshot({ path: join(artifactsDir, 'theme-popup-open.png') })

    expect(app.windows().length, 'popup opened').toBe(windowsBefore + 1)

    // Dispatch Escape inside the popup's JS context
    await dispatchKey(popup, 'Escape')

    await expect.poll(
      () => app.windows().length,
      { timeout: 5_000, message: 'popup should close after Escape' }
    ).toBe(windowsBefore)

    await page.screenshot({ path: join(artifactsDir, 'theme-popup-escape-closed.png') })
  })

  // ── 2. Cmd+S saves and closes the popup ───────────────────────────

  test('Cmd+S saves and closes the theme editor popup', async () => {
    await openThemePane(page)
    const windowsBefore = app.windows().length
    const popup = await openThemeEditorPopup(app, page)

    // Fill the name (save requires non-empty name)
    const nameInput = popup.locator('input.input').first()
    await nameInput.click()
    await nameInput.fill('Test Theme')

    await popup.screenshot({ path: join(artifactsDir, 'theme-popup-filled.png') })

    // Dispatch Cmd+S inside the popup's JS context
    await dispatchKey(popup, 's', /* meta */ true)

    await expect.poll(
      () => app.windows().length,
      { timeout: 5_000, message: 'popup should close after Cmd+S' }
    ).toBe(windowsBefore)

    await page.screenshot({ path: join(artifactsDir, 'theme-popup-cmds-saved.png') })
  })
})
