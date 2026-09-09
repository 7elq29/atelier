import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')
const CHANGED_FILE_COUNT = 12
const PRELOAD_LIMIT = 10
const LARGE_UNTRACKED_FILE_COUNT = 30_000

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

function largeUntrackedFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-input-stall-large-diff-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir })
  writeFileSync(join(dir, 'tracked.txt'), 'fixture\n')
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir })
  const untrackedDir = join(dir, 'generated')
  mkdirSync(untrackedDir)
  for (let index = 0; index < LARGE_UNTRACKED_FILE_COUNT; index++) {
    writeFileSync(join(untrackedDir, `${String(index).padStart(5, '0')}.txt`), '')
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

test('chat input stays responsive when a large cached diff refreshes', async () => {
  test.setTimeout(180_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-input-stall-large-diff-profile-'))
  mkdirSync(userDataDir, { recursive: true })
  seedSkipOnboarding(userDataDir)
  const repoDir = largeUntrackedFixtureRepo()
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
        suggestedName: 'Large diff input responsiveness',
        initialPrompt: 'Reply with exactly READY and do not use tools.'
      }), repoDir)

    await expect
      .poll(
        () =>
          page.evaluate(async ({ sessionId, expectedCount }) => {
            const snapshot = await window.atelier.getSessionWorkspaceSnapshot(sessionId)
            return snapshot?.diff.files.length === expectedCount
          }, { sessionId: session.id, expectedCount: LARGE_UNTRACKED_FILE_COUNT }),
        { timeout: 60_000 }
      )
      .toBe(true)

    const row = page.locator(`[data-testid="session-row"][data-session-id="${session.id}"]`)
    await row.click()
    const composer = page.getByTestId('composer-input')
    await composer.click()
    await page.waitForTimeout(2_000)

    const marker = 'input-remains-responsive-through-large-workspace-refresh'
    const baselineAt = Date.now()
    await page.keyboard.type(marker, { delay: 5 })
    const baselineTypingMs = Date.now() - baselineAt
    await composer.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await composer.press('Backspace')

    // Start a real workspace refresh during typing. Before the fix, merging
    // and reconciling 30k paths blocks Electron's event routing long enough
    // for the remaining keystrokes to queue.
    await page.evaluate((sessionId) => {
      setTimeout(() => {
        void window.atelier.refreshSessionWorkspace(sessionId, false)
      }, 100)
    }, session.id)
    const typedAt = Date.now()
    await page.keyboard.type(marker, { delay: 5 })
    const typingMs = Date.now() - typedAt

    await expect(composer).toHaveValue(marker)
    const snapshot = await page.evaluate(
      (sessionId) => window.atelier.getSessionWorkspaceSnapshot(sessionId),
      session.id
    )
    expect(snapshot?.diff.files).toHaveLength(LARGE_UNTRACKED_FILE_COUNT)
    await page.screenshot({
      path: join(artifactsDir, 'bug-input-stall-large-diff-after.png')
    })
    expect(typingMs - baselineTypingMs).toBeLessThan(1_000)
  } finally {
    await app.close()
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
})
