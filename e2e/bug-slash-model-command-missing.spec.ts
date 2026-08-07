import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Fix verification for "fix-slash-model-command-missing" (bug #56).
 *
 * User's real-world report: typing `/model` fully and pressing Enter sent it
 * as a literal chat message and produced no response, because `/model`
 * wasn't in `Composer.tsx`'s old hardcoded `slashCommands` array (`/clear`,
 * `/interrupt`, `/fork` only) — a token with no popover match at Enter time
 * just falls through to the ordinary `handleSend()` path and gets posted as
 * real user-message text via `session:sendMessage`.
 *
 * Fix: `/model` is now one of Composer.tsx's four LOCAL intercepted
 * commands (`/clear`, `/interrupt`, `/fork`, `/model`) — selecting it (by
 * clicking the popover item OR by typing the command in full and pressing
 * Enter/Tab without ever opening/clicking anything in the popover) opens the
 * real `ModelPicker` popover instead of ever reaching `onSend`/
 * `session:sendMessage`. `ModelPicker`'s own `open` state was lifted up into
 * `Composer` for exactly this purpose (see `Composer.tsx`'s `modelPickerOpen`
 * state and the `ModelPicker`'s `open`/`onOpenChange` props).
 *
 * Trace confirming there's no separate "typed-in-full-then-Enter doesn't
 * match" bug to fix beyond just adding `/model` to the array: `slashMatches`
 * filters `slashCommands` by `cmd.slice(1).startsWith(query)`, and
 * `handleKeyDown`'s Enter/Tab branch already selects `activeMatches[
 * selectedIndex]` (default 0) whenever `activeMatches.length > 0` —
 * regardless of whether the query is a partial or an exact/full match. So
 * once `/model` is a real entry in the array, typing it out fully still
 * matches by prefix (itself) and Enter already selects+runs it via the SAME
 * mechanism the 3 pre-existing commands already used; no additional keydown
 * logic was needed. This spec exercises BOTH interaction paths for real to
 * prove that trace is correct, not just plausible.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

mkdirSync(artifactsDir, { recursive: true })

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

/** Every persisted message row for `sessionId` whose content is literally "/model" — the exact regression this bug reported (real user-message text instead of a local action). Zero rows both before and after each scenario proves it was never sent. */
async function literalModelMessageCount(page: Page, sessionId: string): Promise<number> {
  const rows = await page.evaluate(
    (sid) =>
      window.atelier.debugQueryDb<{ id: number }>(
        "SELECT id FROM messages WHERE session_id = ? AND role = 'user' AND content = '/model'",
        [sid]
      ),
    sessionId
  )
  return rows.length
}

test.describe.configure({ mode: 'serial' })

test.describe('bug-fix: /model is intercepted locally (opens ModelPicker), never sent as literal text', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let sessionId: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-slash-model-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-slash-model-project-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('setup: create a real claude-code session', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    await stubProjectFolder(electronApp, projectDir)
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: READY.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30_000 })
  })

  test('scenario A: clicking "/model" in the popover opens ModelPicker, never sends', async () => {
    expect(await literalModelMessageCount(page, sessionId)).toBe(0)

    const textarea = page.getByTestId('composer-input')
    await textarea.click()
    await textarea.type('/model')

    const slashPopover = page.getByTestId('slash-popover')
    await expect(slashPopover).toBeVisible()
    await page.locator('[data-testid="slash-item"][data-command="/model"]').click()

    await expect(slashPopover).toHaveCount(0)
    await expect(textarea).toHaveValue('')

    // The REAL ModelPicker popover opened — same one the footer button opens.
    await expect(page.getByTestId('model-picker-popover')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, 'bug-slash-model-popover-click.png') })

    // Close it back out and confirm nothing was ever sent as literal text.
    await page.mouse.click(20, 20)
    await expect(page.getByTestId('model-picker-popover')).toHaveCount(0)
    expect(await literalModelMessageCount(page, sessionId)).toBe(0)
  })

  test('scenario B: typing "/model" in FULL and pressing Enter (no popover click) opens ModelPicker, never sends', async () => {
    expect(await literalModelMessageCount(page, sessionId)).toBe(0)

    const textarea = page.getByTestId('composer-input')
    await textarea.click()
    await textarea.type('/model')
    await expect(page.getByTestId('slash-popover')).toBeVisible()

    // Enter directly — no mousedown/click on any popover item at all. This
    // is the EXACT scenario from the user's original report.
    await textarea.press('Enter')

    await expect(page.getByTestId('slash-popover')).toHaveCount(0)
    await expect(textarea).toHaveValue('')
    await expect(page.getByTestId('model-picker-popover')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, 'bug-slash-model-typed-enter.png') })

    await page.mouse.click(20, 20)
    await expect(page.getByTestId('model-picker-popover')).toHaveCount(0)

    // The definitive regression check: no message row with literal "/model"
    // content was ever persisted for this session.
    expect(await literalModelMessageCount(page, sessionId)).toBe(0)
  })
})
