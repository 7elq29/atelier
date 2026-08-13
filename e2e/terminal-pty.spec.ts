/**
 * Standalone PTY/terminal e2e — not chained behind secondary-panels serial setup.
 * Maps to src/main/panels/pty.ts (see e2e/TEST_CATEGORIES.md secondary-panels).
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
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
  test('terminal-only session: real shell echoes real output', async () => {
    test.setTimeout(60_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-terminal-pty-'))
    seedSkipOnboarding(userDataDir)
    const { app, page } = await launchApp(userDataDir)

    try {
      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('project-path').fill(projectRoot)
      await page.getByTestId('mode-terminal').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

      await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 15_000 })
      const term = page.getByTestId('terminal-body')
      await term.click()

      const spawnErr = await page.evaluate(async () => {
        const id = 'e2e-terminal-pty-probe'
        try {
          await window.atelier.ptySpawn({ id, cwd: '/tmp', hostname: null, cols: 80, rows: 24 })
          await window.atelier.ptyKill(id)
          return null
        } catch (e) {
          return String(e)
        }
      })
      if (spawnErr) {
        const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
        writeFileSync(join(artifactsDir, 'terminal-pty-spawn-error.txt'), `${spawnErr}\nlog: ${logPath}\n`)
      }
      expect(spawnErr, 'ptySpawn IPC should succeed (see e2e-artifacts/terminal-pty-spawn-error.txt)').toBeNull()

      await page.keyboard.type('echo hello-from-terminal-mode')
      await page.keyboard.press('Enter')

      await expect.poll(async () => term.textContent(), { timeout: 15_000 }).toContain('hello-from-terminal-mode')
      await page.screenshot({ path: join(artifactsDir, 'terminal-pty-echo.png') })
    } finally {
      await app.close().catch(() => undefined)
    }
  })
})
