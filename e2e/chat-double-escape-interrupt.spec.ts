import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

test('a running chat requires two distinct Escape presses to interrupt', async () => {
  test.setTimeout(60_000)
  const projectRoot = join(__dirname, '..')
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-double-escape-userdata-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'atelier-double-escape-project-'))
  seedSkipOnboarding(userDataDir)
  execFileSync('git', ['init'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.name', 'Atelier E2E'], { cwd: projectDir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: projectDir })

  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: projectRoot
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page
      .getByTestId('initial-prompt')
      .fill('Use Bash to run exactly: sleep 20 && echo double-escape-done. Wait for it, then reply exactly DONE.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const stopButton = page.locator('.composer-cache-entry.active').getByTestId('stop-button')
    await expect(stopButton).toBeVisible({ timeout: 20_000 })
    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    const logBeforeEscape = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''

    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          repeat: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await page.waitForTimeout(100)

    await expect(stopButton).toBeVisible()
    expect(readFileSync(logPath, 'utf8').slice(logBeforeEscape.length)).not.toContain(
      'harness.interrupt() called'
    )

    await page.keyboard.press('Escape')
    await expect
      .poll(() => readFileSync(logPath, 'utf8').slice(logBeforeEscape.length), { timeout: 10_000 })
      .toContain('harness.interrupt() called')
    await expect(stopButton).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await app?.close().catch(() => undefined)
  }
})
