import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')
const CHANGED_FILE_COUNT = 12
const PRELOAD_LIMIT = 10

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-diff-preload-limit-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir })
  for (let index = 1; index <= CHANGED_FILE_COUNT; index++) {
    const suffix = String(index).padStart(2, '0')
    writeFileSync(join(dir, `changed-${suffix}.txt`), `before ${suffix}\n`)
  }
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir })
  for (let index = 1; index <= CHANGED_FILE_COUNT; index++) {
    const suffix = String(index).padStart(2, '0')
    writeFileSync(join(dir, `changed-${suffix}.txt`), `before ${suffix}\nafter ${suffix}\n`)
  }
  return dir
}

test('workspace preload hydrates at most ten changed files and lazy-loads the rest', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-diff-preload-limit-profile-'))
  mkdirSync(userDataDir, { recursive: true })
  seedSkipOnboarding(userDataDir)
  const repoDir = fixtureRepo()
  mkdirSync(artifactsDir, { recursive: true })

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot
  })
  const page = await app.firstWindow()
  try {
    await page.waitForLoadState('domcontentloaded')
    const session = await page.evaluate((projectPath) =>
      window.atelier.createSession({
        projectPath,
        mode: 'claude-code',
        hostId: 'local',
        suggestedName: 'Diff preload limit',
        initialPrompt: 'Reply with exactly READY and do not use tools.'
      }), repoDir)

    await expect
      .poll(
        () =>
          page.evaluate(async ({ sessionId, expectedCount }) => {
            const snapshot = await window.atelier.getSessionWorkspaceSnapshot(sessionId)
            if (snapshot?.diff.files.length !== expectedCount) return null
            return snapshot.diff.files.filter((file) => file.hunks.length > 0).length
          }, { sessionId: session.id, expectedCount: CHANGED_FILE_COUNT }),
        { timeout: 60_000 }
      )
      .not.toBeNull()

    const snapshot = await page.evaluate(
      (sessionId) => window.atelier.getSessionWorkspaceSnapshot(sessionId),
      session.id
    )
    expect(snapshot?.diff.files).toHaveLength(CHANGED_FILE_COUNT)
    const hydrated = snapshot!.diff.files.filter((file) => file.hunks.length > 0)

    const row = page.locator(`[data-testid="session-row"][data-session-id="${session.id}"]`)
    await row.click()
    await page.getByTestId('tab-diff').click()
    await expect(page.getByTestId('diff-file-summary')).toContainText('12 files changed')
    await page.screenshot({
      path: join(artifactsDir, 'bug-diff-preload-limit-before.png')
    })

    expect(hydrated).toHaveLength(PRELOAD_LIMIT)
    expect(snapshot!.diff.files[PRELOAD_LIMIT]!.hunks).toHaveLength(0)

    const lazyPath = snapshot!.diff.files[PRELOAD_LIMIT]!.path
    expect(lazyPath).toBe('changed-11.txt')
    await page.locator(`[data-testid="diff-file-row"][data-path="${lazyPath}"]`).click()
    await expect(page.getByTestId('diff-file-card')).toContainText('after 11')

    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    await expect.poll(() => readFileSync(logPath, 'utf8')).toContain(
      '"msg":"workspace preload: diff hunks capped"'
    )
    await page.screenshot({
      path: join(artifactsDir, 'bug-diff-preload-limit-after.png')
    })
  } finally {
    await app.close()
  }
})
