import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 11-composer-mode-indicator: the always-visible mode pill under the
 * composer input, cycled via Shift+Tab (or a click on the pill) through
 * default -> plan -> acceptEdits -> auto -> default, per
 * Features/11-composer-mode-indicator/spec.md.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

mkdirSync(artifactsDir, { recursive: true })

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

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.describe('11-composer-mode-indicator', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-mode-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-mode-project-'))
    writeFileSync(join(projectDir, 'README.md'), '# test project\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 1. Always visible, defaults to Default ────────────────────────────
  test('mode pill is visible under the composer on a fresh session, defaults to Default', async () => {
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })

    const pill = page.getByTestId('composer-mode-pill')
    await expect(pill).toBeVisible()
    await expect(pill).toHaveAttribute('data-mode', 'default')
    await expect(pill).toContainText('Default')
    await expect(pill).toHaveAttribute('title', 'Click or press Shift+Tab to cycle mode')

    await page.screenshot({ path: join(artifactsDir, '11-mode-default.png') })
  })

  // ── 2. Shift+Tab cycles through all 4 states in order, loops back ─────
  test('Shift+Tab (composer focused) cycles default -> plan -> acceptEdits -> auto -> default', async () => {
    const pill = page.getByTestId('composer-mode-pill')
    const input = page.getByTestId('composer-input')
    await input.click()

    await input.press('Shift+Tab')
    await expect(pill).toHaveAttribute('data-mode', 'plan')
    await expect(pill).toContainText('Plan mode')
    await page.screenshot({ path: join(artifactsDir, '11-mode-plan.png') })

    await input.press('Shift+Tab')
    await expect(pill).toHaveAttribute('data-mode', 'acceptEdits')
    await expect(pill).toContainText('Accept edits')
    await page.screenshot({ path: join(artifactsDir, '11-mode-acceptedits.png') })

    await input.press('Shift+Tab')
    await expect(pill).toHaveAttribute('data-mode', 'auto')
    await expect(pill).toContainText('Auto')
    await page.screenshot({ path: join(artifactsDir, '11-mode-auto.png') })

    // Loops back to default after the 4th press.
    await input.press('Shift+Tab')
    await expect(pill).toHaveAttribute('data-mode', 'default')
    await expect(pill).toContainText('Default')
  })

  // ── 3. Clicking the pill also cycles it ────────────────────────────────
  test('clicking the mode pill cycles it (same as Shift+Tab)', async () => {
    const pill = page.getByTestId('composer-mode-pill')
    await expect(pill).toHaveAttribute('data-mode', 'default')

    await pill.click()
    await expect(pill).toHaveAttribute('data-mode', 'plan')
    await expect(pill).toContainText('Plan mode')

    // Reset back to default via a second click, so the next test starts clean.
    await pill.click()
    await expect(pill).toHaveAttribute('data-mode', 'acceptEdits')
  })

  // ── 4. Mode persists after sending a message, across a live reconnect ─
  // Same pattern as interactive-prompts.spec.ts's plan-mode persistence:
  // the tracked mode survives the harness `resume()`/follow-up reconnect
  // mechanism SessionManager already used for plan mode (not a full app
  // relaunch — see SessionManager.permissionModes' doc comment: mode is
  // tracked in-memory, exactly like the pre-existing plan-mode tracking
  // this generalizes, so it is NOT expected to survive a genuine Electron
  // process relaunch any more than plan mode itself was before this task).
  test('mode persists after sending a message and across a session close+resume within the same app run', async () => {
    const pill = page.getByTestId('composer-mode-pill')
    const row = page.locator('[data-testid="session-row"]').first()
    const sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    // Get to a known, non-default mode: acceptEdits (left there by test 3 above).
    await expect(pill).toHaveAttribute('data-mode', 'acceptEdits')

    await page.getByTestId('composer-input').fill('Say exactly: mode-persist-ack')
    await page.getByTestId('send-button').click()

    await expect
      .poll(async () => {
        const rows = await page.evaluate(
          (id) =>
            window.gardenia.debugQueryDb<{ c: number }>(
              "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role='assistant' AND content LIKE '%mode-persist-ack%'",
              [id]
            ),
          sessionId
        )
        return rows[0]?.c ?? 0
      }, { timeout: 30_000 })
      .toBeGreaterThan(0)

    // The mode pill must still show acceptEdits after the real turn completed.
    await expect(pill).toHaveAttribute('data-mode', 'acceptEdits')

    // Close and resume the session (same in-app-run reconnect mechanism as
    // the pre-existing plan-mode persistence tests) — mode must still show
    // acceptEdits, not have reset to default.
    await row.getByTestId('session-menu-button').click()
    await row.getByTestId('menu-close').click()
    const historyRow = page.locator(`[data-group="history"] [data-session-id="${sessionId}"]`)
    await expect(historyRow).toBeVisible({ timeout: 10_000 })
    await historyRow.getByTestId('resume-button').click()

    const activeRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
    await expect(activeRow).toBeVisible({ timeout: 10_000 })
    await expect(pill).toHaveAttribute('data-mode', 'acceptEdits', { timeout: 10_000 })
    await expect(pill).toContainText('Accept edits')
  })

  // ── 5. "Start in plan mode" checkbox starts the pill in Plan mode ──────
  test('a session created with "Start in plan mode" checked starts showing Plan mode, not Default', async () => {
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('plan-mode-checkbox').check()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first();
    await expect(row).toBeVisible({ timeout: 15_000 })

    const pill = page.getByTestId('composer-mode-pill')
    await expect(pill).toHaveAttribute('data-mode', 'plan', { timeout: 10_000 })
    await expect(pill).toContainText('Plan mode')

    await page.screenshot({ path: join(artifactsDir, '11-mode-planmode-checkbox-start.png') })
  })
})
