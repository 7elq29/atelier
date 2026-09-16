import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

async function approveAnyPendingPermission(page: Page, timeoutMs = 5_000): Promise<void> {
  const permCard = page.getByTestId('permission-card').last()
  try {
    await expect(permCard).toBeVisible({ timeout: timeoutMs })
  } catch {
    return
  }
  await permCard.getByTestId('perm-allow').click()
}

test('Escape closes the changes popover without interrupting a running chat', async () => {
  test.setTimeout(150_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-changes-escape-userdata-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'atelier-changes-escape-project-'))
  seedSkipOnboarding(userDataDir)
  writeFileSync(join(projectDir, 'note.txt'), 'original\n')
  execFileSync('git', ['init'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.name', 'Atelier E2E'], { cwd: projectDir })
  execFileSync('git', ['add', 'note.txt'], { cwd: projectDir })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir })

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
    const notePath = join(projectDir, 'note.txt')
    await page
      .getByTestId('initial-prompt')
      .fill(
        `Use the Edit tool to replace the entire contents of ${notePath} with "changed-for-escape". ` +
          'After the edit succeeds, reply exactly CHANGES_READY.'
      )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const composer = page.locator('.composer-cache-entry.active')
    await expect(composer.getByTestId('stop-button')).toBeVisible({ timeout: 20_000 })
    const seedDeadline = Date.now() + 60_000
    while (Date.now() < seedDeadline) {
      await approveAnyPendingPermission(page, 1_500)
      if (await page.getByTestId('composer-changes-button').isVisible().catch(() => false)) break
      await page.waitForTimeout(400)
    }
    await expect(page.getByTestId('composer-changes-button')).toBeVisible({ timeout: 15_000 })
    await expect(composer.getByTestId('stop-button')).toHaveCount(0, { timeout: 90_000 })

    await composer.getByTestId('composer-input').fill(
      'Use Bash to run exactly: sleep 10 && echo changes-escape-done. Wait for it, then reply exactly CHANGES_ESC_DONE.'
    )
    await composer.getByTestId('send-button').click()
    await expect(composer.getByTestId('stop-button')).toBeVisible({ timeout: 20_000 })

    const changesButton = page.getByTestId('composer-changes-button')
    await expect(changesButton).toBeVisible()
    await changesButton.click()
    const popover = page.getByTestId('chat-uncommitted-changes')
    await expect(popover).toBeVisible()
    mkdirSync(artifactsDir, { recursive: true })
    await page.screenshot({
      path: join(artifactsDir, 'bug-changes-popover-escape-running-chat-open.png')
    })

    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    const logBeforeEscape = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    await page.keyboard.press('Escape')
    await expect(popover).toHaveCount(0)
    await page.waitForTimeout(500)
    await page.screenshot({
      path: join(artifactsDir, 'bug-changes-popover-escape-running-chat-after.png')
    })

    await expect(composer.getByTestId('stop-button')).toBeVisible()
    const logAfterEscape = readFileSync(logPath, 'utf8').slice(logBeforeEscape.length)
    expect(logAfterEscape).not.toContain('harness.interrupt() called')

    await expect(composer.getByTestId('stop-button')).toHaveCount(0, { timeout: 90_000 })
    await expect(page.getByTestId('transcript-message').last()).toContainText('CHANGES_ESC_DONE')
  } finally {
    await electronApp?.close().catch(() => undefined)
  }
})
