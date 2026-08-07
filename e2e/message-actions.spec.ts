import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

mkdirSync(artifactsDir, { recursive: true })

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}


async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe.configure({ mode: 'serial' })

test.describe('10d-enrichment-message-actions', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-msgactions-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-msgactions-project-'))
    writeFileSync(join(projectDir, 'README.md'), '# test project\n')
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    // Clear the real system clipboard first so a stale value from a prior
    // test run on this machine can't produce a false positive.
    await electronApp.evaluate(({ clipboard }) => clipboard.writeText(''))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('create session with a real reply, then copy the assistant message to the real system clipboard', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
        await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Do not use any tools. Reply with exactly this single sentence and nothing else: The quick brown fox jumps over the lazy dog.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })

    // Wait for the real assistant reply to land.
    const assistantMsg = page.locator('.msg-assistant[data-testid="transcript-message"]').first()
    await expect(assistantMsg).toBeVisible({ timeout: 60_000 })
    await expect(assistantMsg).toContainText('quick brown fox', { timeout: 60_000 })
    const messageText = (await assistantMsg.textContent())?.trim() ?? ''
    expect(messageText.length).toBeGreaterThan(0)

    // Hover reveals the action icons (Copy + Speak), matching the sidebar
    // row's hover-reveal interaction pattern (`.row-menu-btn`) and the
    // mock's `.msg-wrap:hover .msg-actions` rule.
    const wrap = page.locator('.msg-wrap').filter({ has: assistantMsg })
    const actions = wrap.locator('[data-testid="msg-actions"]')
    await expect(actions).toBeHidden()
    await wrap.hover()
    await expect(actions).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '10d-message-actions.png') })

    // Real clipboard write: click Copy, then read the REAL clipboard back
    // via Electron's `clipboard` module in the main process (works
    // regardless of whether the renderer wrote via `navigator.clipboard` or
    // IPC — this is the standard way to verify a real clipboard write in an
    // Electron e2e test).
    await actions.getByTestId('msg-copy-button').click()
    await expect
      .poll(async () => electronApp.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
      .toBe(messageText)
  })

  test('speak: clicking the Speak button starts real speech synthesis', async () => {
    const assistantMsg = page.locator('.msg-assistant[data-testid="transcript-message"]').first()
    const wrap = page.locator('.msg-wrap').filter({ has: assistantMsg })
    await wrap.hover()
    const speakBtn = wrap.getByTestId('msg-speak-button')
    await expect(speakBtn).toBeVisible()
    await speakBtn.click()

    // Real signal, not a stub: `speechSynthesis.speaking` flips true once
    // the utterance actually starts (per `onstart` firing in
    // MessageActions.tsx).
    await expect
      .poll(async () => page.evaluate(() => window.speechSynthesis.speaking), { timeout: 5_000 })
      .toBe(true)

    await expect(wrap.getByTestId('msg-speaking-indicator')).toBeVisible()
  })

  test('copy on the user message copies its raw text', async () => {
    // User message: copies the raw user text verbatim.
    const userMsg = page.locator('.msg-user').first()
    const userWrap = page.locator('.msg-wrap').filter({ has: userMsg })
    const userText = (await userMsg.textContent())?.trim() ?? ''
    await userWrap.hover()
    await userWrap.getByTestId('msg-copy-button').click()
    await expect
      .poll(async () => electronApp.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
      .toBe(userText)
  })
})
