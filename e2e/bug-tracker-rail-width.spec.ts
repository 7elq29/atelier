import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reproduction for "fix-tracker-rail-width-vs-mock" (also covers the report
 * line "Make todo and subagents smaller").
 *
 * Root cause (verified against current main):
 * `src/renderer/src/styles/global.css` line ~816: `.tracker-rail { width:
 * 290px; }`. The authoritative reference,
 * `Features/UI-Design/mocks/design-variants/variant-1-soft-paper.html` line
 * ~89, sizes the equivalent rail at `.rail { width: 244px; }` — 46px
 * narrower. This spec populates the TrackerRail with real todos (via a real
 * SDK TodoWrite call, same pattern as chat-surface-core.spec.ts) and a real
 * subagent (via a real Task-tool call), then asserts the rendered rail's
 * computed width is close to the mock's 244px. It fails today (290px).
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

// Target from the authoritative mock (variant-1-soft-paper.html:89, `.rail { width: 244px; }`).
const MOCK_RAIL_WIDTH_PX = 244
// Small slack for box-sizing/scrollbar rounding; still far below today's 290px.
const ALLOWED_SLACK_PX = 8

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
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

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe('bug-repro: tracker rail is 290px wide, mock specifies 244px', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-rail-width-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-rail-width-project-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('rendered .tracker-rail width should be close to the mock (244px), currently 290px', async ({}, testInfo) => {
    testInfo.setTimeout(150_000)
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use the TodoWrite tool now to create a todo list with exactly two items: "Step one" (in_progress) and ' +
        '"Step two" (pending). Then use the Task tool to spawn exactly one general-purpose subagent with the ' +
        'instruction "Reply with exactly: SUBDONE" and wait for it to report back. Then reply with one sentence.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })

    const rail = page.getByTestId('tracker-rail')
    await expect(rail).toBeVisible({ timeout: 15_000 })

    // Wait for real content to populate the rail (todo card is required;
    // the subagent/Task card is best-effort — the model doesn't always
    // choose to spawn one even when asked, and this bug is about rail
    // WIDTH, not about forcing a specific tool-call sequence, so we don't
    // fail the whole repro over that nondeterminism. "As close as
    // achievable with a real SDK call" per the task brief.)
    await expect(page.getByTestId('todo-tracker-card')).toBeVisible({ timeout: 30_000 })
    const taskCardAppeared = await page
      .locator('[data-testid="tool-card"][data-tool-name="Task"]')
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false)
    // eslint-disable-next-line no-console
    console.log(`[fix-tracker-rail-width-vs-mock] subagent Task card appeared: ${taskCardAppeared}`)

    const railWidth = await rail.evaluate((el) => el.getBoundingClientRect().width)

    await page.screenshot({ path: join(artifactsDir, 'fix-tracker-rail-width-vs-mock.png') })

    // This is the assertion that should currently FAIL: today's CSS renders
    // ~290px, well outside 244px + slack.
    expect(railWidth).toBeLessThanOrEqual(MOCK_RAIL_WIDTH_PX + ALLOWED_SLACK_PX)
  })
})
