import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e2e-files-ctrl-n-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'E2E Test'], { cwd: dir })
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'index.ts'), 'export const value = 1\n')
  writeFileSync(join(dir, 'README.md'), '# Fixture\n')
  writeFileSync(join(dir, 'package.json'), '{}\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'Initial commit'], { cwd: dir })
  return dir
}

test.describe('Files directory keyboard navigation', () => {
  let app: ElectronApplication
  let page: Page
  let userDataDir: string
  let repoDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-files-ctrl-n-user-'))
    repoDir = buildFixtureRepo()
    seedSkipOnboarding(userDataDir)
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: projectRoot
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await app.close().catch(() => undefined)
  })

  test('Ctrl+N moves down and Ctrl+P moves up', async () => {
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(repoDir)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await page.getByTestId('tab-files').click()
    const listing = page.getByTestId('files-panel-active').getByTestId('files-dir-listing')
    await expect(listing).toBeVisible({ timeout: 10_000 })
    const rows = listing.locator('.files-dir-listing-item')
    expect(await rows.count()).toBeGreaterThan(1)

    const mainLog = readFileSync(join(userDataDir, 'logs', 'main.log'), 'utf-8')
    expect(mainLog).toContain('"msg":"files:dir"')

    await listing.focus()
    await listing.press('ArrowDown')
    await expect(rows.nth(0)).toHaveClass(/active/)

    await listing.press('Control+n')
    await page.screenshot({ path: join(artifactsDir, 'bug-files-directory-ctrl-n-after.png') })
    await expect(rows.nth(1)).toHaveClass(/active/)

    await listing.press('Control+p')
    await expect(rows.nth(0)).toHaveClass(/active/)
  })
})
