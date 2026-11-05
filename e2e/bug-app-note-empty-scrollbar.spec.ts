import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: join(__dirname, '..') })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test('app note: short content has no visible scrollbar chrome', async () => {
  test.setTimeout(60_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-app-note-scrollbar-'))
  const vault = join(userDataDir, 'vault')
  const notesFolder = join(vault, 'Atelier')
  mkdirSync(notesFolder, { recursive: true })
  writeFileSync(
    join(notesFolder, 'Backlog.md'),
    [
      '---',
      'tags:',
      '  - atelier',
      '---',
      '',
      '## Interview',
      '- [ ] System design questions',
      '- [ ] Coding questions',
      '',
      '## Today',
      '- [ ] Wash clothes',
      '- [ ] Vacuum second floor',
      ''
    ].join('\n')
  )
  seedE2eConfig(userDataDir, { vault: { root: vault, appNotesFolder: 'Atelier' } })

  let app: ElectronApplication | undefined
  try {
    const launched = await launchApp(userDataDir)
    app = launched.app
    const page = launched.page

    const row = page.locator('[data-testid="app-note-row"]').filter({ hasText: 'Backlog' })
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    await expect(page.getByTestId('app-notes-panel')).toBeVisible({ timeout: 15_000 })
    const scroller = page.locator('.app-notes-panel .cm-scroller')
    await expect(scroller).toBeVisible({ timeout: 15_000 })

    // scrollPastEnd makes scrollHeight > clientHeight even when the body fits;
    // the bug is the visible chrome, not overflow metrics.
    const styles = await scroller.evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      scrollbarWidth: getComputedStyle(el).getPropertyValue('scrollbar-width'),
      webkitDisplay: getComputedStyle(el, '::-webkit-scrollbar').display
    }))
    expect(styles.overflowY).toMatch(/auto|scroll/)
    expect(styles.scrollbarWidth).toBe('none')
    expect(styles.webkitDisplay).toBe('none')

    const before = await scroller.evaluate((el) => el.scrollTop)
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(before)

    await page.screenshot({ path: join(artifactsDir, 'bug-app-note-empty-scrollbar.png') })
  } finally {
    await app?.close().catch(() => undefined)
  }
})
