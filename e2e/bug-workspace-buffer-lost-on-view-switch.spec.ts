import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

/** Files/Diff panels live in a keep-alive layer; these are the DOM proofs of "still mounted". */
const FILES_PANE = '[data-tab="files"]'
const DIFF_PANE = '[data-tab="diff"]'

let electronApp: ElectronApplication
let page: Page
let repoDir: string
let sessionId: string
let secondSessionId: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** Real throwaway repo with one committed file and one uncommitted edit, so Diff has a real row. */
function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e2e-buffer-repo-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'e2e@example.com'])
  git(dir, ['config', 'user.name', 'E2E Test'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# buffer fixture\n')
  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\nfunction hello() {\n  return 'hi'\n}\n")
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'Initial commit'])
  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\nfunction hello() {\n  return 'hello world'\n}\n")
  return dir
}

function seedVault(): string {
  const vaultRoot = join(mkdtempSync(join(tmpdir(), 'atelier-e2e-buffer-vault-')), 'vault')
  const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
  mkdirSync(noteDir, { recursive: true })
  writeFileSync(
    join(noteDir, `${TEST_DATE}.md`),
    `---\ndate: ${TEST_DATE}\nday: Friday\ntype: daily\n---\n\n## 📋 Tasks\n\n### ⚪ Backlog\n\n## 📝 Notes\n\nSeed body.\n`,
    'utf-8'
  )
  return vaultRoot
}

/** Writes a phase marker through the real preload bridge into the real main-process log file. */
async function logPhase(marker: string, extra: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ({ msg, data }) => window.atelier.log('info', msg, data),
    { msg: `e2e-buffer-probe ${marker}`, data: extra }
  )
}

/** Counts the mounted (not necessarily visible) Files/Diff panes for the whole app. */
async function mountedPaneCounts(): Promise<{ files: number; diff: number }> {
  return {
    files: await page.locator(FILES_PANE).count(),
    diff: await page.locator(DIFF_PANE).count()
  }
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
  // Mode first: once the path is in history the picker popover renders over the mode row.
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

/** Opens src/index.js in the Files tab and returns once it is the active editor tab. */
async function openIndexJsInFilesTab(): Promise<void> {
  await page.getByTestId('tab-files').click()
  const files = page.getByTestId('files-panel-active')
  await expect(files.getByTestId('files-tree')).toContainText('src', { timeout: 20_000 })
  const indexJs = files.locator('[data-testid="file-tree-file"][data-path="src/index.js"]')
  if (!(await indexJs.isVisible())) {
    await files.locator('[data-testid="file-tree-dir"][data-path="src"]').click()
  }
  await indexJs.click()
  await expect(files.locator('[data-testid="files-editor-tab"][data-path="src/index.js"]')).toHaveClass(/active/, {
    timeout: 20_000
  })
}

/** The buffer assertion: the previously-opened editor tab is still there, still active. */
async function expectFileBufferIntact(): Promise<void> {
  await page.getByTestId('tab-files').click()
  const files = page.getByTestId('files-panel-active')
  await expect(files.getByTestId('files-editor-tab')).toHaveCount(1, { timeout: 20_000 })
  await expect(files.locator('[data-testid="files-editor-tab"][data-path="src/index.js"]')).toHaveClass(/active/)
}

async function selectSessionRow(id: string): Promise<void> {
  await page.locator(`[data-testid="session-row"][data-session-id="${id}"]`).click()
  await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 30_000 })
}

test.describe.configure({ mode: 'serial' })

test.describe('bug: Files/Diff buffer lost when switching between a session and terminal/notes', () => {
  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-buffer-userdata-'))
    seedE2eConfig(userDataDir)
    repoDir = buildFixtureRepo()
    mkdirSync(artifactsDir, { recursive: true })

    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: join(__dirname, '..'),
      env: { ...process.env, ATELIER_TEST_VAULT_ROOT: seedVault(), ATELIER_TEST_DATE: TEST_DATE }
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    await electronApp?.close().catch(() => undefined)
  })

  test('setup: open a file buffer in the Files tab of a real claude-code session', async () => {
    test.setTimeout(180_000)
    sessionId = await createClaudeCodeSession(repoDir)
    expect(sessionId).toBeTruthy()
    await openIndexJsInFilesTab()

    const counts = await mountedPaneCounts()
    await logPhase('session-foreground', { sessionId, ...counts })
    expect(counts.files).toBeGreaterThan(0)
    expect(counts.diff).toBeGreaterThan(0)
  })

  test('control: buffer survives a session → session switch (behavior being matched)', async () => {
    test.setTimeout(180_000)
    secondSessionId = await createClaudeCodeSession(repoDir)
    expect(secondSessionId).not.toBe(sessionId)

    // A freshly created session is 'connecting', which must not tear down the
    // buffered panels belonging to every other session.
    const whileConnecting = await mountedPaneCounts()
    await logPhase('second-session-connecting', whileConnecting)
    await page.screenshot({ path: join(artifactsDir, 'bug-workspace-buffer-second-session-connecting.png') })
    expect(whileConnecting.files).toBeGreaterThan(0)

    await selectSessionRow(sessionId)
    await logPhase('after-session-switch', await mountedPaneCounts())
    await expectFileBufferIntact()
  })

  test('Daily note: workspace panels stay mounted and the file buffer survives the round trip', async () => {
    test.setTimeout(120_000)

    await page.getByTestId('daily-note-row').click()
    await expect(page.getByTestId('daily-note-editor-panel')).toBeVisible({ timeout: 20_000 })

    const duringNote = await mountedPaneCounts()
    await logPhase('daily-note-foreground', duringNote)
    await page.screenshot({ path: join(artifactsDir, 'bug-workspace-buffer-daily-note-foreground.png') })

    // Panels must be buffered (mounted but inert) rather than torn down.
    expect(duringNote.files).toBeGreaterThan(0)
    expect(duringNote.diff).toBeGreaterThan(0)
    await expect(page.getByTestId('files-panel-active')).toHaveCount(0)
    await expect(page.locator('.panel-cache-entry.active')).toHaveCount(0)

    // The buffered layer must not swallow clicks meant for the note editor.
    const editor = page.getByTestId('daily-note-editor')
    await editor.click()
    await page.keyboard.type('buffer-probe-daily-note')
    await expect(editor.getByText('buffer-probe-daily-note')).toBeVisible({ timeout: 10_000 })

    await selectSessionRow(sessionId)
    await expectFileBufferIntact()
    await page.screenshot({ path: join(artifactsDir, 'bug-workspace-buffer-restored-after-daily-note.png') })
    await logPhase('back-from-daily-note', await mountedPaneCounts())
  })

  test('App note: workspace panels stay mounted and the file buffer survives the round trip', async () => {
    test.setTimeout(120_000)

    await page.getByTestId('new-app-note-button').click()
    await expect(page.getByTestId('app-notes-panel')).toBeVisible({ timeout: 20_000 })

    const duringNote = await mountedPaneCounts()
    await logPhase('app-note-foreground', duringNote)
    expect(duringNote.files).toBeGreaterThan(0)
    await expect(page.locator('.panel-cache-entry.active')).toHaveCount(0)

    await selectSessionRow(sessionId)
    await expectFileBufferIntact()
    await logPhase('back-from-app-note', await mountedPaneCounts())
  })

  test('Terminal session: workspace panels stay mounted and the file buffer survives the round trip', async () => {
    test.setTimeout(120_000)

    await page.getByTestId('open-local-terminal-button').click()
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 20_000 })

    const duringTerminal = await mountedPaneCounts()
    await logPhase('terminal-foreground', duringTerminal)
    await page.screenshot({ path: join(artifactsDir, 'bug-workspace-buffer-terminal-foreground.png') })
    expect(duringTerminal.files).toBeGreaterThan(0)
    expect(duringTerminal.diff).toBeGreaterThan(0)

    // The terminal keeps its own keep-alive entry; the workspace layer must stay inert.
    await expect(page.locator('.terminal-cache-entry.active')).toHaveCount(1)
    await expect(page.locator('.panel-cache-entry.active')).toHaveCount(0)

    await selectSessionRow(sessionId)
    await expectFileBufferIntact()
    await page.screenshot({ path: join(artifactsDir, 'bug-workspace-buffer-restored-after-terminal.png') })
    await logPhase('back-from-terminal', await mountedPaneCounts())
  })

  test('Diff tab selection survives a Daily note round trip', async () => {
    test.setTimeout(120_000)

    await page.getByTestId('tab-diff').click()
    const diff = page.getByTestId('diff-panel-active')
    const indexRow = diff.getByTestId('diff-file-row').filter({ hasText: 'index.js' })
    await expect(indexRow).toBeVisible({ timeout: 30_000 })
    await indexRow.click()
    await expect(indexRow).toHaveClass(/active/, { timeout: 15_000 })

    await page.getByTestId('daily-note-row').click()
    await expect(page.getByTestId('daily-note-editor-panel')).toBeVisible({ timeout: 20_000 })

    await selectSessionRow(sessionId)
    await page.getByTestId('tab-diff').click()
    await expect(
      page.getByTestId('diff-panel-active').getByTestId('diff-file-row').filter({ hasText: 'index.js' })
    ).toHaveClass(/active/, { timeout: 20_000 })
    await page.screenshot({ path: join(artifactsDir, 'bug-workspace-buffer-diff-restored.png') })
  })

  test('main-process log file records the buffered panel counts for every phase', async () => {
    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    const contents = readFileSync(logPath, 'utf-8')
    const phases = contents
      .split('\n')
      .filter((line) => line.includes('e2e-buffer-probe'))
      .join('\n')

    for (const marker of ['daily-note-foreground', 'app-note-foreground', 'terminal-foreground']) {
      expect(phases).toContain(marker)
    }
    // Every non-session foreground phase logged a non-zero mounted pane count.
    for (const line of phases.split('\n').filter((l) => /foreground|back-from/.test(l))) {
      expect(line).not.toMatch(/"files":\s*0\b/)
    }
  })
})
