/**
 * Repro: clicking a standalone file in the chat Bookmarks list replaced Chat with the Files
 * tab. File bookmarks are review context, so they should keep Chat visible and open the file in
 * the existing right-hand ResponseReviewPanel, matching changed-file bookmarks.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atelier-bookmark-right-panel-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'E2E'], { cwd: dir })
  writeFileSync(join(dir, 'bookmarked.md'), '# Bookmarked file\n\nPreview me on the right.\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: dir })
  return dir
}

test('standalone file bookmark opens in the right review panel, not Files', async () => {
  test.setTimeout(120_000)
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-bookmark-right-panel-profile-'))
  mkdirSync(userDataDir, { recursive: true })
  seedSkipOnboarding(userDataDir)
  const repoDir = fixtureRepo()
  const filePath = join(repoDir, 'bookmarked.md')

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot
  })
  const page = await app.firstWindow()
  try {
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('new-session-button')).toBeVisible({ timeout: 20_000 })

    const session = await page.evaluate((projectPath) =>
      window.atelier.createSession({
        projectPath,
        mode: 'claude-code',
        hostId: 'local',
        suggestedName: 'Bookmark preview',
        initialPrompt: 'Reply with exactly READY and do not use tools.'
      }), repoDir)

    const row = page.locator(`[data-testid="session-row"][data-session-id="${session.id}"]`)
    await expect(row).toBeVisible({ timeout: 20_000 })
    await row.click()
    await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 30_000 })

    await page.evaluate(
      ({ sessionId, target }) =>
        window.atelier.addSessionBookmark(sessionId, {
          kind: 'file',
          target,
          label: 'bookmarked.md'
        }),
      { sessionId: session.id, target: filePath }
    )

    const bookmarks = page.getByTestId('chat-changes-bookmarks')
    await expect(bookmarks).toBeVisible({ timeout: 15_000 })
    const toggle = bookmarks.locator('.chat-changes-toggle')
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
    const bookmark = bookmarks.locator(
      '[data-testid="chat-bookmark-row"][data-bookmark-kind="file"]'
    )
    await expect(bookmark).toContainText('bookmarked.md')

    await bookmark.click()
    await page.screenshot({
      path: join(artifactsDir, 'bug-bookmark-file-right-panel.png')
    })

    await expect(page.getByTestId('response-review-pane')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('response-review-pane')).toHaveAttribute(
      'data-review-kind',
      'file'
    )
    await expect(page.getByTestId('response-review-pane')).toHaveAttribute(
      'data-has-plan-diff',
      'false'
    )
    await expect(page.locator('.response-review-sub')).not.toContainText('inline diff')
    await expect(page.getByTestId('response-review-content')).toContainText('Preview me on the right.')
    await expect(
      page.getByTestId('session-workspace-tabs').locator(':scope > [data-tab="chat"]')
    ).not.toHaveClass(/\bhidden\b/)
    await expect(page.getByTestId('files-panel-active')).toHaveCount(0)

    const logPath = join(userDataDir, 'logs', 'main.log')
    await expect.poll(() => existsSync(logPath)).toBe(true)
    const log = readFileSync(logPath, 'utf8')
    expect(log).toContain('"msg":"app ready"')
    expect(log).toContain('"msg":"session:create invoked"')
    expect(log).toContain('"msg":"bookmark:file opened in review panel"')
  } finally {
    await app.close().catch(() => undefined)
  }
})
