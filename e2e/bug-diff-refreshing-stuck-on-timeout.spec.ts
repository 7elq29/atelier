import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e2e-refresh-timeout-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'e2e@example.com'])
  git(dir, ['config', 'user.name', 'E2E Test'])
  writeFileSync(join(dir, 'README.md'), '# fixture\n')
  writeFileSync(join(dir, 'src.js'), "console.log('hi')\n")
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'])
  writeFileSync(join(dir, 'src.js'), "console.log('changed')\n")
  return dir
}

test('diff refreshing banner clears after workspace refresh times out', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-refresh-timeout-'))
  mkdirSync(userDataDir, { recursive: true })
  seedSkipOnboarding(userDataDir)
  const repoDir = buildFixtureRepo()

  const app = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      // Force the refresh race to time out before git can finish.
      ATELIER_REFRESH_WORKSPACE_TIMEOUT_MS: '1'
    }
  })
  const page = await app.firstWindow()
  try {
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(repoDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string

    await page.getByTestId('tab-diff').click()
    await expect(page.getByTestId('diff-panel-active')).toBeVisible({ timeout: 30_000 })

    await page.evaluate((id) => window.atelier.refreshSessionWorkspace(id, true), sessionId)
    // A forced refresh shows the banner, then must clear even when the refresh times out.
    await expect(page.getByTestId('diff-refreshing')).toHaveCount(0, { timeout: 10_000 })
  } finally {
    await app.close().catch(() => undefined)
  }
})
