import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const packagedApp = '/Applications/Atelier.app/Contents/MacOS/Atelier'
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

test('packaged Atelier.app: local session with ~ path spawns claude', async ({}, testInfo) => {
  testInfo.setTimeout(120_000)
  mkdirSync(artifactsDir, { recursive: true })

  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-packaged-'))
  seedSkipOnboarding(userDataDir)

  const app = await electron.launch({
    executablePath: packagedApp,
    args: [`--user-data-dir=${userDataDir}`],
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('project-path').fill('~')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
    await expect
      .poll(
        () => {
          const log = readFileSync(logFilePath, 'utf-8')
          return (
            log.includes('resolved claude code executable') &&
            log.includes('app.asar.unpacked') &&
            !log.includes('failed to launch') &&
            !log.includes('aifx: command not found') &&
            (log.includes('session_started') || log.includes('harness event: commands_updated'))
          )
        },
        { timeout: 90_000 },
      )
      .toBe(true)

    await page.getByTestId('composer-input').fill('hello')
    await page.getByTestId('send-button').click()
    await expect
      .poll(
        async () => {
          const assistantCount = await page
            .locator('[data-testid="transcript-message"][data-role="assistant"]')
            .count()
          const noticeCount = await page.getByTestId('transcript-notice').count()
          return assistantCount + noticeCount
        },
        { timeout: 120_000 },
      )
      .toBeGreaterThan(0)

    await page.screenshot({ path: join(artifactsDir, 'packaged-local-tilde-session.png') })
  } finally {
    await app.close().catch(() => undefined)
  }
})
