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

async function appendHarnessLog(page: Page, label: string): Promise<void> {
  const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
  if (!existsSync(logFilePath)) return
  const raw = readFileSync(logFilePath, 'utf-8')
  const lines = raw
    .split('\n')
    .filter((l) =>
      /harness event: result|harness event: interrupted|session:turnState|session:sdkChrome|harness hook|permission_denied|model_refusal|sdk_status|background_tasks|session:backgroundTasks/.test(
        l
      )
    )
  writeFileSync(logPath, `[${label}]\n${lines.slice(-80).join('\n')}\n`, { flag: 'a' })
}

test.describe.configure({ mode: 'serial' })

/**
 * Bug-bash coverage for harness SDK → UI wiring (Features/harness-sdk-events/spec.md).
 * Automated cases use real SDK turns; see e2e/HARNESS_SDK_EVENTS_BUG_BASH.md for the full matrix.
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
    await electronApp.close().catch(() => undefined)
  })

  test('create session and wait for idle composer', async ({}, testInfo) => {
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

    await expect(activeComposer(page).getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 90_000 })
    await expect(activeComposer(page).getByTestId('send-button')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-idle.png') })
  })

  test('in-flight turn: composer hint visible, no REQUEST transcript status card', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    const composer = activeComposer(page)
    await composer.getByTestId('composer-input').fill(
      'Use the Bash tool to run exactly: sleep 3 && echo done. After it completes, reply with one short sentence.'
    )
    await composer.getByTestId('send-button').click()

    await expect(composer.getByTestId('stop-button')).toBeVisible({ timeout: 15_000 })
    await expect(composer.getByTestId('composer-turn-status')).toBeVisible({ timeout: 15_000 })
    await expect(composer.getByTestId('composer-turn-status')).toContainText(/Waiting for model|Retrying API/)

    // REQUEST moved off transcript — only COMPACT cards belong there.
    await expect(page.locator('[data-testid="conversation-status-card"][data-status-kind="requesting"]')).toHaveCount(0)

    const toolCard = page.locator('[data-testid="tool-card"][data-tool-name="Bash"]').first()
    await expect(toolCard).toBeVisible({ timeout: 30_000 })
    await expect(toolCard.locator('[data-testid="tool-running-indicator"]')).toBeVisible({ timeout: 10_000 })
    await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-mid-turn.png') })

    await expect(toolCard.locator('[data-testid="tool-status-chip"]')).toHaveText('completed', { timeout: 60_000 })
    await expect(composer.getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 90_000 })
    await expect(composer.getByTestId('send-button')).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('[data-testid="conversation-status-card"][data-status-kind="requesting"]')).toHaveCount(0)

    await appendHarnessLog(page, 'bash-turn-complete')
    await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-turn-complete.png') })
  })

  test('tool_progress: optional elapsed hint on long-running Bash', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)
    const composer = activeComposer(page)
    await composer.getByTestId('composer-input').fill(
      'Use Bash once to run: sleep 5 && echo slow. Wait for completion, then say done.'
    )
    await composer.getByTestId('send-button').click()

    const toolCard = page.locator('[data-testid="tool-card"][data-tool-name="Bash"]').first()
    await expect(toolCard).toBeVisible({ timeout: 30_000 })
    await expect(toolCard.locator('[data-testid="tool-running-indicator"]')).toBeVisible({ timeout: 10_000 })

    let sawElapsed = false
    try {
      await expect
        .poll(async () => toolCard.locator('[data-testid="tool-elapsed"]').count(), { timeout: 8_000 })
        .toBeGreaterThan(0)
      sawElapsed = true
    } catch {
      sawElapsed = false
    }

    if (sawElapsed) {
      await page.screenshot({ path: join(artifactsDir, '08-harness-sdk-tool-elapsed.png') })
    }

    await expect(toolCard.locator('[data-testid="tool-status-chip"]')).toHaveText('completed', { timeout: 90_000 })
    await expect(composer.getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 90_000 })
  })

  test('background tasks card absent when no SDK background_tasks_changed', async () => {
    await expect(page.getByTestId('background-tasks-conversation-card')).toHaveCount(0)
    await expect(page.getByTestId('background-monitors-card')).toHaveCount(0)
    await expect(page.getByTestId('background-shell-card')).toHaveCount(0)
  })

  test('sdk toast stack empty without monitor notification', async () => {
    await expect(page.getByTestId('sdk-toast-stack')).toHaveCount(0)
  })
})
