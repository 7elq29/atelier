import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd })
}

function buildFixtureRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'atelier-e2e-diff-scrollbar-'))
  git(repo, ['init', '-q'])
  git(repo, ['config', 'user.email', 'e2e@example.com'])
  git(repo, ['config', 'user.name', 'E2E Test'])
  writeFileSync(join(repo, 'short.ts'), 'export const short = 1\n')
  writeFileSync(join(repo, 'wide.ts'), 'export const wide = 1\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'Initial fixture'])
  writeFileSync(join(repo, 'short.ts'), 'export const short = 2\n')
  writeFileSync(join(repo, 'wide.ts'), `export const wide = '${'x'.repeat(600)}'\n`)
  return repo
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: join(__dirname, '..')
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test('diff hunk scrollbar appears only for genuinely overflowing lines', async () => {
  test.setTimeout(60_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-diff-scrollbar-data-'))
  const repo = buildFixtureRepo()
  seedSkipOnboarding(userDataDir)
  let app: ElectronApplication | undefined

  try {
    const launched = await launchApp(userDataDir)
    app = launched.app
    const page = launched.page
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(repo)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()

    await page.getByTestId('tab-diff').click()
    const diff = page.getByTestId('diff-panel-active')
    await expect(diff).toBeVisible({ timeout: 15_000 })
    await expect(diff.getByTestId('diff-refreshing')).toHaveCount(0, { timeout: 30_000 })

    const shortLines = diff.locator('[data-diff-file-path="short.ts"] .diff-lines')
    const wideLines = diff.locator('[data-diff-file-path="wide.ts"] .diff-lines')
    await expect(shortLines.locator('.diff-line').first()).toBeVisible({ timeout: 15_000 })
    await expect(wideLines.locator('.diff-line').first()).toBeVisible({ timeout: 15_000 })

    const measurements = await Promise.all(
      [shortLines, wideLines].map((lines) =>
        lines.evaluate((el) => ({
          overflowX: getComputedStyle(el).overflowX,
          rowOverflows: [...el.querySelectorAll<HTMLElement>('.diff-line')].some(
            (row) => row.scrollWidth - el.clientWidth > 2
          )
        }))
      )
    )

    await page.screenshot({ path: join(artifactsDir, 'bug-diff-inner-scrollbar.png') })
    expect(readFileSync(join(userDataDir, 'logs', 'main.log'), 'utf8')).toContain('diff:panel:trace')

    expect(measurements).toEqual([
      { overflowX: 'hidden', rowOverflows: false },
      { overflowX: 'auto', rowOverflows: true }
    ])
    await wideLines.evaluate((el) => {
      el.scrollLeft = el.scrollWidth
    })
    expect(await wideLines.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  } finally {
    await app?.close().catch(() => undefined)
  }
})
