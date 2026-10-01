/**
 * Standalone PTY/terminal e2e — not chained behind secondary-panels serial setup.
 * Maps to src/main/panels/pty.ts (see e2e/TEST_CATEGORIES.md secondary-panels).
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test.describe('terminal-pty', () => {
  test('cortana: terminal works after create and after relaunch', async () => {
    test.setTimeout(120_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cortana-term-'))
    seedSkipOnboarding(userDataDir)
    let app: ElectronApplication | undefined
    let page: Page

    const marker = 'CORTANA-TERM-ALIVE'
    try {
      ;({ app, page } = await launchApp(userDataDir))

      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('mode-cortana').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
      await expect(page.getByTestId('cortana-tag')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

      await page.getByTestId('tab-terminal').click()
      const term = page.getByTestId('terminal-body')
      const rows = term.locator('.xterm-rows')
      await expect(term).toBeVisible({ timeout: 15_000 })
      await term.click()
      await expect.poll(async () => rows.textContent(), { timeout: 20_000 }).toMatch(/[%$#>]/)
      await page.waitForTimeout(400)
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
      // xterm textContent joins rows without "\n"; require the marker twice
      // (typed command + echo output), not merely the command line.
      await expect
        .poll(async () => {
          const text = (await rows.textContent()) ?? ''
          return (text.match(new RegExp(marker, 'g')) ?? []).length
        }, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(2)
      await page.screenshot({ path: join(artifactsDir, 'cortana-terminal-after-create.png') })

      const sessionId = await page
        .locator('[data-testid="session-row"][data-active="true"]')
        .getAttribute('data-session-id')
      expect(sessionId).toBeTruthy()

      await app.close()
      app = undefined

      ;({ app, page } = await launchApp(userDataDir))
      await expect(page.getByTestId('session-row')).toBeVisible({ timeout: 20_000 })
      await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()
      // Closed/idle Cortana shows the reconnect gate; open sessions show the tool rail.
      const gate = page.getByTestId('session-reconnect-button')
      const rail = page.getByTestId('workspace-tool-rail')
      await expect.poll(async () => {
        if (await gate.isVisible().catch(() => false)) return 'gate'
        if (await rail.isVisible().catch(() => false)) return 'rail'
        return 'wait'
      }, { timeout: 30_000 }).not.toBe('wait')
      if (await gate.isVisible().catch(() => false)) {
        await gate.click()
      }
      await expect(rail).toBeVisible({ timeout: 45_000 })
      await page.getByTestId('tab-terminal').click()
      const term2 = page.getByTestId('terminal-body')
      const rows2 = term2.locator('.xterm-rows')
      await expect(term2).toBeVisible({ timeout: 20_000 })
      await term2.click()
      await expect.poll(async () => rows2.textContent(), { timeout: 25_000 }).toMatch(/[%$#>]/)
      await page.waitForTimeout(400)
      const marker2 = 'CORTANA-TERM-RELAUNCH'
      await page.keyboard.type(`echo ${marker2}`)
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const text = (await rows2.textContent()) ?? ''
          return (text.match(new RegExp(marker2, 'g')) ?? []).length
        }, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(2)
      await page.screenshot({ path: join(artifactsDir, 'cortana-terminal-after-relaunch.png') })

      // Closed Cortana: close clears the selection; re-selecting shows the
      // reconnect gate (not a dead Terminal slot).
      await page
        .locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
        .getByTestId('session-menu-button')
        .click()
      await page.getByTestId('menu-close').click()
      await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()
      await expect(page.getByTestId('session-disconnected-panel')).toBeVisible({ timeout: 10_000 })
      await expect(page.getByTestId('workspace-tool-rail')).toHaveCount(0)
      await page.getByTestId('session-reconnect-button').click()
      await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 45_000 })
      await page.getByTestId('tab-terminal').click()
      const term3 = page.getByTestId('terminal-body')
      const rows3 = term3.locator('.xterm-rows')
      await expect(term3).toBeVisible({ timeout: 20_000 })
      await term3.click()
      await expect.poll(async () => rows3.textContent(), { timeout: 25_000 }).toMatch(/[%$#>]/)
      await page.waitForTimeout(400)
      const marker3 = 'CORTANA-TERM-RECONNECT'
      await page.keyboard.type(`echo ${marker3}`)
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const text = (await rows3.textContent()) ?? ''
          return (text.match(new RegExp(marker3, 'g')) ?? []).length
        }, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(2)
      await page.screenshot({ path: join(artifactsDir, 'cortana-terminal-after-reconnect.png') })
    } finally {
      await app?.close().catch(() => undefined)
    }
  })

  test('cortana: ⌘T toggles the Terminal split', async () => {
    test.setTimeout(60_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cortana-cmdt-'))
    seedSkipOnboarding(userDataDir)
    const { app, page } = await launchApp(userDataDir)

    try {
      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('mode-cortana').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
      await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

      const workspace = page.getByTestId('session-workspace-tabs')
      await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)

      await page.keyboard.press('Meta+t')
      await expect(workspace).toHaveClass(/session-workspace-tabs--split-row/)
      await expect(page.getByTestId('tab-terminal')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('terminal-body')).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: join(artifactsDir, 'cortana-cmd-t-open.png') })

      await page.keyboard.press('Meta+t')
      await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)
      await expect(page.getByTestId('tab-terminal')).toHaveAttribute('aria-pressed', 'false')
      await page.screenshot({ path: join(artifactsDir, 'cortana-cmd-t-closed.png') })

      // Diff/Files shortcuts must not open tools Cortana does not expose.
      await page.keyboard.press('Meta+d')
      await page.keyboard.press('Meta+f')
      await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
