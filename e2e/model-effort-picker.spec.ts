import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/**
 * Every `session_started` log line for `sessionId`, in emission order, each
 * with the REAL model the SDK's own `system`/`init` message reported for
 * that connection (`SessionManager.applyEvent`'s `case 'session_started'`
 * logs exactly this — see manager.ts) — the ground truth for "did the
 * picker's selection actually reach the SDK", independent of what the
 * composer merely asked for.
 */
function sessionStartedModels(logPath: string, sessionId: string): string[] {
  const raw = readFileSync(logPath, 'utf-8')
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.msg === 'harness event: session_started' && e.sessionId === sessionId)
    .map((e) => e.model as string)
}

test.describe.configure({ mode: 'serial' })

test.describe('10f-enrichment-model-effort-picker', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let sessionId: string
  let logPath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-model-picker-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-model-picker-project-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    logPath = await page.evaluate(() => window.atelier.getLogFilePath())
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('picker control matches the mock: "Model · Effort ▾" footer button + dropdown', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: READY.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    // Wait for the initial turn (default model, no override) to finish.
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 30_000 })

    const pickerButton = page.getByTestId('model-picker-button')
    await expect(pickerButton).toBeVisible()
    await expect(pickerButton).toHaveText(/.+·.+▾/)

    await pickerButton.click()
    const popover = page.getByTestId('model-picker-popover')
    await expect(popover).toBeVisible()
    await expect(popover.getByText('Model', { exact: true })).toBeVisible()
    await expect(popover.getByText('Effort', { exact: true })).toBeVisible()
    await expect(page.getByTestId('model-option-claude-opus-4-8')).toBeVisible()
    await expect(page.getByTestId('model-option-claude-sonnet-5')).toBeVisible()
    await expect(page.getByTestId('model-option-claude-haiku-4-5')).toBeVisible()
    await expect(page.getByTestId('effort-option-low')).toBeVisible()
    await expect(page.getByTestId('effort-option-medium')).toBeVisible()
    await expect(page.getByTestId('effort-option-high')).toBeVisible()

    await page.screenshot({ path: join(artifactsDir, '10f-model-picker.png') })

    // Click outside closes it without changing anything.
    await page.mouse.click(20, 20)
    await expect(popover).toHaveCount(0)
  })

  test('changing the picker selection changes what the NEXT real SDK call uses, not the current turn', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)

    // Turn 1 (from the previous test's session creation) already completed
    // with the app's default model (claude-sonnet-5, per App.tsx's
    // `modelSelection` initial state / the harness's own DEFAULT_MODEL
    // fallback) — capture that as the baseline.
    const beforeChange = sessionStartedModels(logPath, sessionId)
    expect(beforeChange.length).toBeGreaterThanOrEqual(1)
    const defaultModel = beforeChange[0]
    expect(defaultModel).toBe('claude-sonnet-5')

    // Change the selection to Opus 4.8 · Medium via the real picker UI —
    // deliberately a DIFFERENT model than the default above, so this test
    // actually proves the picker changes the model rather than picking the
    // same value the default already resolves to.
    await page.getByTestId('model-picker-button').click()
    await expect(page.getByTestId('model-picker-popover')).toBeVisible()
    await page.getByTestId('model-option-claude-opus-4-8').click()
    await expect(page.getByTestId('model-picker-popover')).toHaveCount(0)
    await expect(page.getByTestId('model-picker-button')).toHaveText(/Opus 4.8 · High ▾/)

    await page.getByTestId('model-picker-button').click()
    await page.getByTestId('effort-option-medium').click()
    await expect(page.getByTestId('model-picker-button')).toHaveText(/Opus 4.8 · Medium ▾/)

    // The change must NOT touch the turn already completed — no new
    // session_started line should appear just from picking a value.
    expect(sessionStartedModels(logPath, sessionId).length).toBe(beforeChange.length)

    // Send the follow-up: this is the turn that should actually run under
    // the newly-picked model.
    const textarea = page.getByTestId('composer-input')
    await textarea.fill('Reply with exactly: SECONDTURN.')
    await textarea.press('Enter')

    // Wait for this second real SDK turn to fully finish.
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 60_000 })

    await expect
      .poll(async () => sessionStartedModels(logPath, sessionId).length, { timeout: 10_000 })
      .toBeGreaterThan(beforeChange.length)

    const afterChange = sessionStartedModels(logPath, sessionId)
    const secondCallModel = afterChange[afterChange.length - 1]

    // Real, ground-truth proof: the SDK's own reported model for the SECOND
    // connection is the one just picked, and differs from turn 1's.
    expect(secondCallModel).toBe('claude-opus-4-8')
    expect(secondCallModel).not.toBe(defaultModel)

    // The assistant actually replied under this new connection — not a
    // silently-dropped/failed reconnect.
    const assistantRows = await page.evaluate(
      (id) =>
        window.atelier.debugQueryDb<{ content: string }>(
          "SELECT content FROM messages WHERE session_id = ? AND role='assistant' AND content NOT LIKE '{%' ORDER BY id ASC",
          [id]
        ),
      sessionId
    )
    const combinedAssistantText = assistantRows.map((r) => r.content).join('\n')
    expect(combinedAssistantText).toMatch(/SECONDTURN/)

    // The main-process log shows the forced-reconnect path was taken
    // (not the fast streamInput-only path), proving this went through a
    // fresh start()/resume() call the way HarnessStartOptions requires for
    // model/effort to actually change.
    const rawLog = readFileSync(logPath, 'utf-8')
    expect(rawLog).toMatch(/sendUserMessage: model\/effort selection changed, applying from next turn/)

    await page.screenshot({ path: join(artifactsDir, '10f-model-picker-after-change.png') })
  })

  test('/model <model-id> slash command force-switches to a real-but-uncurated model, validated against the live SDK', async ({}, testInfo) => {
    testInfo.setTimeout(60_000)

    const pickerButton = page.getByTestId('model-picker-button')
    const textarea = page.getByTestId('composer-input')

    // `claude-sonnet-4-6[1m]` is a real, currently-accepted model (verified
    // via a direct `Query.setModel()` probe) that is deliberately NOT in the
    // small curated `MODEL_OPTIONS` picker list (see its doc comment) —
    // this proves the fix's live-validation path (bug-model-command-
    // rejects-invalid) still allows a genuine power-user override, not just
    // the curated set.
    //
    // Type `/model claude-sonnet-4-6[1m]` and press Enter — the popover closes
    // after the space (current word is no longer a slash token), so Enter
    // should go through handleSend's interception path, not selectSlash().
    await textarea.fill('/model claude-sonnet-4-6[1m]')
    await textarea.press('Enter')

    // Picker popover must NOT have opened — this is a direct set, not "open picker".
    await expect(page.getByTestId('model-picker-popover')).toHaveCount(0)

    // Composer input must be cleared (the command was consumed).
    await expect(textarea).toHaveValue('')

    // The model chip must reflect the forced model ID as its label (not fall
    // back to "Opus 4.8" — the first-option default for unknown IDs).
    await expect(pickerButton).toHaveText(/claude-sonnet-4\-6\[1m\] · /)

    await page.screenshot({ path: join(artifactsDir, '10f-model-slash-force-switch.png') })

    // Send a real turn under the forced model and verify it actually reaches
    // the SDK — same ground-truth log-grep pattern as the picker test above.
    const beforeSwitch = sessionStartedModels(logPath, sessionId)
    await textarea.fill('Reply with exactly: FORCEDMODEL.')
    await textarea.press('Enter')
    await expect(pickerButton).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 60_000 })

    await expect
      .poll(async () => sessionStartedModels(logPath, sessionId).length, { timeout: 10_000 })
      .toBeGreaterThan(beforeSwitch.length)

    const afterSwitch = sessionStartedModels(logPath, sessionId)
    expect(afterSwitch[afterSwitch.length - 1]).toBe('claude-sonnet-4-6[1m]')

    await page.screenshot({ path: join(artifactsDir, '10f-model-slash-after-turn.png') })
  })

  test('bug-fix: /model <bad-id> is rejected via live SDK validation, pill unchanged, error shown in chat', async ({}, testInfo) => {
    testInfo.setTimeout(60_000)

    const pickerButton = page.getByTestId('model-picker-button')
    const textarea = page.getByTestId('composer-input')

    // Baseline: whatever the pill shows right now (claude-sonnet-4-6[1m] ·
    // High, from the previous test) — this MUST be unchanged after the
    // rejection below, proving the bogus id never got applied.
    const beforeText = await pickerButton.textContent()
    const beforeSessionStarts = sessionStartedModels(logPath, sessionId).length

    await textarea.fill('/model aaa')
    await textarea.press('Enter')

    // Popover must not open, composer must clear (command consumed either way).
    await expect(page.getByTestId('model-picker-popover')).toHaveCount(0)
    await expect(textarea).toHaveValue('')

    // The pill must NOT change to "aaa" — this is the exact bug being fixed.
    await expect(pickerButton).toHaveText(beforeText ?? /.+/)

    // A rejection message appears in the chat panel (reuses the existing
    // `role: 'system'` transcript row type — see ChatTranscript.tsx).
    const systemRow = page.locator('[data-testid="transcript-message"][data-role="system"]').last()
    await expect(systemRow).toBeVisible()
    await expect(systemRow).toContainText('Unknown model "aaa"')

    await page.screenshot({ path: join(artifactsDir, '10f-model-slash-invalid-rejected.png') })

    // No new SDK session/turn was ever started just from the rejected command.
    expect(sessionStartedModels(logPath, sessionId).length).toBe(beforeSessionStarts)
  })
})

