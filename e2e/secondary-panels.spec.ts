import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { commentOnReviewSelection, e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding, selectReviewPaneText } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const panelsLogPath = join(artifactsDir, '07-panels.log')

mkdirSync(artifactsDir, { recursive: true })
writeFileSync(panelsLogPath, '')

function log(line: string): void {
  writeFileSync(panelsLogPath, `${line}\n`, { flag: 'a' })
}

async function approveAllPendingPermissions(page: Page): Promise<void> {
  const cards = page.getByTestId('permission-card')
  const count = await cards.count().catch(() => 0)
  for (let i = 0; i < count; i++) {
    await cards
      .nth(i)
      .getByTestId('perm-allow')
      .click({ timeout: 500 })
      .catch(() => undefined)
  }
}

/** Turn is idle when the Stop control is gone (Send stays visible but shows Queue while busy). */
async function ensureAcceptEditsMode(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.atelier.cycleSessionMode(id)
    await window.atelier.cycleSessionMode(id)
  }, sessionId)
  await expect(page.getByTestId('composer-mode-pill')).toHaveAttribute('data-mode', 'acceptEdits', { timeout: 10_000 })
}

async function editFileOnce(
  page: Page,
  sessionId: string,
  absolutePath: string,
  oldString: string,
  newString: string
): Promise<void> {
  await page.getByTestId('composer-input').fill(
    `First use the Read tool once on ${JSON.stringify(absolutePath)}. ` +
      `Then use the Edit tool exactly once on the same file with old_string exactly ${JSON.stringify(oldString)} ` +
      `and new_string exactly ${JSON.stringify(newString)}. ` +
      'Then reply with exactly the word DONE. Use exactly those two tool calls in that order and no others.'
  )
  await page.getByTestId('send-button').click()
  await waitForTurnIdle(page, 90_000)
}

async function expandCap(page: Page): Promise<void> {
  const cap = page.getByTestId('chat-uncommitted-changes')
  const toggle = cap.locator('.chat-changes-toggle')
  if ((await toggle.getAttribute('aria-expanded')) === 'false') {
    await toggle.click()
  }
}

async function collapseCap(page: Page): Promise<void> {
  const cap = page.getByTestId('chat-uncommitted-changes')
  if ((await cap.count()) === 0) return
  const toggle = cap.locator('.chat-changes-toggle')
  if ((await toggle.getAttribute('aria-expanded')) === 'true') {
    await toggle.click()
  }
}

async function waitForTurnIdle(page: Page, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await page.getByTestId('stop-button').isVisible().catch(() => false))) return
    await approveAllPendingPermissions(page)
    await page.waitForTimeout(300)
  }
  await expect(page.getByTestId('stop-button')).toHaveCount(0, { timeout: 1_000 })
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}


function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

/** Real throwaway git fixture repo: two commits, then an uncommitted change, for a real diff/commit/worktree round-trip. */
function buildFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-e2e-panels-repo-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'e2e@example.com'])
  git(dir, ['config', 'user.name', 'E2E Test'])
  writeFileSync(join(dir, 'README.md'), '# fixture repo\n')
  writeFileSync(join(dir, '.gitignore'), '.claude/\n')
  mkdirSync(join(dir, 'config'), { recursive: true })
  writeFileSync(join(dir, 'config', 'example.star'), 'version = 1\n')
  mkdirSync(join(dir, 'nested', 'session'), { recursive: true })
  writeFileSync(join(dir, 'nested', 'session', '.gitkeep'), '')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\nfunction hello() {\n  return 'hi'\n}\n")
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'Initial commit'])

  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\nfunction hello() {\n  return 'hello world'\n}\n")
  writeFileSync(join(dir, 'config', 'example.star'), 'version = 1\nversion = 2\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'Change greeting (see https://example.com/atelier-e2e-external-link-check)'])

  writeFileSync(join(dir, 'src', 'index.js'), "// entrypoint\nfunction hello() {\n  return 'hello world!'\n}\n\nmodule.exports = { hello }\n")
  writeFileSync(join(dir, 'repo-wide-change.js'), "// changed outside nested session cwd\n")

  // Deep single-child chain — exercises the Diff tree's GitHub-style path compression.
  mkdirSync(join(dir, 'deep', 'nested', 'chain'), { recursive: true })
  writeFileSync(join(dir, 'deep', 'nested', 'chain', 'leaf.js'), '// deep leaf\n')

  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(dir, ['add', 'a.txt'])
  git(dir, ['commit', '-q', '-m', 'Add a.txt for session cap e2e'])

  // A real image (tiny 1x1 PNG) and a real HTML file for the Files-panel preview tests.
  const onePxPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  )
  writeFileSync(join(dir, 'logo.png'), onePxPng)
  writeFileSync(join(dir, 'page.html'), '<html><body><h1>Fixture page</h1><a href="https://example.com">a link</a></body></html>')

  const sessionDir = join(dir, 'nested', 'session')
  symlinkSync(join(dir, 'src'), join(sessionDir, 'src'), 'dir')
  symlinkSync(join(dir, 'logo.png'), join(sessionDir, 'logo.png'))
  symlinkSync(join(dir, 'page.html'), join(sessionDir, 'page.html'))

  return dir
}

function connectTcp(port: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout waiting for forwarded port data'))
    }, timeoutMs)
    socket.once('data', (chunk) => {
      clearTimeout(timer)
      socket.end()
      resolve(chunk)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

test.describe.configure({ mode: 'serial' })

test.describe('07-secondary-panels', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let repoDir: string
  /** Nested inside the fixture repo — matches monorepo sessions whose cwd ≠ git toplevel. */
  let sessionProjectPath: string
  let sessionId: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-panels-'))
    seedSkipOnboarding(userDataDir)
    repoDir = buildFixtureRepo()
    sessionProjectPath = join(repoDir, 'nested', 'session')
    log(`fixture repo created at ${repoDir} (session cwd ${sessionProjectPath})`)
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── Setup: a real local claude-code session on the fixture repo ────────
  test('setup: create a claude-code session on the fixture repo', async () => {
        await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('project-path').fill(sessionProjectPath)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: PING')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect(page.getByTestId('tab-strip')).toBeVisible()
  })

  test('session detail: changing project path reloads diff and terminal cwd', async () => {
    const altProjectPath = mkdtempSync(join(tmpdir(), 'atelier-e2e-path-change-'))
    writeFileSync(join(altProjectPath, 'marker.txt'), 'relocated\n')

    const row = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await row.getByTestId('session-menu-button').click()
    await page.getByTestId('menu-details').click()
    const popover = row.getByTestId('session-detail-popover')
    await expect(popover).toBeVisible()
    await popover.getByTestId('session-project-path').fill(altProjectPath)
    await popover.getByTestId('apply-project-path-button').click()

    await expect
      .poll(async () => {
        const rows = await page.evaluate(
          ({ id }) =>
            window.atelier.debugQueryDb<{ project_path: string }>(
              'SELECT project_path FROM sessions WHERE id = ?',
              [id]
            ),
          { id: sessionId }
        )
        return rows[0]?.project_path
      })
      .toBe(altProjectPath)

    await expect
      .poll(async () => {
        const snap = await page.evaluate((id) => window.atelier.getSessionWorkspaceSnapshot(id), sessionId)
        return snap?.workspacePath ?? null
      }, { timeout: 15_000 })
      .toBe(altProjectPath)

    await page.getByTestId('tab-diff').click()
    await expect(page.getByTestId('diff-empty-not-repo')).toBeVisible({ timeout: 15_000 })

    await page.getByTestId('tab-terminal').click()
    const altBasename = altProjectPath.split('/').filter(Boolean).pop() ?? altProjectPath
    await expect(page.getByTestId('terminal-cwd-chip')).toContainText(altBasename, { timeout: 15_000 })

    await page.screenshot({ path: join(artifactsDir, '07-session-project-path-reload.png') })
    log(`project path changed to ${altProjectPath}`)

    // Every later test in this serial file drives the fixture repo through this session. Leaving it
    // pointed at a throwaway non-repo directory makes all of them fail on state this test created.
    await row.getByTestId('session-menu-button').click()
    await page.getByTestId('menu-details').click()
    await expect(popover).toBeVisible()
    await popover.getByTestId('session-project-path').fill(sessionProjectPath)
    await popover.getByTestId('apply-project-path-button').click()
    await expect
      .poll(async () => {
        const snap = await page.evaluate((id) => window.atelier.getSessionWorkspaceSnapshot(id), sessionId)
        return snap?.workspacePath ?? null
      }, { timeout: 15_000 })
      .toBe(sessionProjectPath)
    log(`project path restored to ${sessionProjectPath}`)
  })

  test('chat: untracked plan file appears in session changes cap', async () => {
    test.setTimeout(60_000)
    await page.getByTestId('tab-chat').click()
    await waitForTurnIdle(page, 60_000)
    const planRel = '.claude/plans/e2e-plan.md'
    const planAbs = join(sessionProjectPath, planRel)
    mkdirSync(dirname(planAbs), { recursive: true })
    writeFileSync(planAbs, '# E2E plan\n\n1. First step\n2. Second step\n')
    await page.evaluate(
      ({ id, path }) =>
        window.atelier.debugExecDb(
          `INSERT OR REPLACE INTO session_touched_paths (session_id, path, first_touched_at, last_pending_at)
           VALUES (?, ?, datetime('now'), datetime('now'))`,
          [id, path]
        ),
      { id: sessionId, path: planRel }
    )
    await page.evaluate((id) => window.atelier.refreshSessionWorkspace(id, true), sessionId)
    await expect
      .poll(async () => {
        const snap = await page.evaluate((id) => window.atelier.getSessionWorkspaceSnapshot(id), sessionId)
        return snap?.sessionChangesCap?.items.some((i) => i.kind === 'file' && i.path === planRel) ?? false
      }, { timeout: 15_000 })
      .toBe(true)
    const cap = page.getByTestId('chat-uncommitted-changes')
    await expect(cap).toBeVisible()
    await expandCap(page)
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'e2e-plan.md' })).toBeVisible()
    log('untracked plan file in session changes cap OK')
  })

  test('chat: inline ExitPlanMode plan registers in cap without writing file', async () => {
    test.setTimeout(60_000)
    await page.getByTestId('tab-chat').click()
    await waitForTurnIdle(page, 60_000)
    const planRel = '.claude/plans/plan-logging-failover-runbook-log-1167.md'
    const planBody = '# Plan: Logging Failover Runbook — LOG-1167\n\n1. First step\n'
    const planAbs = join(sessionProjectPath, planRel)
    await page.evaluate(
      ({ id, plan, toolUseId }) => window.atelier.debugRegisterPlanInCap(id, { plan, toolUseId }),
      { id: sessionId, plan: planBody, toolUseId: 'e2e-exit-plan-mode' }
    )
    await page.evaluate((id) => window.atelier.refreshSessionWorkspace(id, true), sessionId)
    await expect
      .poll(async () => {
        const snap = await page.evaluate((id) => window.atelier.getSessionWorkspaceSnapshot(id), sessionId)
        return snap?.sessionChangesCap?.items.some((i) => i.kind === 'file' && i.path === planRel) ?? false
      }, { timeout: 15_000 })
      .toBe(true)
    expect(existsSync(planAbs)).toBe(false)
    const cap = page.getByTestId('chat-uncommitted-changes')
    await expect(cap).toBeVisible()
    await expandCap(page)
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'plan-logging-failover-runbook-log-1167.md' })).toBeVisible()
    log('inline plan registered in session changes cap without mirroring OK')
  })

  test('chat: plan file in cap shows Plan tag and opens review pane', async () => {
    test.setTimeout(60_000)
    await page.getByTestId('tab-chat').click()
    await waitForTurnIdle(page, 60_000)
    const planRel = '.claude/plans/plan-e2e-review-from-cap.md'
    const planBody = [
      '# Plan: E2E review from cap',
      '',
      '## Tasks',
      '',
      '- Alpha bullet',
      '- Beta bullet',
      '  - Nested bullet',
      '',
      '| Step | Owner |',
      '| --- | --- |',
      '| One | Alice |',
      '| Two | Bob |'
    ].join('\n')
    await page.evaluate(
      ({ id, plan, toolUseId }) => window.atelier.debugRegisterPlanInCap(id, { plan, toolUseId }),
      { id: sessionId, plan: planBody, toolUseId: 'e2e-cap-plan-review' }
    )
    await page.evaluate((id) => window.atelier.refreshSessionWorkspace(id, true), sessionId)
    const cap = page.getByTestId('chat-uncommitted-changes')
    await expect(cap).toBeVisible({ timeout: 15_000 })
    await expandCap(page)
    const planRow = cap.locator('[data-testid="chat-changes-file"][data-path="' + planRel + '"]')
    await expect(planRow).toHaveAttribute('data-is-plan', 'true')
    await expect(planRow.getByTestId('chat-changes-plan-tag')).toHaveText('Plan')
    await planRow.click()
    const reviewPane = page.getByTestId('response-review-pane')
    await expect(reviewPane).toBeVisible()
    await expect(reviewPane).toHaveAttribute('data-review-kind', 'plan')
    await expect(reviewPane).toHaveAttribute('data-cap-file-path', planRel)
    await expect(page.getByTestId('response-review-title')).toHaveText('Plan review')
    await expect(reviewPane.getByTestId('response-review-content')).toBeVisible()
    await expect(reviewPane.locator('table')).toBeVisible()
    await expect(reviewPane.locator('table th')).toHaveCount(2)
    await expect(reviewPane.locator('ul li')).toHaveCount(3)
    await page.screenshot({ path: join(artifactsDir, 'plan-review-markdown-format.png') })
    await selectReviewPaneText(reviewPane, 'Two')
    await commentOnReviewSelection(reviewPane, 'Update owner name')
    await expect(reviewPane.locator('table')).toBeVisible()
    await expect(reviewPane.locator('table th')).toHaveCount(2)
    await expect(reviewPane.locator('ul li')).toHaveCount(3)
    await expect(reviewPane.locator('table tbody tr')).toHaveCount(2)
    await expect(reviewPane.getByTestId('response-review-comment-highlight').first()).toBeVisible()
    await expect(page.getByTestId('review-composer-comment-list')).toBeVisible()
    const commentRow = page.getByTestId('review-composer-comment-card').first()
    await expect(commentRow.getByTestId('review-composer-comment-quote')).toContainText('Two')
    await expect(commentRow.getByTestId('review-composer-comment-line')).toHaveText(/line \d+/)
    await expect(commentRow.getByTestId('review-composer-comment-body')).toHaveValue('Update owner name')
    await expect(page.getByTestId('composer-input')).toHaveValue('')
    await expect(page.getByTestId('composer-input')).not.toContainText(/Re plan/)
    await expect(page.getByTestId('tab-diff')).not.toHaveClass(/active/)
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)
    log('plan cap row opens plan review pane OK')
  })

  test('chat: plan cap +/- reflects plan review diff between transcript editions', async () => {
    test.setTimeout(60_000)
    await page.getByTestId('tab-chat').click()
    await waitForTurnIdle(page, 60_000)
    const planRel = '.claude/plans/plan-e2e-editions.md'
    await page.evaluate(
      ({ id, planRel: rel }) =>
        window.atelier.debugRegisterPlanInCap(id, {
          plan: '# Plan\n\nAlpha\n',
          toolUseId: 'e2e-plan-v1',
          planFilePath: rel
        }),
      { id: sessionId, planRel }
    )
    await page.evaluate(
      ({ id, planRel: rel }) =>
        window.atelier.debugRegisterPlanInCap(id, {
          plan: '# Plan\n\nAlpha\nBeta\nGamma\n',
          toolUseId: 'e2e-plan-v2',
          planFilePath: rel
        }),
      { id: sessionId, planRel }
    )
    await page.evaluate((id) => window.atelier.refreshSessionWorkspace(id, true), sessionId)
    await expect
      .poll(async () => {
        const snap = await page.evaluate((id) => window.atelier.getSessionWorkspaceSnapshot(id), sessionId)
        const item = snap?.sessionChangesCap?.items.find(
          (i) => i.kind === 'file' && i.path.endsWith('plan-e2e-editions.md')
        )
        return item?.kind === 'file' ? item.additions : null
      }, { timeout: 15_000 })
      .toBe(2)
    const cap = page.getByTestId('chat-uncommitted-changes')
    await expect(cap).toBeVisible({ timeout: 15_000 })
    await expandCap(page)
    const planRow = cap.getByTestId('chat-changes-file').filter({ hasText: 'plan-e2e-editions.md' })
    await expect(planRow.getByTestId('chat-changes-plan-tag')).toHaveText('Plan')
    await expect(planRow.locator('.chat-changes-add')).toHaveText('+2')
    await expect(planRow.locator('.chat-changes-del')).toHaveCount(0)
    log('plan cap stats match plan review diff OK')
  })

  test('chat: session changes cap — file row, git stats, diff navigation', async () => {
    test.setTimeout(120_000)
    await page.getByTestId('tab-chat').click()
    await waitForTurnIdle(page, 60_000)
    const cap = page.getByTestId('chat-uncommitted-changes')
    await collapseCap(page)
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })).toHaveCount(0)

    await page.getByTestId('composer-input').click()
    await ensureAcceptEditsMode(page, sessionId)

    const editTarget = join(repoDir, 'a.txt')
    await editFileOnce(page, sessionId, editTarget, 'a\n', 'hello from e2e\n')

    await expect(cap).toBeVisible({ timeout: 30_000 })
    await expect(cap).toHaveClass(/collapsed/)
    await cap.getByRole('button', { name: /\d+ change/i }).click()
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })).toBeVisible()
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })).toHaveCount(1)
    const aRow = cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })
    await expect(aRow).toHaveAttribute('data-opens-in-files-tab', 'false')
    await aRow.click()
    const reviewPane = page.getByTestId('response-review-pane')
    await expect(reviewPane).toBeVisible({ timeout: 15_000 })
    await expect(reviewPane).toHaveAttribute('data-review-kind', 'file')
    await expect(reviewPane).toHaveAttribute('data-cap-file-path', 'a.txt')
    await expect(page.getByTestId('response-review-title')).toHaveText('a.txt')
    await expect(reviewPane).toHaveAttribute('data-has-plan-diff', 'true')
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)
    await expect(page.getByTestId('tab-diff')).not.toHaveClass(/active/)

    const snap = await page.evaluate((id) => window.atelier.getSessionWorkspaceSnapshot(id), sessionId)
    const fileItem = snap?.sessionChangesCap?.items.find((i) => i.kind === 'file' && i.path === 'a.txt')
    expect(fileItem?.kind).toBe('file')
    if (fileItem?.kind === 'file') {
      expect(fileItem.additions + fileItem.deletions).toBeGreaterThan(0)
    }

    await page.screenshot({ path: join(artifactsDir, '07-chat-uncommitted-changes.png') })
    log('chat session changes cap -> file review pane OK')
    await page.getByTestId('tab-chat').click()
  })

  test('chat: file review renders .py as source not markdown', async () => {
    test.setTimeout(60_000)
    const pyRel = 'mcp-script.py'
    const pyAbs = join(repoDir, pyRel)
    const pyContent = '#!/usr/bin/env python3\n# Step 1: Get all tool calls\nprint("ok")\n'
    writeFileSync(pyAbs, pyContent)
    await page.getByTestId('tab-chat').click()
    await waitForTurnIdle(page, 60_000)

    const toolContent = JSON.stringify({
      kind: 'tool_call',
      requestId: 'e2e-py-file-review',
      toolUseId: 'e2e-py-file-review-edit',
      name: 'Write',
      status: 'completed',
      input: {
        file_path: pyAbs,
        content: pyContent
      }
    })
    await page.evaluate(
      ({ id, path, content }) =>
        window.atelier
          .debugExecDb(
            `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'assistant', ?, datetime('now'))`,
            [id, content]
          )
          .then(() =>
            window.atelier.debugExecDb(
              `INSERT OR REPLACE INTO session_touched_paths (session_id, path, first_touched_at, last_pending_at)
               VALUES (?, ?, datetime('now'), datetime('now'))`,
              [id, path]
            )
          )
          .then(() => window.atelier.refreshSessionWorkspace(id, true)),
      { id: sessionId, path: pyRel, content: toolContent }
    )

    const cap = page.getByTestId('chat-uncommitted-changes')
    await expect
      .poll(async () => {
        const snap = await page.evaluate((id) => window.atelier.getSessionWorkspaceSnapshot(id), sessionId)
        return snap?.sessionChangesCap?.items.some((i) => i.kind === 'file' && i.path === pyRel) ?? false
      })
      .toBe(true)
    await expandCap(page)
    await cap.getByTestId('chat-changes-file').filter({ hasText: pyRel }).click()
    const reviewPane = page.getByTestId('response-review-pane')
    await expect(reviewPane).toBeVisible({ timeout: 15_000 })
    await expect(reviewPane).toHaveAttribute('data-review-kind', 'file')
    await expect(reviewPane.getByTestId('response-review-file-monaco')).toBeVisible()
    await expect(reviewPane.getByTestId('response-review-file-monaco-host')).toContainText('# Step 1: Get all tool calls')
    await expect(reviewPane.locator('h1, h2, h3')).toHaveCount(0)
    log('py file review renders as source OK')
  })

  test('chat: outside-workspace cap file opens Files tab with inline diff', async () => {
    test.setTimeout(60_000)
    const outsidePath = join(tmpdir(), `atelier-e2e-outside-cap-${Date.now()}.json`)
    writeFileSync(outsidePath, '{"after":true}\n')
    await page.getByTestId('tab-chat').click()
    await waitForTurnIdle(page, 60_000)

    const toolContent = JSON.stringify({
      kind: 'tool_call',
      requestId: 'e2e-outside-cap',
      toolUseId: 'e2e-outside-cap-edit',
      name: 'Edit',
      status: 'completed',
      input: {
        file_path: outsidePath,
        old_string: '{"before":true}\n',
        new_string: '{"after":true}\n'
      }
    })
    await page.evaluate(
      ({ id, path, content }) =>
        window.atelier
          .debugExecDb(
            `INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'assistant', ?, datetime('now'))`,
            [id, content]
          )
          .then(() =>
            window.atelier.debugExecDb(
              `INSERT OR REPLACE INTO session_touched_paths (session_id, path, first_touched_at, last_pending_at)
               VALUES (?, ?, datetime('now'), datetime('now'))`,
              [id, path]
            )
          )
          .then(() => window.atelier.refreshSessionWorkspace(id, true)),
      { id: sessionId, path: outsidePath, content: toolContent }
    )

    await expect
      .poll(async () => {
        const snap = await page.evaluate((id) => window.atelier.getSessionWorkspaceSnapshot(id), sessionId)
        const item = snap?.sessionChangesCap?.items.find((i) => i.kind === 'file' && i.path === outsidePath)
        return item?.kind === 'file' && item.opensInFilesTab === true
      }, { timeout: 15_000 })
      .toBe(true)

    const cap = page.getByTestId('chat-uncommitted-changes')
    await expect(cap).toBeVisible()
    await expandCap(page)
    const row = cap.getByTestId('chat-changes-file').filter({ hasText: 'atelier-e2e-outside-cap' })
    await expect(row).toBeVisible()
    await row.click()
    const reviewPane = page.getByTestId('response-review-pane')
    await expect(reviewPane).toBeVisible({ timeout: 15_000 })
    await expect(reviewPane).toHaveAttribute('data-review-kind', 'file')
    await expect(reviewPane).toHaveAttribute('data-cap-file-path', outsidePath)
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)
    await expect(page.getByTestId('tab-files')).not.toHaveClass(/active/)
    await expect(page.getByTestId('tab-diff')).not.toHaveClass(/active/)
    await expect(reviewPane.getByTestId('response-review-content')).toBeVisible()
    log('outside-workspace cap -> file review pane OK')
    await page.getByTestId('tab-chat').click()
  })

  test('chat: second edit on same file keeps a single cap row', async () => {
    test.setTimeout(120_000)
    const cap = page.getByTestId('chat-uncommitted-changes')
    const editTarget = join(repoDir, 'a.txt')
    await editFileOnce(page, sessionId, editTarget, 'hello from e2e\n', 'hello twice\n')
    await expect(cap).toBeVisible({ timeout: 30_000 })
    await expandCap(page)
    // Earlier tests leave their own rows (plan mirror, outside-workspace file) in this cap, so the
    // claim here is about a.txt specifically: a second edit updates its row instead of adding one.
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })).toHaveCount(1)
    log('second edit -> single file row OK')
  })

  test('chat: reverting file content removes the file cap row', async () => {
    test.setTimeout(120_000)
    const cap = page.getByTestId('chat-uncommitted-changes')
    const editTarget = join(repoDir, 'a.txt')
    await editFileOnce(page, sessionId, editTarget, 'hello twice\n', 'a\n')
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })).toHaveCount(0, {
      timeout: 30_000
    })
    log('revert -> a.txt row dropped OK')
  })

  test('chat: git checkout clears cap row without follow-up edit', async () => {
    test.setTimeout(120_000)
    const cap = page.getByTestId('chat-uncommitted-changes')
    const editTarget = join(repoDir, 'a.txt')
    await editFileOnce(page, sessionId, editTarget, 'a\n', 'pending git checkout\n')
    await expect(cap).toBeVisible({ timeout: 30_000 })
    await expandCap(page)
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })).toHaveCount(1)

    await page.getByTestId('composer-input').fill(
      `Use the Bash tool exactly once with command ${JSON.stringify(`cd ${repoDir} && git checkout -- a.txt`)}. ` +
        'Then reply with exactly the word DONE. Use exactly that one tool call and no others.'
    )
    await page.getByTestId('send-button').click()
    await waitForTurnIdle(page, 90_000)
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })).toHaveCount(0, {
      timeout: 30_000
    })
    log('git checkout -> a.txt row dropped OK')
  })

  test('chat: changes cap restores from SQLite after relaunch', async () => {
    test.setTimeout(120_000)
    const cap = page.getByTestId('chat-uncommitted-changes')
    const editTarget = join(repoDir, 'a.txt')
    await editFileOnce(page, sessionId, editTarget, 'a\n', 'persist after relaunch\n')
    await expect(cap).toBeVisible({ timeout: 30_000 })
    await expandCap(page)
    await expect(cap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })).toHaveCount(1)

    await electronApp.close()
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()
    await page.getByTestId('tab-chat').click()
    await waitForTurnIdle(page, 60_000)
    // `cap` belongs to the page that was just closed — the restored cap lives on the new one.
    const relaunchedCap = page.getByTestId('chat-uncommitted-changes')
    await expect(relaunchedCap).toBeVisible({ timeout: 60_000 })
    await expandCap(page)
    await expect(
      relaunchedCap.getByTestId('chat-changes-file').filter({ hasText: 'a.txt' })
    ).toHaveCount(1)
    const snap = await page.evaluate((id) => window.atelier.getSessionWorkspaceSnapshot(id), sessionId)
    expect(snap?.sessionChangesCap?.items.some((i) => i.path === 'a.txt')).toBe(true)
    log('cap restore after relaunch OK')
  })

  // ── 1. Tab bar: switching hides/shows via class, doesn't unmount ───────
  test('tab bar: switches Chat/Diff/Files/Terminal via hidden-class toggle', async () => {
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)
    await expect(page.locator('.tab-content[data-tab="chat"]')).not.toHaveClass(/hidden/)
    await expect(page.locator('.tab-content[data-tab="diff"]')).toHaveClass(/hidden/)

    await page.getByTestId('tab-diff').click()
    await expect(page.getByTestId('tab-diff')).toHaveClass(/active/)
    await expect(page.locator('.tab-content[data-tab="diff"]')).not.toHaveClass(/hidden/)
    await expect(page.locator('.tab-content[data-tab="chat"]')).toHaveClass(/hidden/)

    await page.screenshot({ path: join(artifactsDir, '07-tabbar.png') })
    await page.getByTestId('tab-chat').click()

    // Both themes, per e2e-test-plan.md's UI-match requirement, at minimum for the tab bar.
    await page.getByTestId('open-settings-button').click()
    await page.getByTestId('theme-light-btn').click()
    await page.getByTestId('settings-close').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    await page.screenshot({ path: join(artifactsDir, '07-tabbar-light.png') })

    await page.getByTestId('open-settings-button').click()
    await page.getByTestId('theme-dark-btn').click()
    await page.getByTestId('settings-close').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.screenshot({ path: join(artifactsDir, '07-tabbar-dark.png') })
  })

  /** Presses a tab and moves the mouse by (dx, dy) without releasing it. */
  async function pressTabAndMoveBy(tab: string, dx: number, dy: number): Promise<void> {
    // The strip scrolls horizontally, so a clipped tab's box can sit outside the
    // visible area; driving the mouse by hand skips the scrolling that click() does.
    const button = page.getByTestId(`tab-${tab}`)
    await button.scrollIntoViewIfNeeded()
    const box = await button.boundingBox()
    if (!box) throw new Error(`tab-${tab} has no bounding box`)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 })
  }

  /** A point just inside the given edge of the workspace, within its drop band. */
  async function workspaceEdgePoint(edge: 'left' | 'right' | 'top' | 'bottom') {
    const ws = await page.getByTestId('session-workspace-tabs').boundingBox()
    if (!ws) throw new Error('workspace has no bounding box')
    const inset = 24
    if (edge === 'left') return { x: ws.x + inset, y: ws.y + ws.height / 2 }
    if (edge === 'right') return { x: ws.x + ws.width - inset, y: ws.y + ws.height / 2 }
    if (edge === 'top') return { x: ws.x + ws.width / 2, y: ws.y + inset }
    return { x: ws.x + ws.width / 2, y: ws.y + ws.height - inset }
  }

  /** Full drag of a tab onto one edge of the workspace. */
  async function dragTabToEdge(tab: string, edge: 'left' | 'right' | 'top' | 'bottom'): Promise<void> {
    await pressTabAndMoveBy(tab, 0, 30)
    const target = await workspaceEdgePoint(edge)
    await page.mouse.move(target.x, target.y, { steps: 12 })
    await page.mouse.up()
  }

  /**
   * Engages a drag and parks the pointer over the middle of the workspace, clear
   * of every edge band, leaving the button down so mid-drag state can be checked
   * without a release splitting anything.
   */
  async function engageDragOverMiddle(tab: string): Promise<void> {
    const ws = await page.getByTestId('session-workspace-tabs').boundingBox()
    if (!ws) throw new Error('workspace has no bounding box')
    await pressTabAndMoveBy(tab, 0, 30)
    await page.mouse.move(ws.x + ws.width / 2, ws.y + ws.height / 2, { steps: 10 })
  }

  test('tab bar: a small movement stays a click; only a deliberate drag engages', async () => {
    // A tab press must tolerate some wobble. Native HTML5 drag engaged after about
    // four pixels and then swallowed the click, so sloppy clicks did nothing.
    await page.getByTestId('tab-chat').click()
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)

    await pressTabAndMoveBy('files', 5, 3)
    await expect(page.getByTestId('workspace-drop-zone-right')).toHaveCSS('opacity', '0')
    await expect(page.getByTestId('workspace-drag-ghost')).toHaveCount(0)
    await page.mouse.up()

    await expect(page.getByTestId('tab-files')).toHaveClass(/active/)
    await expect(page.locator('.tab-content[data-tab="files"]')).not.toHaveClass(/hidden/)

    // Past the threshold the gesture becomes a drag. Released over the middle of
    // the workspace, away from every edge band, it splits nothing — and must not
    // be taken as a click on the tab either.
    await page.getByTestId('tab-chat').click()
    await engageDragOverMiddle('files')
    await expect(page.getByTestId('workspace-drag-ghost')).toBeVisible()
    await expect(page.getByTestId('workspace-drop-zone-top')).not.toHaveClass(/active/)
    await page.mouse.up()

    await expect(page.getByTestId('session-workspace-tabs')).not.toHaveClass(/--split/)
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)

    // Having been dragged must not leave a tab unclickable.
    await page.getByTestId('tab-files').click()
    await expect(page.getByTestId('tab-files')).toHaveClass(/active/)
    await page.getByTestId('tab-chat').click()
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)
  })

  test('tab bar: tabs show the grab cursor only while a drag is in flight', async () => {
    const filesTab = page.getByTestId('tab-files')
    await expect(filesTab).toHaveCSS('cursor', 'pointer')

    await engageDragOverMiddle('files')
    await expect(filesTab).toHaveCSS('cursor', 'grabbing')
    await page.mouse.up()

    await expect(filesTab).toHaveCSS('cursor', 'pointer')
    await page.getByTestId('tab-chat').click()
  })

  test('workspace split: drag Diff beside Chat, Files fullscreen preserves split, Chat restores', async () => {
    await page.getByTestId('tab-chat').click()
    const workspace = page.getByTestId('session-workspace-tabs')

    // All four drop targets stay visible for the whole drag, with only the one
    // under the pointer solid. They can't be driven by CSS :hover — Chromium
    // doesn't update :hover while a drag is in flight.
    await pressTabAndMoveBy('diff', 0, 30)
    const rightEdge = await workspaceEdgePoint('right')
    await page.mouse.move(rightEdge.x, rightEdge.y, { steps: 12 })

    for (const edge of ['left', 'right', 'top', 'bottom']) {
      await expect(page.getByTestId(`workspace-drop-zone-${edge}`)).toHaveCSS('opacity', '1')
    }
    await expect(page.getByTestId('workspace-drop-zone-right')).toHaveClass(/active/)
    await expect(page.getByTestId('workspace-drop-zone-left')).not.toHaveClass(/active/)
    await expect(page.getByTestId('workspace-drag-ghost')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '07-workspace-split-drop-zones.png') })

    await page.mouse.up()

    await expect(workspace).toHaveClass(/session-workspace-tabs--split/)
    await expect(page.locator('.tab-content[data-tab="chat"]')).toHaveClass(/workspace-split-pane/)
    await expect(page.locator('.tab-content[data-tab="diff"]')).toHaveClass(/workspace-split-pane/)
    await expect(page.getByTestId('tab-diff')).toHaveCount(0)
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)

    await page.getByTestId('tab-files').click()
    await expect(page.locator('.tab-content[data-tab="files"]')).not.toHaveClass(/hidden/)
    await expect(page.getByTestId('tab-diff')).toHaveCount(0)
    await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)

    await page.getByTestId('tab-chat').click()
    await expect(workspace).toHaveClass(/session-workspace-tabs--split/)
    await expect(page.getByTestId('tab-diff')).toHaveCount(0)
    await page.screenshot({ path: join(artifactsDir, '07-workspace-split-restore.png') })

    // Each pane carries its own close control — without one there is no way out
    // of a split, since the secondary tab is hidden from the strip.
    const closeButtons = page.getByTestId('workspace-split-pane-close')
    await expect(closeButtons).toHaveCount(2)
    await page.screenshot({ path: join(artifactsDir, '07-workspace-split-pane-close.png') })

    // Closing the Diff pane leaves Chat fullscreen and returns Diff to the strip.
    await page.locator('[data-testid="workspace-split-pane-close"][data-tab="diff"]').click()
    await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)
    await expect(page.getByTestId('workspace-split-pane-close')).toHaveCount(0)
    await expect(page.getByTestId('tab-diff')).toHaveCount(1)
    await expect(page.getByTestId('tab-chat')).toHaveClass(/active/)
    await expect(page.locator('.tab-content[data-tab="chat"]')).not.toHaveClass(/workspace-split-pane/)

    // Dropping on the bottom edge stacks the panes instead of placing them side
    // by side — left/right build a row, top/bottom a column.
    await dragTabToEdge('diff', 'bottom')
    await expect(workspace).toHaveClass(/session-workspace-tabs--split-col/)
    await expect(page.getByTestId('workspace-split-divider')).toHaveAttribute('data-direction', 'col')

    const stacked = await page.evaluate(() => {
      const chat = document.querySelector('.tab-content[data-tab="chat"]')?.getBoundingClientRect()
      const diff = document.querySelector('.tab-content[data-tab="diff"]')?.getBoundingClientRect()
      if (!chat || !diff) return null
      return {
        sameWidth: Math.abs(chat.width - diff.width) < 2,
        chatAboveDiff: chat.bottom <= diff.top + 1
      }
    })
    expect(stacked).toEqual({ sameWidth: true, chatAboveDiff: true })
    await page.screenshot({ path: join(artifactsDir, '07-workspace-split-vertical.png') })

    await page.locator('[data-testid="workspace-split-pane-close"][data-tab="diff"]').click()
    await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)
  })

  test('workspace split: Terminal splits beside Chat instead of covering the whole area', async () => {
    // The real terminal overlays its tab slot from the keep-alive layer, so unless
    // that layer takes the pane geometry the terminal fills the entire workspace
    // and the split is invisible.
    await page.getByTestId('tab-terminal').click()
    await expect(page.locator('.terminal-cache-entry.active')).toHaveCount(1)
    await page.getByTestId('tab-chat').click()

    await dragTabToEdge('terminal', 'right')

    const workspace = page.getByTestId('session-workspace-tabs')
    await expect(workspace).toHaveClass(/session-workspace-tabs--split-row/)
    await expect(page.getByTestId('tab-terminal')).toHaveCount(0)
    await expect(page.locator('.terminal-cache-entry.active')).toHaveClass(/workspace-split-pane--secondary/)

    const geometry = await page.evaluate(() => {
      const term = document.querySelector('.terminal-cache-entry.active')?.getBoundingClientRect()
      const chat = document.querySelector('.tab-content[data-tab="chat"]')?.getBoundingClientRect()
      const host = document.querySelector('[data-testid="session-workspace-tabs"]')?.getBoundingClientRect()
      if (!term || !chat || !host) return null
      return {
        terminalIsHalf: Math.abs(term.width - host.width / 2) < 8,
        chatLeftOfTerminal: chat.right <= term.left + 1
      }
    })
    expect(geometry).toEqual({ terminalIsHalf: true, chatLeftOfTerminal: true })
    await page.screenshot({ path: join(artifactsDir, '07-workspace-split-terminal.png') })

    await page.locator('[data-testid="workspace-split-pane-close"][data-tab="terminal"]').click()
    await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)
    await expect(page.getByTestId('tab-terminal')).toHaveCount(1)
  })

  // ── 2. Diff panel: real hunks + commits, inline comment -> composer ────
  test('diff panel: shows real uncommitted diff + commit log, inline comment feeds the composer', async () => {
    const t0 = Date.now()
    await page.getByTestId('tab-diff').click()
    await expect(page.getByTestId('diff-panel-active')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('diff-refreshing')).toHaveCount(0, { timeout: 30_000 })
    const diff = page.getByTestId('diff-panel-active')
    await expect(diff.getByTestId('diff-file-row').filter({ hasText: 'index.js' })).toBeVisible({ timeout: 30_000 })
    expect(Date.now() - t0).toBeLessThan(30_000)
    log(`diff tab ready in ${Date.now() - t0}ms`)
    await expect(diff.getByTestId('diff-file-row').filter({ hasText: 'repo-wide-change.js' })).toBeVisible()
    const indexRow = diff.getByTestId('diff-file-row').filter({ hasText: 'index.js' })
    await indexRow.click()
    await expect(diff.locator('.diff-line.add').first()).toContainText('hello world!')

    await diff.getByTestId('diff-file-expand-btn').click()
    await expect(diff.getByTestId('diff-full-file-ready')).toBeVisible({ timeout: 15_000 })
    await expect(diff.locator('.diff-full-line-add').first()).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '07-diff-full-file.png') })
    await diff.getByTestId('diff-file-expand-btn').click()
    await expect(diff.getByTestId('diff-file-card')).toBeVisible()
    await expect(diff.locator('.diff-line.add').first()).toContainText('hello world!')

    await diff.getByTestId('diff-add-comment-btn').first().click()
    await diff.getByTestId('diff-comment-input').fill('Please add a test for this.')
    await diff.getByTestId('diff-comment-submit').click()

    await diff.getByTestId('diff-sub-commits').click()
    await expect(diff.getByTestId('commit-row').filter({ hasText: 'Change greeting' })).toBeVisible()
    await expect(diff.getByTestId('commit-row').filter({ hasText: 'Initial commit' })).toBeVisible()

    await diff.getByTestId('commit-row').filter({ hasText: 'Change greeting' }).click()
    await expect(diff.getByTestId('diff-commit-detail')).toBeVisible({ timeout: 10_000 })
    const greetingIndexRow = diff.getByTestId('diff-file-row').filter({ hasText: 'index.js' })
    await expect(greetingIndexRow).toBeVisible({ timeout: 10_000 })
    await greetingIndexRow.click()
    await expect(diff.locator('.diff-line.add').filter({ hasText: 'hello world' }).first()).toBeVisible({ timeout: 10_000 })
    await expect(diff.locator('.diff-line.add').filter({ hasText: 'hello world!' })).toHaveCount(0)

    const starRow = diff.getByTestId('diff-file-row').filter({ hasText: 'example.star' })
    await expect(starRow).toBeVisible({ timeout: 10_000 })
    await starRow.click()
    await expect(diff.locator('.diff-line.add').filter({ hasText: 'version = 2' }).first()).toBeVisible({
      timeout: 10_000
    })

    await diff.getByTestId('diff-commit-back').click()
    await diff.getByTestId('commit-row').filter({ hasText: 'Initial commit' }).click()
    const initialCommitIndexRow = diff.getByTestId('diff-file-row').filter({ hasText: 'index.js' })
    await expect(initialCommitIndexRow).toBeVisible({ timeout: 10_000 })
    await initialCommitIndexRow.click()
    await expect(diff.locator('.diff-line.add').filter({ hasText: "return 'hi'" }).first()).toBeVisible({ timeout: 10_000 })

    await diff.getByTestId('diff-commit-back').click()
    await expect(diff.getByTestId('commit-row').first()).toBeVisible()

    await page.screenshot({ path: join(artifactsDir, '07-diff.png') })

    await page.getByTestId('tab-chat').click()
    await expect(page.getByTestId('composer-input')).toHaveValue(/Please add a test for this\./)
    log('diff panel: inline comment pushed into composer OK')
  })

  test('diff panel: changes list is a compressed directory tree, not full paths', async () => {
    await page.getByTestId('tab-diff').click()
    const diff = page.getByTestId('diff-panel-active')
    await diff.getByTestId('diff-sub-changes').click()

    // File rows show the basename only; the full path lives on title/data-path.
    const indexRow = diff.locator('[data-testid="diff-file-row"][data-path="src/index.js"]')
    await expect(indexRow).toBeVisible()
    await expect(indexRow.locator('.fname')).toHaveText('index.js')
    await expect(indexRow).toHaveAttribute('title', 'src/index.js')

    // Its directory is its own row, indented one level less than the file.
    const srcDir = diff.locator('[data-testid="diff-file-dir"][data-path="src"]')
    await expect(srcDir.locator('.fname')).toHaveText('src')
    await expect(srcDir).toHaveCSS('padding-left', '8px')
    await expect(indexRow).toHaveCSS('padding-left', '20px')

    // A single-child chain collapses into one `deep/nested/chain` row (GitHub-style).
    const chainDir = diff.locator('[data-testid="diff-file-dir"][data-path="deep/nested/chain"]')
    await expect(chainDir.locator('.fname')).toHaveText('deep/nested/chain')
    await expect(diff.locator('[data-testid="diff-file-dir"][data-path="deep"]')).toHaveCount(0)
    await expect(diff.locator('[data-testid="diff-file-row"][data-path="deep/nested/chain/leaf.js"]')).toBeVisible()

    // Repo-root files stay at depth 0 alongside the top-level directories.
    const rootRow = diff.locator('[data-testid="diff-file-row"][data-path="repo-wide-change.js"]')
    await expect(rootRow).toBeVisible()
    await expect(rootRow).toHaveCSS('padding-left', '8px')

    await page.screenshot({ path: join(artifactsDir, '07-diff-file-tree.png') })
    await diff.locator('.file-tree').screenshot({ path: join(artifactsDir, '07-diff-file-tree-rail.png') })

    // Directories collapse and expand.
    await expect(srcDir).toHaveAttribute('aria-expanded', 'true')
    await srcDir.click()
    await expect(srcDir).toHaveAttribute('aria-expanded', 'false')
    await expect(indexRow).toHaveCount(0)
    await page.screenshot({ path: join(artifactsDir, '07-diff-file-tree-collapsed.png') })
    await diff.locator('.file-tree').screenshot({ path: join(artifactsDir, '07-diff-file-tree-rail-collapsed.png') })
    await srcDir.click()
    await expect(indexRow).toBeVisible()

    await page.getByTestId('tab-chat').click()
    log('diff panel: directory tree + path compression + collapse OK')
  })

  // ── 3. Files panel: real tree, syntax highlighting, image + html preview
  test('files panel: tilde project path lists home directory entries', async () => {
    const markerName = `.atelier-e2e-tilde-files-${process.pid}`
    const markerPath = join(homedir(), markerName)
    writeFileSync(markerPath, 'marker\n')
    try {
      const tree = await page.evaluate(() => window.atelier.filesTree('~', null))
      expect(Array.isArray(tree)).toBe(true)
      expect(tree.length).toBeGreaterThan(0)
      expect(tree.some((n: { name: string }) => n.name === markerName)).toBe(true)
    } finally {
      try {
        unlinkSync(markerPath)
      } catch {
        // ignore cleanup failures
      }
    }
    log('files panel: tilde workspace path OK')
  })

  test('files panel: devpod filesRead expands tilde in remote path', async () => {
    const hosts = await page.evaluate(() => window.atelier.listHosts())
    const envTarget = process.env.ATELIER_TEST_DEVPOD
    const devpodHost = envTarget
      ? hosts.find((h) => h.sshHost === envTarget || h.id === envTarget)
      : hosts.find((h) => h.sshHost === 'qingqin-go.devpod-us-or') ?? hosts[0]
    test.skip(!devpodHost, 'No devpod configured — set ATELIER_TEST_DEVPOD or configure a devpod host')
    if (!devpodHost) return

    const result = await page.evaluate(
      ({ path, host }) => window.atelier.filesRead(path, host),
      { path: '~/go-code/.git/HEAD', host: devpodHost.sshHost }
    )
    expect(result.kind).toBe('text')
    expect(result.content.trim().length).toBeGreaterThan(0)
    log(`files panel: devpod tilde path read OK via ${devpodHost.sshHost}`)
  })

  test('files panel: opening a directory shows clickable listing in content pane', async () => {
    await page.getByTestId('tab-files').click()
    const files = page.getByTestId('files-panel-active')
    const location = files.getByTestId('files-location-input')
    await location.click()
    await location.fill('src/')
    await location.press('Enter')
    await expect(files.getByTestId('files-dir-listing')).toBeVisible({ timeout: 10_000 })
    await expect(files.locator('[data-testid="file-tree-dir"][data-path="src"]')).toHaveClass(/active/)
    await expect(files.getByTestId('files-dir-listing-file').filter({ hasText: 'index.js' })).toBeVisible()
    await files.getByTestId('files-dir-listing-file').filter({ hasText: 'index.js' }).click()
    await expect(files.getByTestId('files-editor-tab')).toHaveCount(1)
    await expect(files.locator('[data-testid="file-tree-file"][data-path="src/index.js"]')).toHaveClass(/active/)
    await expect(files.getByTestId('files-dir-listing')).toHaveCount(0)
    log('files panel: directory listing in content pane OK')
  })

  test('files panel: location bar opens nested file by absolute path', async () => {
    await page.getByTestId('tab-files').click()
    const files = page.getByTestId('files-panel-active')
    const location = files.getByTestId('files-location-input')
    // Earlier files-panel tests navigate the location bar, so its current value is not the root —
    // the placeholder always is.
    const workspaceRoot = (await location.getAttribute('placeholder')) ?? (await location.inputValue())
    await location.click()
    await location.fill(`${workspaceRoot}/src/index.js`)
    await location.press('Enter')
    await expect(files.getByTestId('files-editor-tab')).toHaveCount(1)
    await expect(location).toHaveValue(`${workspaceRoot}/src/index.js`)
    await expect(files.locator('[data-testid="file-tree-file"][data-path="src/index.js"]')).toHaveClass(/active/)
    log('files panel: absolute path location bar open OK')
  })

  test('files panel: devpod pathIsDirectory for tilde-prefixed paths', async () => {
    const hosts = await page.evaluate(() => window.atelier.listHosts())
    const envTarget = process.env.ATELIER_TEST_DEVPOD
    const devpodHost = envTarget
      ? hosts.find((h) => h.sshHost === envTarget || h.id === envTarget)
      : hosts.find((h) => h.sshHost === 'qingqin-go.devpod-us-or') ?? hosts[0]
    test.skip(!devpodHost, 'No devpod configured — set ATELIER_TEST_DEVPOD or configure a devpod host')
    if (!devpodHost) return

    const isDir = await page.evaluate(
      ({ path, host }) => window.atelier.filesIsDirectory(path, host),
      { path: '~/go-code/src/code.uber.internal/infra/logging/pkg/sawmill/loggingmcpconformance', host: devpodHost.sshHost }
    )
    expect(isDir).toBe(true)
    log(`files panel: devpod pathIsDirectory OK via ${devpodHost.sshHost}`)
  })

  test('files panel: real file tree from disk, text highlighting, image preview', async () => {
    await page.getByTestId('tab-files').click()
    const files = page.getByTestId('files-panel-active')
    await expect(files.getByTestId('files-tree')).toContainText('src')
    await expect(files.getByTestId('files-tree')).toContainText('logo.png')
    await expect(files.getByTestId('files-tree')).toContainText('page.html')
    // Symlinks follow their target type in the tree (dir link → folder icon, file link → file icon).
    await expect(files.locator('[data-testid="file-tree-dir"][data-path="src"]')).toBeVisible()
    await expect(files.locator('[data-testid="file-tree-file"][data-path="logo.png"]')).toBeVisible()
    await expect(files.locator('[data-testid="file-tree-file"][data-path="page.html"]')).toBeVisible()

    const indexJs = files.locator('[data-testid="file-tree-file"][data-path="src/index.js"]')
    if (!(await indexJs.isVisible())) {
      await files.locator('[data-testid="file-tree-dir"][data-path="src"]').click()
    }
    await indexJs.click()
    await expect(files.getByTestId('files-editor-tab')).toHaveCount(1)
    await expect(files.locator('[data-testid="files-editor-tab"][data-path="src/index.js"]')).toHaveClass(/active/)

    await files.locator('[data-testid="file-tree-file"][data-path="logo.png"]').click()
    await expect(files.getByTestId('files-editor-tab')).toHaveCount(1)
    await expect(files.locator('[data-testid="files-editor-tab"][data-path="logo.png"]')).toHaveClass(/active/)
    await expect(files.getByTestId('file-preview-image')).toBeVisible()

    await files.getByTestId('files-editor-tab-add').click()
    await expect(files.getByTestId('files-editor-tab')).toHaveCount(2)
    await expect(files.locator('[data-testid="files-editor-tab"][data-path="logo.png"]')).toHaveCount(2)

    const indexJsTree = files.locator('[data-testid="file-tree-file"][data-path="src/index.js"]')
    if (!(await indexJsTree.isVisible())) {
      await files.locator('[data-testid="file-tree-dir"][data-path="src"]').click()
    }
    await indexJsTree.click()
    await expect(files.getByTestId('files-editor-tab')).toHaveCount(2)
    await expect(files.locator('[data-testid="files-editor-tab"][data-path="src/index.js"]')).toHaveClass(/active/)
    await expect(files.locator('.view-line', { hasText: 'hello world!' }).first()).toBeVisible({ timeout: 10_000 })

    const logoTab = files.locator('[data-testid="files-editor-tab"][data-path="logo.png"]').first()
    await logoTab.locator('[data-testid="files-editor-tab-close"]').click()
    await expect(files.getByTestId('files-editor-tab')).toHaveCount(1)
    await expect(files.locator('[data-testid="files-editor-tab"][data-path="src/index.js"]')).toHaveClass(/active/)

    // Monaco editor is visible and renders the file's text content in .view-line elements
    await expect(files.getByTestId('monaco-editor')).toBeVisible()
    await expect(files.locator('.view-line', { hasText: 'hello world!' }).first()).toBeVisible({ timeout: 10_000 })

    const monacoBg = () =>
      page.evaluate(() => {
        const el = document.querySelector('.monaco-editor .monaco-editor-background')
        return el ? getComputedStyle(el).backgroundColor : ''
      })

    await page.getByTestId('open-settings-button').click()
    await page.getByTestId('theme-light-btn').click()
    await page.getByTestId('settings-close').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    await expect.poll(monacoBg).toBe('rgb(236, 231, 219)')

    await page.getByTestId('open-settings-button').click()
    await page.getByTestId('theme-dark-btn').click()
    await page.getByTestId('settings-close').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await expect.poll(monacoBg).toBe('rgb(23, 21, 15)')

    await files.locator('[data-testid="files-editor-tab"][data-path="src/index.js"]').click()
    await expect(files.locator('.view-line', { hasText: 'hello world!' }).first()).toBeVisible({ timeout: 10_000 })
    await files.locator('.monaco-editor .margin').hover({ position: { x: 12, y: 40 } })
    await expect(files.getByTestId('files-line-comment-btn')).toBeVisible({ timeout: 5_000 })
    await files.getByTestId('files-line-comment-btn').click()
    await files.getByTestId('files-comment-input').fill('Review this line in Files.')
    await files.getByTestId('files-comment-submit').click()
    await page.getByTestId('tab-chat').click()
    await expect(page.getByTestId('composer-input')).toHaveValue(/Review this line in Files\./)
    await page.getByTestId('tab-files').click()
    log('files panel: line comment pushed into composer OK')

    await files.locator('[data-testid="file-tree-file"][data-path="logo.png"]').click()
    await expect(files.getByTestId('file-preview-image')).toBeVisible()
    const src = await files.getByTestId('file-preview-image').getAttribute('src')
    expect(src).toMatch(/^data:image\/png;base64,/)

    await files.locator('[data-testid="file-tree-file"][data-path="page.html"]').click()
    await expect(files.getByTestId('file-preview-html')).toBeVisible()

    const previewFrame = files.frameLocator('[data-testid="file-preview-html"]')
    await expect(previewFrame.locator('h1')).toHaveText('Fixture page')

    await page.evaluate((id) => window.atelier.refreshSessionWorkspace(id, true), sessionId)
    await files.locator('[data-testid="files-editor-tab"][data-path="src/index.js"]').click()
    await expect(files.locator('.view-line', { hasText: 'hello world!' }).first()).toBeVisible({ timeout: 10_000 })

    await page.screenshot({ path: join(artifactsDir, '07-files.png') })
    log('files panel: real tree + text/image/html preview OK')
  })

  test('file quick open: split dir/search, shallow dir browse, recursive search opens file', async () => {
    await page.getByTestId('tab-chat').click()
    await page.getByTestId('composer-input').click()
    await page.keyboard.down('Control')
    await page.keyboard.press('KeyX')
    await page.keyboard.press('KeyF')
    await page.keyboard.up('Control')
    await expect(page.getByTestId('file-quick-open')).toBeVisible()
    const searchInput = page.getByTestId('file-quick-open-input')
    await expect(searchInput).toBeFocused()
    await expect(page.getByTestId('file-quick-open-dir')).toContainText(repoDir.replace(/^\/Users\/[^/]+/, '~'))

    await searchInput.fill('index')
    await expect(page.getByTestId('file-quick-open-item').filter({ hasText: 'index.js' })).toHaveCount(1)

    await searchInput.fill('')
    await expect(searchInput).toHaveValue('')
    await page.getByTestId('file-quick-open-dir').click()
    const dirInput = page.locator('[data-testid="file-quick-open-dir"].fqo-dir-input')
    await expect(dirInput).toBeVisible()
    await expect(dirInput).toBeFocused()
    const dirValue = await dirInput.inputValue()
    expect(dirValue.length).toBeGreaterThan(0)
    await dirInput.fill(`${dirValue.replace(/\/$/, '')}/sr`)
    await expect(page.getByTestId('file-quick-open-item').filter({ hasText: 'src/' })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(dirInput).toBeFocused()
    await expect(dirInput).toHaveValue(/\/src$/)
    await page.keyboard.press('Tab')
    await expect(searchInput).toBeFocused()
    await expect(page.getByTestId('file-quick-open-dir')).toContainText('/src')

    await searchInput.fill('index')
    await page.keyboard.press('Enter')

    await expect(page.getByTestId('file-quick-open')).toHaveCount(0)
    await expect(page.getByTestId('tab-files')).toHaveClass(/active/)
    await expect(page.getByTestId('monaco-editor')).toBeVisible()
    await expect(page.locator('.view-line', { hasText: 'hello world!' }).first()).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: join(artifactsDir, '07-file-quick-open.png') })
    log('file quick open: split dir/search OK')
  })

  test('file quick open: Ctrl+X Ctrl+F from Files Monaco editor opens palette', async () => {
    await page.getByTestId('tab-files').click()
    const files = page.getByTestId('files-panel-active')
    await expect(files.getByTestId('files-tree')).toBeVisible({ timeout: 15_000 })
    await expect(files.locator('[data-testid="file-tree-dir"][data-path="src"]')).toBeVisible({ timeout: 15_000 })

    const indexJs = files.locator('[data-testid="file-tree-file"][data-path="src/index.js"]')
    if (!(await indexJs.isVisible())) {
      await files.locator('[data-testid="file-tree-dir"][data-path="src"]').click()
    }
    await indexJs.click()
    await expect(files.locator('[data-testid="files-editor-tab"][data-path="src/index.js"]')).toHaveClass(/active/)
    await expect(files.locator('.view-line', { hasText: 'hello world!' }).first()).toBeVisible({ timeout: 15_000 })
    await files.locator('.view-line').first().click()

    await page.keyboard.down('Control')
    await page.keyboard.press('KeyX')
    await page.keyboard.press('KeyF')
    await page.keyboard.up('Control')

    await expect(page.getByTestId('file-quick-open')).toBeVisible()
    await expect(page.getByTestId('file-quick-open-input')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('file-quick-open')).toHaveCount(0)
    log('file quick open: Files editor chord OK')
  })

  // ── 4. Worktree create/list/remove round trip against real disk state ──
  test('worktree panel: create, list, merge, and remove a real git worktree', async () => {
    await page.getByTestId('tab-diff').click()
    const diff = page.getByTestId('diff-panel-active')
    await diff.getByTestId('diff-sub-worktrees').click()

    await diff.getByTestId('worktree-branch-input').fill('feature-x')
    await diff.getByTestId('worktree-add').click()
    await expect(diff.getByTestId('worktree-row')).toContainText('feature-x', { timeout: 10_000 })

    const worktreeListOutput = git(repoDir, ['worktree', 'list'])
    expect(worktreeListOutput).toContain('feature-x')
    log(`git worktree list after add:\n${worktreeListOutput}`)

    await page.screenshot({ path: join(artifactsDir, '07-worktree.png') })

    await diff.getByTestId('worktree-merge').click()
    // Merging a branch identical to HEAD is a real (trivial) fast-forward/no-op merge — still a real `git merge` call.
    await page.waitForTimeout(500)

    await diff.getByTestId('worktree-remove').click()
    await expect(diff.getByTestId('worktree-row')).toHaveCount(0, { timeout: 10_000 })

    const worktreeListAfterRemove = git(repoDir, ['worktree', 'list'])
    expect(worktreeListAfterRemove).not.toContain('feature-x')
    log(`git worktree list after remove:\n${worktreeListAfterRemove}`)
  })

  // ── 5a. Terminal-only session mode: a real plain shell, no agent ───────
  test('terminal-only session: real shell echoes real output', async () => {
        await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(repoDir)
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    const term = page.getByTestId('terminal-body')
    await term.click()
    await page.waitForTimeout(500) // let the shell finish its silent startup clear
    await page.keyboard.type('echo hello-from-terminal-mode')
    await page.keyboard.press('Enter')

    await expect.poll(async () => term.textContent(), { timeout: 10_000 }).toContain('hello-from-terminal-mode')
    await page.screenshot({ path: join(artifactsDir, '07-terminal.png') })
    log('terminal-only mode: real pty echoed real output OK')
  })

  test('open local terminal button: one-click local terminal with Local meta', async () => {
    await page.getByTestId('open-local-terminal-button').click()
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    const row = page.locator('[data-testid="terminal-list"] [data-testid="session-row"][data-mode="terminal"]').last()
    await expect(row.getByTestId('session-meta-host')).toHaveText('Local')
    const sessionId = (await row.getAttribute('data-session-id')) as string
    await page.screenshot({ path: join(artifactsDir, '07-local-terminal-sidebar.png') })
    log('open local terminal: sidebar Local meta OK')

    await row.getByTestId('session-menu-button').click()
    await expect(page.getByTestId('menu-fork')).toHaveCount(0)
    await page.getByTestId('menu-delete').click()
    await expect(page.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0)
    log('open local terminal: delete terminal row OK')
  })

  test('terminal toolbox: toggle panel and double-click pastes command into shell', async () => {
    await page.getByTestId('open-local-terminal-button').click()
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    const term = page.getByTestId('terminal-body')
    await term.click()

    await page.getByTestId('terminal-toolbox-toggle').click()
    await expect(page.getByTestId('terminal-toolbox-panel')).toBeVisible()

    const marker = `toolbox-paste-${Date.now()}`
    await page.getByTestId('terminal-toolbox-add').click()
    await page.getByTestId('terminal-toolbox-add-label').fill('echo marker')
    await page.getByTestId('terminal-toolbox-add-command').fill(`echo ${marker}`)
    await page.getByTestId('terminal-toolbox-add-save').click()
    await page.locator('.term-toolbox-row').filter({ hasText: 'echo marker' }).dblclick()
    await page.keyboard.press('Enter')
    await expect.poll(async () => term.textContent(), { timeout: 15_000 }).toContain(marker)
    await page.screenshot({ path: join(artifactsDir, '07-terminal-toolbox.png') })
    log('terminal toolbox: paste + run OK')
  })

  // ── 6. Ports panel (real devpod) ────────────────────────────────────────
  test('ports panel: real SSH local port forward against qingqin-go.devpod-us-or actually works', async ({}, testInfo) => {
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('project-path').fill('/home/user')
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect(page.getByTestId('tab-ports')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('tab-ports').click()

    const localPort = 38022 + (testInfo.repeatEachIndex ?? 0)
    // Forward a local port to the remote's own sshd (22) — a real, always-on
    // listener on qingqin-go.devpod-us-or — so a successful forward can be
    // proven end-to-end by reading a real SSH banner back over it.
    await page.getByTestId('port-local-input').fill(String(localPort))
    await page.getByTestId('port-remote-host-input').fill('127.0.0.1')
    await page.getByTestId('port-remote-port-input').fill('22')
    await page.getByTestId('port-add').click()

    await expect
      .poll(async () => page.getByTestId('port-status').first().textContent(), { timeout: 20_000 })
      .toBe('active')

    await page.screenshot({ path: join(artifactsDir, '07-ports.png') })

    const banner = await connectTcp(localPort, 8000)
    expect(banner.toString('utf-8')).toContain('SSH-')
    log(`port forward localhost:${localPort} -> devpod:22 real SSH banner: ${banner.toString('utf-8').trim()}`)

    await page.getByTestId('port-remove').click()
    await expect(page.getByTestId('port-row')).toHaveCount(0, { timeout: 10_000 })
  })

  // ── 6b. Diff panel (real devpod): git ops must run remotely over SSH ───
  // Bug repro: the Diff tab always shells out to the LOCAL git binary with
  // cwd=projectPath, so for a remote session (where projectPath only exists
  // on the devpod) it always reports "not a git repository" — even though
  // the real remote path is a real repo with real commits (confirmed via
  // `ssh qingqin-go.devpod-us-or -- git -C ~/go-code rev-parse
  // --is-inside-work-tree` -> `true`).
  test('diff panel: real devpod session shows real remote git state, not "not a git repository"', async () => {
        await page.getByTestId('new-session-button').click()
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('project-path').fill('/home/user/go-code')
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    await expect(page.getByTestId('tab-diff')).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('tab-diff').click()

    const diff = page.getByTestId('diff-panel-active')
    await expect(diff).toBeVisible({ timeout: 30_000 })

    await expect(page.getByTestId('diff-empty-not-repo')).toHaveCount(0)
    await expect(diff).toBeVisible()

    await diff.getByTestId('diff-sub-commits').click()
    await expect(diff.getByTestId('commit-row').first()).toBeVisible({ timeout: 15_000 })

    await page.screenshot({ path: join(artifactsDir, '07-diff-devpod.png') })
    log('diff panel: real devpod git state shown OK')
  })

  // ── 6e. Real bug: React.StrictMode's mount->cleanup->mount (dev-mode only —
  // see src/renderer/src/main.tsx) fires TerminalPanel's pty-lifecycle effect
  // as spawn(P1) -> kill(P1) -> spawn(P2) for the *same* ptyId, all
  // back-to-back with no await between. `pty.ts`'s `proc.onData(...)` never
  // checks whether its own `proc` is still the live entry in `this.ptys`
  // before forwarding to the renderer, so P1's in-flight output keeps
  // leaking through under the same id even after P2 has taken over — this
  // is what corrupted a real user's terminal into duplicated/garbled
  // "cd ... && clear" lines and made it look like typing did nothing.
  // Reproduced here via the real `window.atelier` IPC bridge (same bridge
  // TerminalPanel itself uses) so it doesn't depend on flaky React dev-mode
  // timing to trigger.
  test('bug repro: rapid respawn under the same ptyId leaks the killed process\'s output forever', async () => {
    const raceId = `strictmode-race-${Date.now()}`

    await page.evaluate(
      ({ id, cwd }) => {
        ;(window as unknown as { __raceLog: string[] }).__raceLog = []
        ;(window as unknown as { __raceUnsub: () => void }).__raceUnsub = window.atelier.onPtyData(({ id: evId, data }) => {
          if (evId === id) (window as unknown as { __raceLog: string[] }).__raceLog.push(data)
        })
        void window.atelier.ptySpawn({ id, cwd, hostname: null, cols: 100, rows: 30 })
      },
      { id: raceId, cwd: repoDir }
    )

    await page.waitForTimeout(500) // let P1's real shell actually start
    // P1 (the soon-to-be-killed process) is made to continuously produce
    // output, guaranteeing it's mid-write at the exact moment it's killed —
    // the real-world race is timing-dependent; this makes it deterministic.
    await page.evaluate((id) => void window.atelier.ptyWrite(id, 'yes P1-LEAK-MARKER\r'), raceId)
    await page.waitForTimeout(500)

    // Simulate StrictMode's synchronous cleanup+remount: kill P1, then
    // immediately spawn P2 for the identical id, no await in between.
    await page.evaluate(
      (id) => {
        void window.atelier.ptyKill(id)
        void window.atelier.ptySpawn({ id, cwd: '/tmp', hostname: null, cols: 100, rows: 30 })
      },
      raceId
    )

    // A finite tail of *already-sent* pre-kill messages can still be sitting
    // in Electron's IPC delivery queue at this point (P1 was flooding the
    // channel) — that's expected and not the bug, and not something the
    // renderer can reliably distinguish from a genuine leak by content/count
    // alone. The authoritative check is at the source: `pty.ts` logs every
    // time it detects and drops output from a process that's no longer the
    // current entry for its id (see `logger.info('pty stale-data dropped', ...)`
    // in src/main/panels/pty.ts) — grep the real app log for that, the same
    // pattern this project already uses for bug evidence (see CLAUDE.md §2).
    await page.waitForTimeout(1500)

    const logPath = join(userDataDir, 'logs', 'main.log')
    const droppedForRace = readFileSync(logPath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { msg: string; id: string; gen: number; currentGen: number | null })
      .filter((entry) => entry.msg === 'pty stale-data dropped' && entry.id === raceId)

    log(`rapid respawn race: pty.ts dropped ${droppedForRace.length} stale-data event(s) for this race: ${JSON.stringify(droppedForRace)}`)

    await page.evaluate(() => (window as unknown as { __raceUnsub: () => void }).__raceUnsub())
    await page.evaluate((id) => void window.atelier.ptyKill(id), raceId)

    // Confirms the race was actually hit (P1 really was still mid-write when
    // replaced) *and* that it was correctly intercepted before ever reaching
    // the renderer — the real, source-level fix for the bug, not just an
    // absence-of-symptom check that could pass by luck.
    expect(droppedForRace.length, 'the source-level guard must detect and drop stale data from the killed process').toBeGreaterThan(0)
    for (const entry of droppedForRace) {
      expect(entry.currentGen, 'dropped data must be from an older generation than the current live process').not.toBe(entry.gen)
    }
  })

  // ── 6f. tmux persistence: shell cwd survives TerminalPanel unmount/remount ──
  // When switching sessions, `selectSession()` resets visitedTabs to {chat},
  // which unmounts the outgoing session's TerminalPanel. Its cleanup calls
  // `ptyKill` → `tmux detach-client` then `proc.kill()` — this leaves the
  // named tmux server session alive. When the user switches back, a fresh
  // TerminalPanel mounts, ptySpawn is called, `tmux has-session` finds the
  // existing session, and `tmux attach-session` reattaches — the shell's cwd
  // and any running processes are fully preserved.
  //
  // This test is self-contained: it creates its own two terminal-only sessions
  // (no agent call needed) and uses `data-active="true"` on the session row to
  // find session A's id reliably even when many other sessions already exist.
  test('tmux persistence: shell cwd (/tmp) survives TerminalPanel unmount+remount via session switch', async () => {
    // Guard: skip if tmux is not installed — pty.ts falls back to a plain
    // shell with no persistence guarantee, making this test vacuous.
    let hasTmux = false
    try {
      execFileSync('which', ['tmux'], { encoding: 'utf8' })
      hasTmux = true
    } catch { /* not on PATH */ }
    if (!hasTmux) {
      test.skip(true, 'tmux not installed — terminal persistence test skipped')
      return
    }

    // 1. Create terminal-only session A — no agent SDK call required, just a
    //    real pty. After creation the new session is immediately active.
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(repoDir)
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })

    // Capture session A's id via the `data-active="true"` attribute set by
    // Sidebar.tsx on the currently-selected row — reliable regardless of how
    // many other sessions exist in the sidebar.
    const sessionAId = await page
      .locator('[data-testid="session-row"][data-active="true"]')
      .getAttribute('data-session-id')
    expect(sessionAId, 'session A must be the active row after creation').toBeTruthy()
    const rowA = page.locator(`[data-testid="session-row"][data-session-id="${sessionAId}"]`)

    // 2. Wait for the shell prompt, then cd to /tmp. For terminal-only sessions
    //    TerminalPanel is mounted immediately with ptyId=session.id, and pty.ts
    //    runs `tmux new-session -d -s <name> -c <cwd>` then
    //    `tmux attach-session -t <name>` — the pty IS a tmux attach client.
    const termA = page.getByTestId('terminal-body')
    await expect(termA).toBeVisible({ timeout: 10_000 })
    await termA.click()
    await page.waitForTimeout(1000) // tmux attach + shell fully ready

    await page.keyboard.type('cd /tmp')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    // 3. Confirm the cwd is /tmp before switching away.
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect.poll(async () => termA.textContent(), { timeout: 10_000 }).toContain('/tmp')
    await page.screenshot({ path: join(artifactsDir, 'bug-tmux-persistence-01-before-switch.png') })
    log('tmux persistence: /tmp confirmed in session A before switch')

    // 4. Create terminal-only session B to switch to. Navigating to B triggers
    //    selectSession() in App.tsx, which changes activeSession from A to B.
    //    React unmounts session A's TerminalPanel → its cleanup fires:
    //    ptyKill(A.id) → `tmux detach-client -s <name-A>` (graceful detach,
    //    tmux server session stays alive) → proc.kill().
        await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(repoDir)
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(artifactsDir, 'bug-tmux-persistence-02-switched-away.png') })
    log('tmux persistence: switched to session B — session A terminal unmounted, tmux session left alive')

    // 5. Switch back to session A. React mounts a fresh TerminalPanel for A:
    //    ptySpawn(A.id) → `tmux has-session -t <name-A>` succeeds → skip
    //    new-session → `tmux attach-session -t <name-A>` reattaches. The
    //    shell's cwd and running processes are fully restored.
    await rowA.click()
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    const termAfter = page.getByTestId('terminal-body')
    await expect(termAfter).toBeVisible({ timeout: 10_000 })
    await termAfter.click()
    await page.waitForTimeout(1000) // tmux reattach + screen redraw

    // 6. Type pwd again — cwd must still be /tmp. Without tmux (plain shell),
    //    ptySpawn would start a fresh shell in the project folder and /tmp
    //    would never appear here.
    await page.keyboard.type('pwd')
    await page.keyboard.press('Enter')
    await expect.poll(async () => termAfter.textContent(), { timeout: 10_000 }).toContain('/tmp')
    await page.screenshot({ path: join(artifactsDir, 'bug-tmux-persistence-03-after-reattach.png') })
    log('tmux persistence: cwd /tmp survived TerminalPanel unmount+remount — OK')
  })

  // ── 6g. devpod tmux persistence: remote shell cwd survives TerminalPanel
  // unmount+remount via session switch, mirroring the local tmux test (6f)
  // but running the tmux session on the devpod over SSH. The flow:
  //   spawn → `ssh <host> tmux new-session -d` (if needed)
  //           `ssh <host> -t tmux attach-session`
  //   kill  → `ssh <host> tmux detach-client` (session survives on remote)
  //   spawn → `ssh <host> tmux has-session` (finds it) → `attach-session`
  // The shell's cwd and running processes are fully preserved across the
  // SSH disconnection because tmux keeps the session alive on the devpod.
  test('devpod tmux persistence: remote shell cwd survives TerminalPanel unmount+remount via session switch', async () => {
    // Resolve which devpod host to use. Prefer the ATELIER_TEST_DEVPOD env
    // var (matched by sshHost or id), otherwise take the first available host.
    const hosts = await page.evaluate(() => window.atelier.listHosts())
    const envTarget = process.env.ATELIER_TEST_DEVPOD
    const devpodHost = envTarget
      ? hosts.find((h) => h.sshHost === envTarget || h.id === envTarget)
      : hosts[0]

    test.skip(!devpodHost, 'No devpod configured — set ATELIER_TEST_DEVPOD env var or configure a devpod host')
    if (!devpodHost) return

    log(`devpod tmux persistence: using host ${devpodHost.sshHost} (id=${devpodHost.id})`)

    // 1. Create a terminal-only session on the devpod.
        await page.getByTestId('new-session-button').click()
    await page.getByTestId(`host-option-${devpodHost.id}`).click()
    await page.getByTestId('project-path').fill('/home/user')
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 20_000 })

    // Capture the devpod session's id so we can click back to it after switching away.
    const sessionDevpodId = await page
      .locator('[data-testid="session-row"][data-active="true"]')
      .getAttribute('data-session-id')
    expect(sessionDevpodId, 'devpod session must be the active row after creation').toBeTruthy()
    const rowDevpod = page.locator(`[data-testid="session-row"][data-session-id="${sessionDevpodId}"]`)

    // Shell-readiness probe that distinguishes EXECUTED output from typed command text.
    //
    // The problem: xterm's textContent() contains BOTH the typed command (echoed by
    // the terminal) AND the shell's actual output. Checking `textContent().toContain(X)`
    // where X is part of the typed command fires immediately on typing — before the
    // shell executes anything — giving a false "shell is ready" signal.
    //
    // Solution: `printf 'MARKER:'; pwd`
    //   typed command text:  printf 'MARKER:'; pwd   ← contains `MARKER:'` (single quote)
    //   shell output:        MARKER:/home/user/...   ← contains `MARKER:/` (slash)
    // Searching for `MARKER:/` (with slash) uniquely identifies the OUTPUT; it cannot
    // appear in the typed command text, which has a `'` immediately after `MARKER:`.
    const cwdProbe = async (term: ReturnType<typeof page.getByTestId>, timeout: number) => {
      const marker = `gdprb${Date.now()}`
      await term.click()
      await page.keyboard.type(`printf '${marker}:'; pwd`)
      await page.keyboard.press('Enter')
      // `marker:/` only appears in the shell output, never in the typed command text
      await expect.poll(async () => term.textContent(), { timeout }).toContain(`${marker}:/`)
      const content = await term.textContent() ?? ''
      const idx = content.indexOf(`${marker}:/`)
      // Slice from the `/` in the marker output to read the actual path
      return content.slice(idx + marker.length + 1, idx + marker.length + 80)
    }

    // 2. Wait for the shell to be live, then verify it by actually executing a
    //    command and reading its output (not just observing typed text).
    const termDevpod = page.getByTestId('terminal-body')
    await expect(termDevpod).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(5000) // SSH + tmux new-session + attach typically 3-5s

    const pathBefore = await cwdProbe(termDevpod, 25_000)
    log(`devpod tmux persistence: initial cwd: ${pathBefore.slice(0, 50)}`)

    // 3. cd into ~/go-code and confirm the cwd changed.
    await page.keyboard.type('cd ~/go-code')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)

    const pathAfterCd = await cwdProbe(termDevpod, 10_000)
    expect(pathAfterCd, 'cwd must be in go-code before switching away').toContain('go-code')
    await page.screenshot({ path: join(artifactsDir, 'devpod-tmux-persistence-01-before-switch.png') })
    log(`devpod tmux persistence: go-code cwd confirmed before switch (path: ${pathAfterCd.slice(0, 50)})`)

    // 4. Create a local terminal-only session to switch to. This triggers
    //    selectSession() in App.tsx → React unmounts the devpod TerminalPanel
    //    → its cleanup fires ptyKill → proc.kill() drops the SSH connection;
    //    the remote tmux server detects the disconnect and detaches the client,
    //    leaving the named tmux session (and its shell's cwd) alive on the devpod.
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(repoDir)
    await page.getByTestId('mode-terminal').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(artifactsDir, 'devpod-tmux-persistence-02-switched-away.png') })
    log('devpod tmux persistence: switched to local session B — devpod terminal unmounted, remote tmux session left alive')

    // 5. Switch back to the devpod session. React mounts a fresh TerminalPanel:
    //    ptySpawn → `ssh <host> tmux has-session` succeeds → skip new-session →
    //    `ssh <host> -t tmux attach-session` reattaches to the live remote session.
    await rowDevpod.click()
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    const termAfter = page.getByTestId('terminal-body')
    await expect(termAfter).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(6000) // SSH reconnect + tmux has-session + attach

    // 6. Verify the cwd is STILL go-code after reattach. Without remote tmux,
    //    the SSH session ends on disconnect and a fresh shell starts in the
    //    default home dir — the probe would return `/home/user` (no go-code).
    const pathAfterReattach = await cwdProbe(termAfter, 25_000)
    expect(pathAfterReattach, 'cwd must still be in go-code after SSH disconnect+reattach').toContain('go-code')
    await page.screenshot({ path: join(artifactsDir, 'devpod-tmux-persistence-03-after-reattach.png') })
    log(`devpod tmux persistence: cwd go-code survived SSH disconnect+reattach via remote tmux — OK (path: ${pathAfterReattach.slice(0, 50)})`)
  })

  // ── 6h. SSH ControlMaster: devpod terminal must create a mux socket ────────
  // Fix: SSH slowness (13s per open, 3 cold crypto handshakes) was resolved by
  // adding ControlMaster=auto + ControlPath=/tmp/atelier-ssh-%C to all SSH
  // execFileSync calls in pty.ts. After the first connection, subsequent SSH
  // calls reuse the socket (<5ms each). This test verifies the socket is
  // actually created, proving the ControlMaster path is exercised.
  test('SSH ControlMaster: devpod terminal open creates a multiplexing socket in /tmp', async () => {
    const hosts = await page.evaluate(() => window.atelier.listHosts())
    const envTarget = process.env.ATELIER_TEST_DEVPOD
    const devpodHost = envTarget
      ? hosts.find((h) => h.sshHost === envTarget || h.id === envTarget)
      : hosts[0]

    test.skip(!devpodHost, 'No devpod configured — set ATELIER_TEST_DEVPOD or configure a devpod host')
    if (!devpodHost) return

    log(`SSH ControlMaster: using host ${devpodHost.sshHost} (id=${devpodHost.id})`)

    // Remove any pre-existing atelier-ssh-* sockets so we can confirm a new
    // one is created by this connection (not a leftover from a prior test).
    const socketsBefore = readdirSync('/tmp').filter((f) => f.startsWith('atelier-ssh-'))
    socketsBefore.forEach((f) => {
      try { require('node:fs').unlinkSync(`/tmp/${f}`) } catch { /* best-effort */ }
    })

    await page.getByTestId('new-session-button').click()
    await page.getByTestId(`host-option-${devpodHost.id}`).click()
    await page.getByTestId('project-path').fill('/tmp')
    await page.getByTestId('mode-terminal').click()
    const t0 = Date.now()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 30_000 })

    // Track this session's id so we can click back to it after switching away.
    const devpodSessionId = await page
      .locator('[data-testid="session-row"][data-active="true"]')
      .getAttribute('data-session-id')
    const devpodRow = page.locator(`[data-testid="session-row"][data-session-id="${devpodSessionId}"]`)

    // Wait for the shell to be responsive.
    const term = page.getByTestId('terminal-body')
    await expect(term).toBeVisible({ timeout: 10_000 })
    await term.click()
    await page.waitForTimeout(3_000) // SSH + tmux attach

    const marker = `ctrl-${Date.now()}`
    await page.keyboard.type(`echo ${marker}`)
    await page.keyboard.press('Enter')
    await expect.poll(async () => term.textContent(), { timeout: 20_000 }).toContain(marker)
    log(`SSH ControlMaster: shell responsive in ${Date.now() - t0}ms`)

    // The ControlMaster socket must now exist in /tmp.
    // ControlPath=/tmp/atelier-ssh-%C — %C is OpenSSH's SHA1 hash of the
    // connection parameters, so the file name is a hex string.
    const socketsAfter = readdirSync('/tmp').filter((f) => f.startsWith('atelier-ssh-'))
    log(`SSH ControlMaster: sockets in /tmp after connect: ${socketsAfter.join(', ')}`)
    expect(
      socketsAfter.length,
      'ControlMaster socket must be present in /tmp — SSH_MUX_OPTS not applied if missing'
    ).toBeGreaterThan(0)

    // Switch to another session, then come back — the terminal must reconnect
    // immediately via the ControlMaster socket. Without it, the reconnect
    // requires 3 fresh SSH handshakes (~4.5s each = 13s total), which would
    // blow the 6s poll timeout below.
    await page.locator(`[data-testid="session-row"]:not([data-session-id="${devpodSessionId}"])`).first().click()
    await page.waitForTimeout(800) // let ptyKill + tmux detach-client fire

    const tReconnect = Date.now()
    await devpodRow.click()
    await expect(page.getByTestId('terminal-body')).toBeVisible({ timeout: 10_000 })
    // The tmux session on the devpod is still alive — its scrollback buffer
    // (including the marker echo from before) must appear immediately after
    // reattach. A 6s timeout fits ControlMaster reconnect (<1s) but not a
    // cold-handshake reconnect (~13s).
    await expect.poll(
      async () => page.getByTestId('terminal-body').textContent(),
      { timeout: 6_000 }
    ).toContain(marker)
    log(`SSH ControlMaster: reconnect showed tmux content in ${Date.now() - tReconnect}ms`)

    await page.screenshot({ path: join(artifactsDir, '07-ssh-controlmaster.png') })
  })
})

test.describe('07-secondary-panels (session profile files tree)', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  const profileId = 'e2e-profile-multi-root'

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-profile-files-'))
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-profile-project-'))
    for (const sub of ['src', 'Features', 'docs', 'e2e']) {
      mkdirSync(join(projectDir, sub), { recursive: true })
      writeFileSync(join(projectDir, sub, 'marker.txt'), `${sub}\n`)
    }
    seedSkipOnboarding(userDataDir)
    seedE2eConfig(userDataDir, {
      sessionProfiles: [
        {
          id: profileId,
          name: 'Multi-root profile',
          workspace: projectDir,
          fileDirectories: ['src', 'Features', 'docs', 'e2e']
        }
      ]
    })
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('Files tab lists profile file directories as multi-root tree', async () => {
    test.setTimeout(120_000)
    await expect
      .poll(async () => {
        const profiles = await page.evaluate(async () => {
          const c = await window.atelier.getConfig()
          return c.sessionProfiles ?? []
        })
        return profiles.some((p: { id: string }) => p.id === profileId)
      })
      .toBe(true)

    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('project-path').focus()
    const profileRow = page.locator(`[data-testid="project-path-suggestion-profile-${profileId}"]`)
    await expect(profileRow).toBeVisible({ timeout: 10_000 })
    await profileRow.click()
    await expect(page.getByTestId('project-path')).toHaveClass(/profile-selected/)
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    const sessionRow = page.locator('[data-testid="session-row"]').first()
    await expect(sessionRow).toBeVisible({ timeout: 15_000 })
    const sessionId = (await sessionRow.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect
      .poll(async () => {
        const rows = await page.evaluate(
          async ({ id }) => window.atelier.debugQueryDb<{ profile_id: string | null }>(
            'SELECT profile_id FROM sessions WHERE id = ?',
            [id]
          ),
          { id: sessionId }
        )
        return rows[0]?.profile_id
      })
      .toBe(profileId)

    await expect
      .poll(async () => sessionRow.getAttribute('data-status'), { timeout: 90_000 })
      .not.toMatch(/connecting|creating-worktree/)

    await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 10_000 })
    await page.getByTestId('tab-files').click()
    await expect(page.getByTestId('files-tree')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('files-profile-bar')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('files-profile-bar')).toContainText('Multi-root profile')
    await expect(page.locator('[data-testid="files-tree-root"]')).toHaveCount(4)
    const tree = page.getByTestId('files-tree')
    await expect(tree).toContainText('src')
    await expect(tree).toContainText('Features')
    await expect(tree).toContainText('docs')
    await expect(tree).toContainText('e2e')
    await expect(tree).toContainText('marker.txt')
    await page.screenshot({ path: join(artifactsDir, '07-profile-files-multi-root.png') })

    const location = page.getByTestId('files-location-input')
    const workspaceRoot = await location.inputValue()
    await location.click()
    await location.fill(`${workspaceRoot}/src/marker.txt`)
    await location.press('Enter')
    await expect(page.getByTestId('files-editor-tab')).toHaveCount(1)
    await expect(location).toHaveValue(`${workspaceRoot}/src/marker.txt`)
    await expect(page.locator('[data-testid="file-tree-file"][data-path="src/marker.txt"]')).toHaveClass(/active/)
    log('files panel: profile session location bar opens file by absolute path OK')
  })
})

