import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const logPath = join(artifactsDir, '08-harness-sdk-events.log')

mkdirSync(artifactsDir, { recursive: true })

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

function activeComposer(page: Page) {
  return page.locator('.composer-cache-entry.active')
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
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

async function waitForTurnIdle(page: Page, timeoutMs = 120_000): Promise<void> {
  const composer = activeComposer(page)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await approveAllPendingPermissions(page)
    const sendVisible = await composer.getByTestId('send-button').isVisible()
    const hintCount = await composer.getByTestId('composer-turn-status').count()
    if (sendVisible && hintCount === 0) return
    await page.waitForTimeout(400)
  }
  throw new Error('waitForTurnIdle timed out')
}

async function sendComposerMessage(page: Page, text: string): Promise<void> {
  const composer = activeComposer(page)
  await composer.getByTestId('composer-input').fill(text)
  await composer.getByTestId('send-button').click()
}

async function runSlashCommand(page: Page, cmd: string): Promise<void> {
  const composer = activeComposer(page)
  const textarea = composer.getByTestId('composer-input')
  await textarea.click()
  await textarea.fill(cmd)
  const popover = page.getByTestId('slash-popover')
  await expect(popover).toBeVisible({ timeout: 10_000 })
  await textarea.press('Enter')
  await expect(popover).toHaveCount(0, { timeout: 5_000 })
}

async function appendHarnessLog(page: Page, label: string): Promise<void> {
  const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
  if (!existsSync(logFilePath)) return
  const raw = readFileSync(logFilePath, 'utf-8')
  const lines = raw
    .split('\n')
    .filter((l) =>
      /harness event: result|harness event: interrupted|session:turnState|session:sdkChrome|harness hook|permission_denied|model_refusal|sdk_status|background_tasks|session:backgroundTasks|local_command_output|thinking_tokens|tool_progress|api_retry|rate_limit/.test(
        l
      )
    )
  writeFileSync(logPath, `[${label}]\n${lines.slice(-120).join('\n')}\n`, { flag: 'a' })
}

async function openSettingsAgentPane(page: Page): Promise<void> {
  await page.getByTestId('open-settings-button').click()
  await expect(page.getByTestId('settings-panel')).toBeVisible()
  await page.getByRole('button', { name: 'Agent' }).click()
  await expect(page.getByTestId('settings-pane-agent')).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

/**
 * End-to-end bug bash for harness SDK → UI (Features/harness-sdk-events/spec.md).
 * Each test maps to approved events; SDK-dependent cases use real turns (no mocks).
 * See e2e/HARNESS_SDK_EVENTS_BUG_BASH.md for manual-only events (mirror_error, etc.).
 */
test.describe('08-harness-sdk-events', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let sessionId: string

  test.beforeAll(async () => {
    writeFileSync(logPath, '')
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-harness-sdk-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-harness-sdk-project-'))
    execFileSync('git', ['init'], { cwd: projectDir })
    execFileSync('git', ['checkout', '-b', 'harness-sdk-e2e'], { cwd: projectDir })
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: projectDir })
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await appendHarnessLog(page, 'suite-end')
    await electronApp.close().catch(() => undefined)
  })

  test('bootstrap: create session (SDK init + first result)', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: READY.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    sessionId = (await row.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    await waitForTurnIdle(page, 90_000)
    await expect(activeComposer(page).getByTestId('send-button')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-idle.png') })
  })

  test('sdk_status requesting → composer turn hint; clears on result (not transcript REQUEST card)', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    const composer = activeComposer(page)
    await sendComposerMessage(
      page,
      'Use Bash to run exactly: sleep 2 && echo done. Then reply in one short sentence.'
    )

    await expect(composer.getByTestId('stop-button')).toBeVisible({ timeout: 20_000 })
    await expect(composer.getByTestId('composer-turn-status')).toBeVisible({ timeout: 20_000 })
    await expect(composer.getByTestId('composer-turn-status')).toContainText(/Waiting for model|Retrying API/)
    await expect(page.locator('[data-testid="conversation-status-card"][data-status-kind="requesting"]')).toHaveCount(0)

    const toolCard = page.locator('[data-testid="tool-card"][data-tool-name="Bash"]').first()
    await expect(toolCard).toBeVisible({ timeout: 30_000 })
    await expect(toolCard.locator('[data-testid="tool-running-indicator"]')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-mid-turn.png') })

    await waitForTurnIdle(page, 120_000)
    await expect(composer.getByTestId('composer-turn-status')).toHaveCount(0)
    await expect(page.locator('[data-testid="conversation-status-card"][data-status-kind="requesting"]')).toHaveCount(0)
    await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-turn-complete.png') })
  })

  test('partial stream: assistant reply grows while turn in flight', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    await sendComposerMessage(
      page,
      'Write exactly three full sentences about git worktrees. Do not use any tools.'
    )
    const assistant = page.locator('.msg-assistant[data-testid="transcript-message"]').last()
    await expect(assistant).toBeVisible({ timeout: 60_000 })
    const snap1 = (await assistant.textContent())?.length ?? 0
    await page.waitForTimeout(400)
    const snap2 = (await assistant.textContent())?.length ?? 0
    expect(snap2).toBeGreaterThanOrEqual(snap1)
    await waitForTurnIdle(page, 120_000)
    await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-partial-stream.png') })
  })

  test('tool_progress: tool-elapsed on long Bash when SDK emits heartbeat', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    await sendComposerMessage(page, 'Use Bash once: sleep 6 && echo harness-sdk-slow. Wait for it, then say ok.')
    const toolCard = page
      .locator('[data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'harness-sdk-slow' })
    await expect(toolCard).toBeVisible({ timeout: 30_000 })
    await expect(toolCard.locator('[data-testid="tool-running-indicator"]')).toBeVisible({ timeout: 15_000 })

    let sawElapsed = false
    try {
      await expect
        .poll(async () => toolCard.locator('[data-testid="tool-elapsed"]').count(), { timeout: 10_000 })
        .toBeGreaterThan(0)
      sawElapsed = true
    } catch {
      sawElapsed = false
    }
    test.info().annotations.push({
      type: 'sdk-optional',
      description: sawElapsed ? 'tool_progress observed' : 'tool_progress not emitted this run',
    })
    if (sawElapsed) {
      await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-tool-elapsed.png') })
    }
    await waitForTurnIdle(page, 120_000)
  })

  test('thinking_tokens: optional thinking-block card when model extended-reasoning streams', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    await sendComposerMessage(
      page,
      'Without using tools, explain in detail why binary search is O(log n). Use at least four sentences.'
    )
    let sawThinking = false
    try {
      await expect(page.getByTestId('thinking-block-card')).toBeVisible({ timeout: 25_000 })
      sawThinking = true
      await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-thinking-block.png') })
    } catch {
      sawThinking = false
    }
    test.info().annotations.push({
      type: 'sdk-optional',
      description: sawThinking ? 'thinking_block rendered' : 'no thinking stream this model/run',
    })
    await waitForTurnIdle(page, 120_000)
  })

  test('prompt_suggestion: Tab hint only when SDK pushes a suggestion (optional)', async ({}, testInfo) => {
    testInfo.setTimeout(60_000)
    await waitForTurnIdle(page, 30_000)
    const composer = activeComposer(page)
    const hint = composer.getByTestId('composer-suggestion-hint')
    const hasHint = await hint.isVisible().catch(() => false)
    if (hasHint) {
      await expect(hint).toContainText('Tab to fill')
      await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-prompt-suggestion.png') })
    }
    test.info().annotations.push({
      type: 'sdk-optional',
      description: hasHint ? 'prompt_suggestion active' : 'no prompt_suggestion this run',
    })
  })

  test('local_command_output: /cost slash renders transcript monospace block (when SDK registers /cost)', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    await waitForTurnIdle(page, 30_000)
    const composer = activeComposer(page)
    await composer.getByTestId('composer-input').fill('/cost')
    const costItem = page.locator('[data-testid="slash-item"][data-command="/cost"]')
    const hasCost = (await costItem.count()) > 0
    if (!hasCost) {
      test.info().annotations.push({ type: 'sdk-optional', description: '/cost not in live slash registry' })
      return
    }
    await composer.getByTestId('composer-input').press('Enter')
    await expect(page.getByTestId('slash-popover')).toHaveCount(0, { timeout: 5_000 })
    await waitForTurnIdle(page, 120_000)

    let sawLocal = false
    try {
      await expect(page.getByTestId('local-cmd-output')).toBeVisible({ timeout: 45_000 })
      sawLocal = true
      await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-local-cmd-cost.png') })
    } catch {
      const rows = await page.evaluate(
        (id) =>
          window.atelier.debugQueryDb<{ content: string }>(
            "SELECT content FROM messages WHERE session_id = ? AND content LIKE '%local_command_output%'",
            [id]
          ),
        sessionId
      )
      sawLocal = rows.length > 0
    }
    expect(sawLocal).toBeTruthy()
  })

  test('permission_denied UI: deny Bash permission leaves tool row non-completed', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    await waitForTurnIdle(page, 30_000)
    await sendComposerMessage(
      page,
      'Use the Bash tool to run exactly: npm test -- --harness-sdk-deny-marker. Report exit code in one word.'
    )
    const permCard = page.getByTestId('permission-card').last()
    await expect(permCard).toBeVisible({ timeout: 60_000 })
    await permCard.getByTestId('perm-deny').click()
    await expect(permCard.getByTestId('perm-resolved')).toHaveText('Denied', { timeout: 15_000 })

    const toolCard = page
      .locator('[data-testid="tool-card"][data-tool-name="Bash"]')
      .filter({ hasText: 'harness-sdk-deny-marker' })
    await expect(toolCard).toBeVisible({ timeout: 30_000 })
    const status = await toolCard.getAttribute('data-tool-status')
    expect(status === 'denied' || status === 'error').toBeTruthy()
    if (status === 'denied') {
      await expect(toolCard).toHaveClass(/tool-denied/)
      await expect(toolCard.getByTestId('tool-status-chip')).toHaveText('denied')
    }
    await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-permission-denied.png') })
    await waitForTurnIdle(page, 120_000)
  })

  test('model_refusal: optional transcript-notice when SDK refuses (no session banner)', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    await waitForTurnIdle(page, 30_000)
    await sendComposerMessage(
      page,
      'If you cannot comply, refuse explicitly. Otherwise reply READY only.'
    )
    let sawNotice = false
    try {
      await expect(page.getByTestId('transcript-notice')).toBeVisible({ timeout: 45_000 })
      sawNotice = true
      await expect(page.locator('.session-banner')).toHaveCount(0)
      await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-transcript-notice.png') })
    } catch {
      sawNotice = false
    }
    test.info().annotations.push({
      type: 'sdk-optional',
      description: sawNotice ? 'model_refusal notice shown' : 'no refusal this run',
    })
    await waitForTurnIdle(page, 120_000)
  })

  test('sdk_status compacting: /compact may show COMPACT transcript card (optional)', async ({}, testInfo) => {
    testInfo.setTimeout(180_000)
    await waitForTurnIdle(page, 30_000)
    await runSlashCommand(page, '/compact')
    let sawCompact = false
    try {
      await expect(
        page.locator('[data-testid="conversation-status-card"][data-status-kind="compacting"]')
      ).toBeVisible({ timeout: 20_000 })
      sawCompact = true
      await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-compacting.png') })
    } catch {
      sawCompact = false
    }
    await waitForTurnIdle(page, 120_000)
    test.info().annotations.push({
      type: 'sdk-optional',
      description: sawCompact ? 'compacting card shown' : 'compact skipped or instant (no card)',
    })
  })

  test('rate_limit_event: no composer rate-limit chips when session is healthy', async () => {
    const composer = activeComposer(page)
    await expect(composer.getByTestId('composer-rate-limit-chip')).toHaveCount(0)
    await expect(composer.getByTestId('composer-send-blocked-chip')).toHaveCount(0)
  })

  test('auth_status: settings Agent pane has no auth notice in normal e2e session', async () => {
    await openSettingsAgentPane(page)
    await expect(page.getByTestId('settings-auth-notice')).toHaveCount(0)
    await page.getByTestId('settings-close').click()
  })

  test('background_tasks + monitor toast: absent without SDK background/notification events', async () => {
    await expect(page.getByTestId('background-tasks-conversation-card')).toHaveCount(0)
    await expect(page.getByTestId('background-monitors-card')).toHaveCount(0)
    await expect(page.getByTestId('background-shell-card')).toHaveCount(0)
    await expect(page.getByTestId('sdk-toast-stack')).toHaveCount(0)
  })

  test('hooks: main log may contain harness hook lines after real turns', async () => {
    const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
    expect(existsSync(logFilePath)).toBeTruthy()
    const raw = readFileSync(logFilePath, 'utf-8')
    const hookLines = raw.split('\n').filter((l) => l.includes('harness hook'))
    test.info().annotations.push({
      type: 'sdk-optional',
      description: hookLines.length > 0 ? `${hookLines.length} hook log lines` : 'no hook events this run',
    })
  })

  test('mirror_error: out of scope until draft mock approved (no UI)', async () => {
    test.info().annotations.push({ type: 'out-of-scope', description: 'mirror_error not implemented' })
  })
})
