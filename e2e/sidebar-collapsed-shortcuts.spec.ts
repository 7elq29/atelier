/**
 * Feature: Cmd+number switches sessions/notes when sidebar is collapsed.
 * Feature: Toast notification shows shortcut number when a background session's agent finishes.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

test.describe.configure({ mode: 'serial' })

test.describe('sidebar collapsed shortcuts + session-ready toast', () => {
  let electronApp: ElectronApplication
  let page: Page
  let projectPath: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-sidebar-shortcuts-'))
    seedSkipOnboarding(userDataDir)
    projectPath = join(userDataDir, 'project')
    mkdirSync(projectPath, { recursive: true })

    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: join(__dirname, '..')
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Create session 1
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectPath)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('session-row').first()).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('Cmd+1 switches to session 1 when sidebar is collapsed', async () => {
    const sidebar = page.getByTestId('sidebar')

    // Navigate to daily note so session is not the active view
    await page.getByTestId('daily-note-row').click()
    await expect(page.getByTestId('daily-note-row')).toHaveAttribute('data-active', 'true')

    // Collapse sidebar
    await page.keyboard.press('Meta+ArrowLeft')
    await expect(sidebar).toHaveClass(/collapsed/)

    await page.screenshot({ path: join(artifactsDir, 'sidebar-collapsed-before-cmd1.png') })

    // Cmd+1 should switch to session 1
    await page.keyboard.press('Meta+1')

    await page.screenshot({ path: join(artifactsDir, 'sidebar-collapsed-after-cmd1.png') })

    // Expand to verify
    await page.keyboard.press('Meta+ArrowLeft')
    await expect(sidebar).not.toHaveClass(/collapsed/)
    await expect(page.getByTestId('session-row').first()).toHaveAttribute('data-active', 'true')
    await expect(page.getByTestId('daily-note-row')).toHaveAttribute('data-active', 'false')
  })

  test('toast with shortcut number appears when background session agent finishes', async () => {
    // Create session 2 — it becomes active, session 1 goes to background.
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectPath)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    // Wait for session 2's workspace tool rail — confirms it's connected and active
    await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

    // Now switch to session 1 (background session)
    const sessionRows = page.getByTestId('session-row')
    await sessionRows.nth(0).click()  // session 1 (first in list)
    await expect(sessionRows.nth(0)).toHaveAttribute('data-active', 'true')

    // Send a prompt to session 1 (it will run while we watch)
    const composer = page.getByTestId('composer-input').first()
    await composer.fill('Reply with exactly the word: DONE')
    await composer.press('Enter')

    // Switch to session 2 so session 1 runs in background
    await sessionRows.nth(1).click()
    await expect(sessionRows.nth(1)).toHaveAttribute('data-active', 'true')

    await page.screenshot({ path: join(artifactsDir, 'session-toast-waiting.png') })

    // Wait for the toast to appear — session 1 agent finishes in background
    const toast = page.getByTestId('app-toast')
    await expect(toast).toBeVisible({ timeout: 60_000 })
    const toastText = await toast.textContent()

    await page.screenshot({ path: join(artifactsDir, 'session-toast-appeared.png') })

    console.log('Toast text:', toastText)
    // Should contain the shortcut number (⌘1 since session 1 is first)
    expect(toastText).toMatch(/Session ready.*⌘\d+/)
  })

  test('Ctrl+L focuses the composer input when a session is active', async () => {
    // Ensure session is active (not a note view)
    const sessionRows = page.getByTestId('session-row')
    await sessionRows.nth(0).click()
    await expect(sessionRows.nth(0)).toHaveAttribute('data-active', 'true')

    // Click somewhere else to move focus away from the composer
    await page.locator('.topbar').click()

    // Ctrl+L should bring focus back to the composer
    await page.keyboard.press('Control+l')
    const composer = page.getByTestId('composer-input').first()
    await expect(composer).toBeFocused()
  })
})
