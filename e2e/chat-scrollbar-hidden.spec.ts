import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

test('overflowing chat scrolls without visible scrollbar chrome', async () => {
  test.setTimeout(60_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-chat-scrollbar-'))
  seedSkipOnboarding(userDataDir)
  const projectPath = join(userDataDir, 'project')
  mkdirSync(projectPath, { recursive: true })

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: join(__dirname, '..')
  })

  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectPath)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    const overflowPrompt = [
      'Reply with exactly DONE after reading these reference lines:',
      ...Array.from({ length: 80 }, (_, index) => `Reference line ${index + 1}.`)
    ].join('\n')
    await page.getByTestId('initial-prompt').fill(overflowPrompt)
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const scrollContainer = page.locator('.chat-body-row')
    await expect(scrollContainer).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(
        () => scrollContainer.evaluate((el) => el.scrollHeight > el.clientHeight),
        { timeout: 30_000 }
      )
      .toBe(true)

    const styles = await scrollContainer.evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      scrollbarWidth: getComputedStyle(el).getPropertyValue('scrollbar-width'),
      webkitDisplay: getComputedStyle(el, '::-webkit-scrollbar').display
    }))
    expect(styles.overflowY).toMatch(/auto|scroll/)
    expect(styles.scrollbarWidth).toBe('none')
    expect(styles.webkitDisplay).toBe('none')

    const before = await scrollContainer.evaluate((el) => el.scrollTop)
    await scrollContainer.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect.poll(() => scrollContainer.evaluate((el) => el.scrollTop)).toBeGreaterThan(before)

    const timelineClose = page.getByTestId('daily-notes-close')
    if (await timelineClose.isVisible().catch(() => false)) {
      await timelineClose.click()
    }
    await page.screenshot({
      path: join(__dirname, '..', 'e2e-artifacts', 'chat-scrollbar-hidden.png')
    })
  } finally {
    await app.close().catch(() => undefined)
  }
})
