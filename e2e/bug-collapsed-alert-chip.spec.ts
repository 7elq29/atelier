/**
 * Reproduce: orange dot should appear on a session row when the agent responds
 * while the user was still on that session and then switches away.
 *
 * Bug: if the agent finishes its turn BEFORE the user switches sessions,
 * prevDotStatusBySessionRef gets set to 'waiting-input' while the session is
 * still active. When the user then navigates away, the transition check sees
 * prevStatus === 'waiting-input' → no transition → no alert dot.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

test.describe.configure({ mode: 'serial' })

test.describe('session-ready alert dot', () => {
  let electronApp: ElectronApplication
  let page: Page
  let projectPath: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-alert-dot-'))
    seedSkipOnboarding(userDataDir)
    projectPath = join(userDataDir, 'project')
    mkdirSync(projectPath, { recursive: true })

    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: projectRoot,
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 15_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('orange dot appears on session row when agent responded while user was still on it', async () => {
    mkdirSync(artifactsDir, { recursive: true })

    // Create session 1
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectPath)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

    // Create session 2
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectPath)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

    // Switch to session 1
    await page.getByTestId('session-row').nth(0).click()
    await expect(page.getByTestId('session-row').nth(0)).toHaveAttribute('data-active', 'true')

    // Send a fast-response prompt while staying on session 1
    const composer = page.getByTestId('composer-input').first()
    await composer.fill('Reply with exactly the word: DONE')
    await composer.press('Enter')

    // Wait for the agent to respond WHILE WE ARE STILL ON SESSION 1.
    // The session dot transitions out of 'working' state when agent finishes.
    await expect(page.getByTestId('session-row').nth(0).getByTestId('session-dot')).not.toHaveClass(/status-working/, { timeout: 30_000 })

    await page.screenshot({ path: join(artifactsDir, 'alert-dot-agent-responded-still-on-s1.png') })

    // NOW switch to session 2 — this is the bug case: session 1 was already in
    // waiting-input when we switch. The orange dot should appear on session 1's row.
    await page.getByTestId('session-row').nth(1).click()
    await expect(page.getByTestId('session-row').nth(1)).toHaveAttribute('data-active', 'true')

    await page.screenshot({ path: join(artifactsDir, 'alert-dot-after-switching.png') })

    // Session 1's row should have the waiting-input-alert dot
    const alertDot = page.getByTestId('session-row').nth(0).getByTestId('session-waiting-input-alert')
    await expect(alertDot).toBeVisible({ timeout: 5_000 })

    await page.screenshot({ path: join(artifactsDir, 'alert-dot-confirmed.png') })
  })
})

test.describe('cortana session-ready alert dot', () => {
  let electronApp: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cortana-alert-dot-'))
    seedSkipOnboarding(userDataDir)

    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: projectRoot,
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 15_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('cortana: orange dot appears after respond-then-switch-away', async () => {
    mkdirSync(artifactsDir, { recursive: true })

    await page.getByTestId('new-session-button').click()
    await page.getByTestId('mode-cortana').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

    await page.getByTestId('new-session-button').click()
    await page.getByTestId('mode-cortana').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

    const cortanaRows = page.locator('[data-testid="session-row"]').filter({ has: page.getByTestId('cortana-tag') })
    await expect(cortanaRows).toHaveCount(2)
    await cortanaRows.nth(0).click()
    await expect(cortanaRows.nth(0)).toHaveAttribute('data-active', 'true')

    const composer = page.getByTestId('composer-input').locator('visible=true').first()
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill('Reply with exactly the word: DONE')
    await composer.press('Enter')

    await expect(cortanaRows.nth(0).getByTestId('session-dot')).not.toHaveClass(/status-working/, {
      timeout: 60_000
    })
    await page.screenshot({ path: join(artifactsDir, 'cortana-alert-dot-still-on-s1.png') })

    await cortanaRows.nth(1).click()
    await expect(cortanaRows.nth(1)).toHaveAttribute('data-active', 'true')
    await page.screenshot({ path: join(artifactsDir, 'cortana-alert-dot-after-switch.png') })

    await expect(cortanaRows.nth(0).getByTestId('session-waiting-input-alert')).toBeVisible({
      timeout: 5_000
    })
    await page.screenshot({ path: join(artifactsDir, 'cortana-alert-dot-confirmed.png') })
  })
})
