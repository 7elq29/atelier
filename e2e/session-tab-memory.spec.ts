import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * remember-session-tab: each session remembers the workspace tab it was left
 * on, so switching sessions — or relaunching the app — returns to Files/Diff/
 * Terminal instead of snapping every session back to Chat.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

let electronApp: ElectronApplication
let page: Page
let userDataDir: string
let repoDir: string
let sessionA: string
let sessionB: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e2e-tab-memory-repo-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'e2e@example.com'])
  git(dir, ['config', 'user.name', 'E2E Test'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# tab memory fixture\n')
  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\nfunction hello() {\n  return 'hi'\n}\n")
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'Initial commit'])
  return dir
}

async function launchApp(): Promise<void> {
  electronApp = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
}

async function sidebarSessionIds(): Promise<string[]> {
  return page.locator('[data-testid="session-row"]').evaluateAll((rows) =>
    rows.map((r) => r.getAttribute('data-session-id') ?? '')
  )
}

async function createClaudeCodeSession(): Promise<string> {
  const before = new Set(await sidebarSessionIds())

  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
  await page.getByTestId('mode-claude-code').click()
  await page.getByTestId('project-path').fill(repoDir)
  // The path autocomplete popover renders over the mode row and start button.
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

  await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 90_000 })
  return created
}

async function selectSessionRow(id: string): Promise<void> {
  await page.locator(`[data-testid="session-row"][data-session-id="${id}"]`).click()
  await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 90_000 })
}

/**
 * Both the selected tab button and the pane that tab owns, since the Files and
 * Terminal panels stay mounted for every session and only the showing one
 * carries its `active` test id.
 */
async function expectActiveTab(tab: 'chat' | 'files' | 'terminal'): Promise<void> {
  await expect(page.getByTestId(`tab-${tab}`)).toHaveClass(/active/, { timeout: 20_000 })
  if (tab === 'files') {
    await expect(page.getByTestId('files-panel-active')).toBeVisible({ timeout: 20_000 })
    return
  }
  if (tab === 'terminal') {
    await expect(page.getByTestId('terminal-body')).toBeVisible({ timeout: 20_000 })
    return
  }
  await expect(
    page.getByTestId('session-workspace-tabs').locator('.tab-content[data-tab="chat"]')
  ).not.toHaveClass(/hidden/)
}

test.describe.configure({ mode: 'serial' })

test.describe('remember-session-tab', () => {
  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-tab-memory-'))
    seedE2eConfig(userDataDir)
    repoDir = buildFixtureRepo()
    mkdirSync(artifactsDir, { recursive: true })
    await launchApp()
  })

  test.afterAll(async () => {
    await electronApp?.close().catch(() => undefined)
  })

  test('setup: two real claude-code sessions on the fixture repo', async () => {
    test.setTimeout(180_000)
    sessionA = await createClaudeCodeSession()
    sessionB = await createClaudeCodeSession()
    expect(sessionA).toBeTruthy()
    expect(sessionB).not.toBe(sessionA)
  })

  test('a session switch restores each session to the tab it was left on', async () => {
    test.setTimeout(180_000)

    await selectSessionRow(sessionA)
    await page.getByTestId('tab-files').click()
    await expectActiveTab('files')

    // B has never been moved off its default tab, so it must not inherit A's.
    await selectSessionRow(sessionB)
    await expectActiveTab('chat')
    await page.getByTestId('tab-terminal').click()
    await expectActiveTab('terminal')

    await selectSessionRow(sessionA)
    await expectActiveTab('files')
    await page.screenshot({ path: join(artifactsDir, 'remember-session-tab-after-switch.png') })

    await selectSessionRow(sessionB)
    await expectActiveTab('terminal')
  })

  test('the remembered tab is persisted in SQLite, not just renderer state', async () => {
    const rows = await page.evaluate(
      ({ a, b }) =>
        window.atelier.debugQueryDb<{ id: string; active_tab: string }>(
          'SELECT id, active_tab FROM sessions WHERE id IN (?, ?)',
          [a, b]
        ),
      { a: sessionA, b: sessionB }
    )
    expect(rows.find((r) => r.id === sessionA)?.active_tab).toBe('files')
    expect(rows.find((r) => r.id === sessionB)?.active_tab).toBe('terminal')
  })

  test('the remembered tab survives a real app relaunch', async () => {
    test.setTimeout(180_000)
    await electronApp.close()
    await launchApp()

    await selectSessionRow(sessionA)
    await expectActiveTab('files')
    await page.screenshot({ path: join(artifactsDir, 'remember-session-tab-after-relaunch.png') })

    await selectSessionRow(sessionB)
    await expectActiveTab('terminal')
  })
})
