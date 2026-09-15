import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

async function openCommandPalette(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Alt+x')
  await expect(page.getByTestId('command-palette')).toBeVisible()
}

test('Escape closes the command palette without interrupting a running chat', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-palette-escape-userdata-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'atelier-palette-escape-project-'))
  seedSkipOnboarding(userDataDir)
  execFileSync('git', ['init'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.name', 'Atelier E2E'], { cwd: projectDir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: projectDir })

  let electronApp: ElectronApplication | undefined
  try {
    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: projectRoot
    })
    const page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page
      .getByTestId('initial-prompt')
      .fill('Use Bash to run exactly: sleep 8 && echo palette-escape-done. Wait for it, then reply exactly PALETTE_ESC_DONE.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const composer = page.locator('.composer-cache-entry.active')
    await expect(composer.getByTestId('stop-button')).toBeVisible({ timeout: 20_000 })
    await openCommandPalette(page)
    mkdirSync(artifactsDir, { recursive: true })
    await page.screenshot({
      path: join(artifactsDir, 'bug-command-palette-escape-running-chat-open.png')
    })

    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    const logBeforeEscape = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('command-palette')).toHaveCount(0)
    await page.waitForTimeout(500)
    await page.screenshot({
      path: join(artifactsDir, 'bug-command-palette-escape-running-chat-after.png')
    })

    await expect(composer.getByTestId('stop-button')).toBeVisible()
    const logAfterEscape = readFileSync(logPath, 'utf8').slice(logBeforeEscape.length)
    expect(logAfterEscape).not.toContain('harness.interrupt() called')

    await expect(composer.getByTestId('stop-button')).toHaveCount(0, { timeout: 90_000 })
    await expect(page.getByTestId('transcript-message').last()).toContainText('PALETTE_ESC_DONE')
  } finally {
    await electronApp?.close().catch(() => undefined)
  }
})
