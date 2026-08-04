import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Regression coverage for two bugs reported together against the "Proposed
 * plan" card (see PlanProposedCard.tsx):
 *
 * 1. Markdown not rendered: the card's old hand-rolled `renderPlanBody()`
 *    only understood `#`/`##`/`###` headings and `1. `-numbered lists —
 *    `**bold**`/`` `code` `` leaked through as literal characters. Fixed by
 *    switching to the same `react-markdown` + `remark-gfm` pipeline
 *    `MarkdownMessage.tsx` already uses for assistant text.
 * 2. Accept/Allow buttons silently doing nothing: root-caused (via live
 *    reproduction, see git history) to a turn ending in error while a
 *    permission/plan/ask-question prompt was still unanswered —
 *    `SessionManager` never marked the abandoned prompt as resolved, so its
 *    card stayed rendered as `pending` (fully clickable) forever, and
 *    responding to it threw "Unknown or already-resolved prompt" — silently,
 *    since the only call site discarded the promise with `void` and had no
 *    `catch`. Fixed by expiring abandoned prompts (`status: 'expired'`) when
 *    `SessionManager`'s `result` handler sees `event.isError`, and by no
 *    longer swallowing `respondToPrompt` rejections.
 *
 * Forcing the SDK's real `result` event to land with `isError: true` while a
 * prompt is still pending isn't something this suite can trigger
 * deterministically without faking SDK internals (CLAUDE.md: no mocking,
 * ever) — the harness only reports it when the real model/API genuinely
 * errors out mid-turn. That exact race is what the pre-existing (flaky by
 * model non-determination) "Plan mode: ...Accept exits plan mode..." test in
 * interactive-prompts.spec.ts occasionally hits. Instead, this spec proves
 * the FIX's observable contract deterministically: it drives a REAL plan
 * card into existence via the real SDK, then flips its ALREADY-REAL,
 * ALREADY-PERSISTED message row to `status: 'expired'` via the same
 * `debug:execDb` test-only channel `bug-session-cost-historical-backfill.spec.ts`
 * already uses to seed/verify DB state directly — i.e. exactly the mutation
 * `SessionManager.expirePendingPrompts` performs — then reloads the app (a
 * real remount reading the real on-disk SQLite DB, no mock) and asserts the
 * card renders the expired state with no dead action buttons.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

function configPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config.json')
}

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(configPath(userDataDir), JSON.stringify({ onboardingCompleted: true }))
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function stubProjectFolder(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folderPath] })) as typeof dialog.showOpenDialog
  }, path)
}

async function queryDb<T>(activePage: Page, sql: string, params: unknown[] = []): Promise<T[]> {
  return activePage.evaluate(({ sql: query, params: bindings }) => window.gardenia.debugQueryDb<T>(query, bindings), {
    sql,
    params
  })
}

async function execDb(activePage: Page, sql: string, params: unknown[] = []): Promise<void> {
  await activePage.evaluate(({ sql: query, params: bindings }) => window.gardenia.debugExecDb(query, bindings), {
    sql,
    params
  })
}

test('bug-repro: plan card renders real markdown, and an expired prompt shows a note with no dead buttons', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-plan-expiry-'))
  seedSkipOnboarding(userDataDir)
  const projectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-plan-expiry-project-'))
  writeFileSync(join(projectDir, 'README.md'), '# test project\n')

  const { app: electronApp, page } = await launchApp(userDataDir)
  try {
    await stubProjectFolder(electronApp, projectDir)
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('plan-mode-checkbox').check()
    await page.getByTestId('initial-prompt').fill(
      'Propose a plan (via ExitPlanMode, do not call any other tool first) to create a file. ' +
        'In the plan text itself, use real Markdown: a heading, a numbered list, at least one **bold** phrase, ' +
        'and at least one `inline code` span naming the file. Keep it short.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string

    const planCard = page.getByTestId('plan-card').first()
    await expect(planCard).toBeVisible({ timeout: 45_000 })
    const planBody = planCard.getByTestId('plan-body')

    // Bug 1: markdown must render as real elements, not literal ** / ` characters.
    await expect(planBody.locator('strong')).not.toHaveCount(0)
    await expect(planBody.locator('code')).not.toHaveCount(0)
    await expect(planBody).not.toContainText('**')
    const bodyText = (await planBody.innerText()).trim()
    expect(bodyText.includes('`')).toBe(false)

    await page.screenshot({ path: join(artifactsDir, 'bug-plan-card-markdown-rendered.png') })

    // Bug 3: non-heading plan-body text (paragraphs/list items/code) must
    // match the chat transcript's own message font size (`--font-agent-
    // message-size`), not a different, larger token — headings are exempt
    // (they're deliberately bigger for emphasis, same as `.msg-assistant`'s
    // own markdown headings).
    const chatFontSize = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--font-agent-message-size').trim()
    )
    const planListItemFontSize = await planBody.locator('li').first().evaluate((el) => getComputedStyle(el).fontSize)
    expect(planListItemFontSize).toBe(chatFontSize)

    // Bug 2 (expiry contract): flip the real, already-persisted plan message
    // to the exact state SessionManager.expirePendingPrompts produces for an
    // abandoned prompt, then reload and confirm the card reflects it.
    const rows = await queryDb<{ id: number; content: string }>(
      page,
      "SELECT id, content FROM messages WHERE session_id = ? AND content LIKE '%plan_proposed%' ORDER BY id DESC LIMIT 1",
      [sessionId]
    )
    expect(rows.length).toBe(1)
    const parsed = JSON.parse(rows[0].content) as { status: string }
    expect(parsed.status).toBe('pending')
    const expiredContent = JSON.stringify({ ...parsed, status: 'expired' })
    await execDb(page, 'UPDATE messages SET content = ? WHERE id = ?', [expiredContent, rows[0].id])

    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()

    const reloadedCard = page.getByTestId('plan-card').first()
    await expect(reloadedCard).toBeVisible({ timeout: 15_000 })
    await expect(reloadedCard).toHaveAttribute('data-status', 'expired')
    await expect(reloadedCard.getByTestId('plan-resolved-note')).toContainText('expired')
    await expect(reloadedCard.getByTestId('plan-actions')).not.toBeVisible()

    await page.screenshot({ path: join(artifactsDir, 'bug-plan-card-expired-note.png') })
  } finally {
    await electronApp.close().catch(() => undefined)
  }
})
