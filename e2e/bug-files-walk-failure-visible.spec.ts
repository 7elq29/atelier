import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

/** Reserved TLD — `ssh` really cannot resolve this, so it really exits 255. No mocks. */
const UNREACHABLE_HOST = 'atelier-e2e-unreachable.invalid'

let electronApp: ElectronApplication
let page: Page
let repoDir: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e2e-walkfail-repo-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'e2e@example.com'])
  git(dir, ['config', 'user.name', 'E2E Test'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# walk failure fixture\n')
  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\n")
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'Initial commit'])
  return dir
}

/** Resolves to 'resolved:<n>' when the walk wrongly reports success, or 'rejected' when it errors. */
async function probeFilesTree(path: string, hostname: string | null): Promise<string> {
  return page.evaluate(
    async ({ p, h }) => {
      try {
        const nodes = await window.atelier.filesTree(p, h)
        return `resolved:${nodes.length}`
      } catch {
        return 'rejected'
      }
    },
    { p: path, h: hostname }
  )
}

async function probeFilesList(path: string, hostname: string | null): Promise<string> {
  return page.evaluate(
    async ({ p, h }) => {
      try {
        const entries = await window.atelier.filesList(p, null, h)
        return `resolved:${entries.length}`
      } catch {
        return 'rejected'
      }
    },
    { p: path, h: hostname }
  )
}

async function sidebarSessionIds(): Promise<string[]> {
  return page.locator('[data-testid="session-row"]').evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-session-id') ?? '')
  )
}

async function createClaudeCodeSession(projectPath: string): Promise<string> {
  const before = new Set(await sidebarSessionIds())

  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
  await page.getByTestId('mode-claude-code').click()
  await page.getByTestId('project-path').fill(projectPath)
  await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
  await page.getByTestId('start-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

  let created = ''
  await expect
    .poll(
      async () => {
        created = (await sidebarSessionIds()).find((id) => id && !before.has(id)) ?? ''
        return created
      },
      { timeout: 30_000 }
    )
    .not.toBe('')

  await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 90_000 })
  return created
}

test.describe.configure({ mode: 'serial' })

/**
 * A files walk that could not run must not be reported as an empty workspace.
 * Regression for `vibe dashboard`: a ~10s devpod SSH outage during session open
 * made walkRemote() return [], which was cached as "this worktree has no files"
 * for the whole life of the session, with no error and no way to retry.
 * See Features/files-walk-failure-visible/spec.md.
 */
test.describe('bug: failed files walk must surface an error, not an empty tree', () => {
  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-walkfail-userdata-'))
    seedE2eConfig(userDataDir)
    repoDir = buildFixtureRepo()
    mkdirSync(artifactsDir, { recursive: true })

    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: join(__dirname, '..')
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp?.close().catch(() => undefined)
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('remote walk over a real failing ssh rejects instead of returning an empty tree', async () => {
    test.setTimeout(120_000)

    // Real `ssh` to an unresolvable host: exit 255, nothing learned about the dir.
    expect(await probeFilesTree('/tmp', UNREACHABLE_HOST)).toBe('rejected')
    expect(await probeFilesList('/tmp', UNREACHABLE_HOST)).toBe('rejected')
  })

  test('local walk of a missing directory rejects instead of returning an empty tree', async () => {
    const goneDir = join(tmpdir(), `atelier-e2e-walkfail-missing-${Date.now()}`)
    expect(await probeFilesTree(goneDir, null)).toBe('rejected')
    expect(await probeFilesList(goneDir, null)).toBe('rejected')

    // An existing, readable directory still walks normally.
    expect(await probeFilesTree(repoDir, null)).toBe('resolved:2')
  })

  test('Files panel shows an error with Retry, and Retry recovers once the root is back', async () => {
    test.setTimeout(240_000)

    const sessionId = await createClaudeCodeSession(repoDir)
    expect(sessionId).toBeTruthy()

    await page.getByTestId('tab-files').click()
    const files = page.getByTestId('files-panel-active')
    await expect(files.getByTestId('files-dir-listing')).toContainText('README.md', { timeout: 30_000 })

    // The workspace root disappears out from under the session (devpod asleep,
    // directory deleted) and the panel is asked to re-read it.
    rmSync(repoDir, { recursive: true, force: true })
    await files.getByTestId('files-tree-refresh').click()

    await expect(files.getByTestId('files-tree-error')).toBeVisible({ timeout: 30_000 })
    await expect(files.getByTestId('files-tree-error')).toContainText('Could not load files')
    await expect(files.getByTestId('files-tree-error-detail')).not.toBeEmpty()
    await expect(files.getByTestId('files-tree-retry')).toBeVisible()
    // The old silent behaviour: an empty tree presented as a real answer.
    await expect(files.getByTestId('files-tree-empty')).toHaveCount(0)
    await page.screenshot({ path: join(artifactsDir, '07-files-walk-failed-retry.png') })

    // Root comes back; Retry must recover without reopening the session.
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(repoDir, 'RECOVERED.md'), '# back\n')
    await files.getByTestId('files-tree-retry').click()
    await expect(files.getByTestId('files-dir-listing')).toContainText('RECOVERED.md', { timeout: 30_000 })
    await expect(files.getByTestId('files-tree-error')).toHaveCount(0)
    await expect(files.getByTestId('files-tree-refresh')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '07-files-walk-recovered.png') })
  })

  test('main-process log records the failed walks with their exit codes', async () => {
    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    const contents = readFileSync(logPath, 'utf-8')

    const remoteFailures = contents
      .split('\n')
      .filter((l) => l.includes('files:tree:remote:failed') && l.includes(UNREACHABLE_HOST))
    expect(remoteFailures.length).toBeGreaterThan(0)
    expect(remoteFailures.join('\n')).toContain('"code":255')

    expect(contents).toContain('files:tree:failed')
  })
})
