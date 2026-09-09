import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * session-ready-hint: a newly created session says when it is actually usable.
 * While the harness comes up the existing connecting gate holds the session;
 * the moment it lifts, an empty transcript shows the ready hint instead of a
 * blank pane, and a session that became ready while the user was elsewhere
 * announces itself with a toast.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

let electronApp: ElectronApplication
let page: Page
let userDataDir: string
let repoDir: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e2e-ready-hint-repo-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'e2e@example.com'])
  git(dir, ['config', 'user.name', 'E2E Test'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# ready hint fixture\n')
  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\n")
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'Initial commit'])
  return dir
}

async function sidebarSessionIds(): Promise<string[]> {
  return page.locator('[data-testid="session-row"]').evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-session-id') ?? '')
  )
}

/** Creates a session with no initial prompt, so its transcript stays empty. */
async function createEmptyClaudeSession(): Promise<string> {
  const before = new Set(await sidebarSessionIds())
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
  await page.getByTestId('mode-claude-code').click()
  await page.getByTestId('project-path').fill(repoDir)
  await page.getByTestId('project-path').blur()
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
  return created
}

test.describe.configure({ mode: 'serial' })

test.describe('session-ready-hint', () => {
  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-ready-hint-'))
    seedE2eConfig(userDataDir)
    repoDir = buildFixtureRepo()
    mkdirSync(artifactsDir, { recursive: true })
    electronApp = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp?.close().catch(() => undefined)
  })

  test('a new session shows the ready hint once it is connected, and focuses the composer', async () => {
    test.setTimeout(180_000)
    const sessionId = await createEmptyClaudeSession()

    // The connecting gate holds the session first — no tab strip, no composer.
    await expect(page.getByTestId('session-connecting-state')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('tab-strip')).toHaveCount(0)
    await expect(page.getByTestId('session-ready-hint')).toHaveCount(0)
    await page.screenshot({ path: join(artifactsDir, 'session-ready-hint-connecting.png') })

    // Gate lifts → the empty transcript carries the hint rather than nothing at all.
    await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 90_000 })
    const hint = page.getByTestId('session-ready-hint')
    await expect(hint).toBeVisible({ timeout: 30_000 })
    await expect(hint).toContainText('Ready to chat')
    await expect(hint).toContainText(repoDir.split('/').filter(Boolean).pop() as string)
    await expect(
      page.locator('.composer-cache-entry.active').getByTestId('composer-input')
    ).toBeFocused()
    await page.screenshot({ path: join(artifactsDir, 'session-ready-hint-ready.png') })

    // The hint is an empty-transcript state: a real message replaces it.
    await page.getByTestId('composer-input').fill('Reply with exactly the single word: PING')
    await page.getByTestId('send-button').click()
    await expect(page.getByTestId('session-ready-hint')).toHaveCount(0, { timeout: 30_000 })
    expect(sessionId).toBeTruthy()
  })

  test('a session that becomes ready in the background announces itself with a toast', async () => {
    test.setTimeout(180_000)
    const firstId = (await sidebarSessionIds())[0]
    await createEmptyClaudeSession()

    // Navigate away while the new session is still connecting.
    await page.locator(`[data-testid="session-row"][data-session-id="${firstId}"]`).click()

    const toast = page.getByTestId('app-toast')
    await expect(toast).toBeVisible({ timeout: 90_000 })
    await expect(toast).toContainText('Session ready to chat')
    await page.screenshot({ path: join(artifactsDir, 'session-ready-hint-background-toast.png') })

    // Transient, not a permanent banner.
    await expect(toast).toHaveCount(0, { timeout: 15_000 })
  })
})
