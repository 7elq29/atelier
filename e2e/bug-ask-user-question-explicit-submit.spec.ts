import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reproduction for "fix-ask-user-question-explicit-submit".
 *
 * Root cause (verified against current main):
 * `AskUserQuestionCard.tsx`'s `pickOption` (lines ~42-50) calls `submit()`
 * the instant every question has an answer picked — for the common
 * single-question card (the only shape the real e2e prompt below uses),
 * that means the FIRST click submits immediately, with no confirm step and
 * no chance to change your mind before it's sent to the SDK.
 *
 * This spec triggers a real ask_user_question prompt (same pattern as
 * interactive-prompts.spec.ts), clicks exactly one option, and immediately
 * (before any confirm affordance would exist) checks whether the prompt has
 * already been dispatched to the harness. DESIRED behavior: a single click
 * should only *select* the option, requiring an explicit confirm/submit
 * step — so immediately after the click, the card should still be
 * `data-status="pending"` and no `respondToPrompt` log line should exist
 * yet. This fails today because pickOption submits synchronously on click.
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

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe('bug-repro: AskUserQuestionCard submits instantly on first click, no confirm step', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-aq-submit-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-aq-submit-project-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('clicking one option on a single-question card should NOT submit immediately', async ({}, testInfo) => {
    testInfo.setTimeout(60_000)
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use the AskUserQuestion tool right now to ask me exactly one question: "Which fruit do you prefer?" ' +
        'with header "Fruit" and exactly two options: "Apple" and "Banana". Do not do anything else first. ' +
        'Wait for my answer.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string

    const card = page.getByTestId('ask-user-question-card')
    await expect(card).toBeVisible({ timeout: 30_000 })
    await expect(card).toHaveAttribute('data-status', 'pending')

    const logPath = await page.evaluate(() => window.gardenia.getLogFilePath())
    const logBeforeClick = readFileSync(logPath, 'utf-8')
    expect(logBeforeClick).not.toContain('respondToPrompt: dispatching to harness')

    const appleOption = card.getByTestId('aq-option').filter({ hasText: 'Apple' })
    await appleOption.click()

    await page.screenshot({ path: join(artifactsDir, 'fix-ask-user-question-explicit-submit.png') })

    // DESIRED: a single click only selects — the card should still be
    // pending, and no respondToPrompt IPC call should have fired yet, until
    // an explicit confirm/submit action. Today's pickOption submits
    // synchronously on this very click, so both assertions below fail.
    await expect(card).toHaveAttribute('data-status', 'pending')
    const logAfterClick = readFileSync(logPath, 'utf-8')
    expect(logAfterClick).not.toContain(`respondToPrompt: dispatching to harness","sessionId":"${sessionId}"`)

    // Explicit Submit click is required to actually dispatch the answer.
    const submitButton = card.getByTestId('aq-submit')
    await expect(submitButton).toBeEnabled()
    await submitButton.click()

    await expect(card).toHaveAttribute('data-status', 'answered', { timeout: 15_000 })
    await page.screenshot({ path: join(artifactsDir, 'fix-ask-user-question-explicit-submit-after-submit.png') })

    const logAfterSubmit = readFileSync(logPath, 'utf-8')
    expect(logAfterSubmit).toContain(`respondToPrompt: dispatching to harness","sessionId":"${sessionId}"`)
  })
})
