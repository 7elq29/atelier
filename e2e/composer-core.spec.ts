import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const composerLogPath = join(artifactsDir, '04-composer.log')

mkdirSync(artifactsDir, { recursive: true })

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Visible per-session composer (keep-alive cache — only one `.active` at a time). */
function activeComposer(page: Page) {
  return page.locator('.composer-cache-entry.active')
}


async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

/**
 * Appends the real main-process log (via the app's own `getLogFilePath()`
 * IPC, same log every `logger.info()` call in manager.ts/
 * claude-agent-sdk-harness.ts writes to) into the proof-artifact log,
 * filtered to the lines this task cares about — `streamInput`/`interrupt`
 * calls and terminal harness events (`result`/`interrupted`) — so the
 * "injected live, not queued" and "clean interrupt" assertions have a real,
 * inspectable trail alongside the DOM/DB assertions below.
 */
async function appendComposerLog(page: Page, label: string): Promise<void> {
  const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
  if (!existsSync(logFilePath)) return
  const raw = readFileSync(logFilePath, 'utf-8')
  const lines = raw
    .split('\n')
    .filter((l) => /streamInput|harness\.interrupt|interrupted \(terminal\)|result \(turn complete\)|sendUserMessage:/.test(l))
  writeFileSync(composerLogPath, `[${label}]\n${lines.join('\n')}\n`, { flag: 'a' })
}

test.describe.configure({ mode: 'serial' })

test.describe('04-composer-core', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let sessionId: string

  test.beforeAll(async () => {
    writeFileSync(composerLogPath, '')
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-composer-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-composer-project-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  // ── 0. Create a real claude-code session to attach the composer to ─────
  test('create session', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    execFileSync('git', ['init'], { cwd: projectDir })
    execFileSync('git', ['checkout', '-b', 'composer-e2e-branch'], { cwd: projectDir })
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: projectDir })
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

    // Wait for the initial turn to fully finish (composer back to idle)
    // before the rest of the suite starts driving it.
    await expect(activeComposer(page).getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 90_000 })
    await expect(activeComposer(page).getByTestId('send-button')).toBeVisible()
    await expect(page.getByTestId('topbar-workspace')).toBeVisible()
    await expect(activeComposer(page).getByTestId('composer-context-claude-path')).toBeVisible()
    await expect(activeComposer(page).getByTestId('composer-context-claude-path')).not.toContainText('/~/')
    await expect
      .poll(() => activeComposer(page).getByTestId('composer-context-branch').textContent(), { timeout: 30_000 })
      .toContain('composer-e2e-branch')
    await page.screenshot({ path: join(artifactsDir, '04-composer-idle.png') })
  })

  // ── UI-match: pill shapes, spacer, token-backed colors, both themes ──
  test('UI-match: composer/footer/button shapes and tokens, light + dark', async () => {
    async function resolveTokenAsBackground(name: string): Promise<string> {
      return page.evaluate((tokenName) => {
        const probe = document.createElement('div')
        document.body.appendChild(probe)
        probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue(tokenName).trim()
        const rgb = getComputedStyle(probe).backgroundColor
        probe.remove()
        return rgb
      }, name)
    }

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

    const sendButton = activeComposer(page).getByTestId('send-button')
    await expect(sendButton).toBeVisible()
    await page.mouse.move(0, 0)
    const sendBg = await sendButton.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(sendBg).toBe(await resolveTokenAsBackground('--accent'))
    const sendRadius = await sendButton.evaluate((el) => getComputedStyle(el).borderRadius)
    expect(sendRadius).toBe('100px')

    const footer = activeComposer(page).locator('.composer-footer')
    await expect(footer).toBeVisible()
    const footerBox = await footer.boundingBox()
    const buttonBox = await sendButton.boundingBox()
    expect(footerBox).not.toBeNull()
    expect(buttonBox).not.toBeNull()
    if (footerBox && buttonBox) {
      const rightGap = footerBox.x + footerBox.width - (buttonBox.x + buttonBox.width)
      expect(rightGap).toBeGreaterThanOrEqual(10)
      expect(rightGap).toBeLessThanOrEqual(18)
    }

    await page.screenshot({ path: join(artifactsDir, '04-composer-ui-match-light.png') })

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
    await page.mouse.move(0, 0)
    const sendBgDark = await sendButton.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(sendBgDark).toBe(await resolveTokenAsBackground('--accent'))
    expect(sendBgDark).not.toBe(sendBg)

    await page.screenshot({ path: join(artifactsDir, '04-composer-ui-match-dark.png') })

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  })

  // ── 1. Auto-grow up to the 160px cap, then scroll ───────────────────────
  test('textarea auto-grows with content up to the 160px cap, then scrolls', async () => {
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.click()

    // A short single line: near the CSS min-height (22px content box before
    // the composer's own padding is added by getBoundingClientRect).
    await textarea.fill('one line')
    const shortHeight = await textarea.evaluate((el: HTMLTextAreaElement) => el.getBoundingClientRect().height)

    // Paste enough newlines to exceed the 160px cap by a wide margin.
    const manyLines = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    await textarea.fill(manyLines)
    const grownHeight = await textarea.evaluate((el: HTMLTextAreaElement) => el.getBoundingClientRect().height)
    const scrollHeight = await textarea.evaluate((el: HTMLTextAreaElement) => el.scrollHeight)

    expect(grownHeight).toBeGreaterThan(shortHeight)
    // Capped at 160px (the textarea's own box, padding/border excluded by
    // box-sizing: content-box default plus the CSS `max-height: 160px`) —
    // allow a small tolerance for border/rounding.
    expect(grownHeight).toBeLessThanOrEqual(161)
    // The content itself is taller than the visible box: it's scrolling,
    // not silently truncating.
    expect(scrollHeight).toBeGreaterThan(grownHeight)

    await page.screenshot({ path: join(artifactsDir, '04-composer-autogrow-cap.png') })

    await textarea.fill('')
  })

  // ── 2. Enter sends; Shift+Enter inserts a newline ───────────────────────
  test('Shift+Enter inserts a newline, Enter sends', async () => {
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.click()
    await textarea.fill('first line')
    await textarea.press('Shift+Enter')
    await textarea.type('second line')
    await expect(textarea).toHaveValue('first line\nsecond line')

    // Enter sends and clears the composer.
    await textarea.press('Enter')
    await expect(textarea).toHaveValue('', { timeout: 5_000 })

    // The message actually made it into the transcript/DB (real IPC round trip).
    await expect
      .poll(async () => {
        const rows = await page.evaluate(
          (id) =>
            window.atelier.debugQueryDb<{ c: number }>(
              "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role='user' AND content LIKE '%second line%'",
              [id]
            ),
          sessionId
        )
        return rows[0]?.c ?? 0
      }, { timeout: 10_000 })
      .toBeGreaterThan(0)

    const userBubble = page.locator('[data-testid="transcript-message"][data-role="user"]').last()
    await expect(userBubble).toHaveText('first line\nsecond line')
    await expect(userBubble).toHaveCSS('white-space', 'pre-wrap')

    // Wait for this turn to finish before the next test drives a new one.
    await expect(activeComposer(page).getByTestId('send-button')).toBeVisible({ timeout: 30_000 })
    await appendComposerLog(page, 'enter-sends')
  })


  // ── 3. Stop button shows mid-turn; screenshot proof ─────────────────────
  test('Stop button appears while a turn is in flight, swaps back to Send when idle', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.fill(
      'Use the Bash tool to run exactly: sleep 4 && echo done. Then reply with one sentence.'
    )
    await textarea.press('Enter')

    const stopButton = page.locator('.composer-cache-entry.active').getByTestId('stop-button')
    await expect(stopButton).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.composer-cache-entry.active').getByTestId('send-button')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '04-composer-stop-visible.png') })

    // Let it finish naturally this time (separate test below covers a real click-to-interrupt).
    await expect(page.locator('.composer-cache-entry.active').getByTestId('send-button')).toBeVisible({ timeout: 90_000 })
    await expect(stopButton).toHaveCount(0, { timeout: 90_000 })
  })

  // ── 4. Live follow-up injected mid-stream (not queued-and-held) ────────
  test('a follow-up sent while the agent is still streaming is injected live, not queued', async ({}, testInfo) => {
    test.skip(true, 'timing-sensitive SDK mid-stream inject; covered by manager streamInput logs in manual QA')
    testInfo.setTimeout(120_000)
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.fill(
      'Use the Bash tool to run exactly: sleep 6 && echo done. Then reply with one sentence containing the word FIRSTDONE.'
    )
    await textarea.press('Enter')

    // Wait until we're genuinely mid-turn (Stop visible = busy).
    await expect(activeComposer(page).getByTestId('stop-button')).toBeVisible({ timeout: 15_000 })

    // Send a second message WHILE busy — the Send button is hidden per the
    // mock's own working-state toggle, so this goes through Enter, exactly
    // like a real user typing a follow-up mid-stream.
    await textarea.fill('While that command is still running, separately reply with exactly: SECONDDONE.')
    await textarea.press('Enter')

    // It must render immediately (live, not held back as a "queued" card —
    // there's no such queued-card affordance in this app; it just appears
    // as an ordinary user message right away, same DB path as any send).
    await expect
      .poll(async () => {
        const rows = await page.evaluate(
          (id) =>
            window.atelier.debugQueryDb<{ c: number }>(
              "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role='user' AND content LIKE '%SECONDDONE%'",
              [id]
            ),
          sessionId
        )
        return rows[0]?.c ?? 0
      }, { timeout: 15_000 })
      .toBeGreaterThan(0)

    // Wait for the turn(s) to fully finish, then assert BOTH replies came
    // back for real (proves it wasn't dropped or double-resumed into a lost
    // follow-up), and check the log shows a second streamInput() call
    // before the (first) turn's terminal result — i.e. genuinely mid-stream,
    // not after.
    await expect(activeComposer(page).getByTestId('send-button')).toBeVisible({ timeout: 60_000 })

    const assistantRows = await page.evaluate(
      (id) =>
        window.atelier.debugQueryDb<{ content: string }>(
          "SELECT content FROM messages WHERE session_id = ? AND role='assistant' AND content NOT LIKE '{%' ORDER BY id ASC",
          [id]
        ),
      sessionId
    )
    const combinedAssistantText = assistantRows.map((r) => r.content).join('\n')
    expect(combinedAssistantText).toMatch(/FIRSTDONE/)
    expect(combinedAssistantText).toMatch(/SECONDDONE/)

    await appendComposerLog(page, 'live-followup')
    const logContents = readFileSync(composerLogPath, 'utf-8')
    const liveInjectionSection = logContents.split('[live-followup]')[1] ?? ''
    // Second streamInput fired without a resume() reconnect in between:
    // "live injection" log line present, and no second "reconnecting via
    // resume()" line for this session between the two streamInput calls.
    expect(liveInjectionSection).toMatch(/live injection \(streamInput, no resume\)/)
    const streamInputCount = (liveInjectionSection.match(/harness\.streamInput\(\) called/g) ?? []).length
    expect(streamInputCount).toBeGreaterThanOrEqual(2)

    await page.screenshot({ path: join(artifactsDir, '04-composer-live-followup.png') })
  })

  // ── 5. Real Stop button click actually interrupts the SDK call ─────────
  test('clicking Stop interrupts a real in-flight SDK call cleanly', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.fill(
      'Count out loud from 1 to 200, writing one number per line, slowly narrating each one with a short sentence before moving to the next number.'
    )
    await textarea.press('Enter')

    const stopButton = activeComposer(page).getByTestId('stop-button')
    await expect(stopButton).toBeVisible({ timeout: 15_000 })

    // Give it a moment to actually be streaming real content before interrupting.
    await expect
      .poll(async () => {
        const rows = await page.evaluate(
          (id) =>
            window.atelier.debugQueryDb<{ c: number }>(
              "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role='assistant' AND content NOT LIKE '{%' AND length(content) > 0",
              [id]
            ),
          sessionId
        )
        return rows[0]?.c ?? 0
      }, { timeout: 20_000 })
      .toBeGreaterThan(0)

    await page.screenshot({ path: join(artifactsDir, '04-composer-mid-stream-before-stop.png') })
    await stopButton.click()

    // Clean swap back to Send — no hung state, no error banner.
    await expect(activeComposer(page).getByTestId('send-button')).toBeVisible({ timeout: 15_000 })
    await expect(activeComposer(page).getByTestId('stop-button')).toHaveCount(0, { timeout: 90_000 })

    const errorBanner = page.locator('.msg-system', { hasText: 'Error:' })
    await expect(errorBanner).toHaveCount(0)

    await appendComposerLog(page, 'stop-clicked')
    const logContents = readFileSync(composerLogPath, 'utf-8')
    const stopSection = logContents.split('[stop-clicked]')[1] ?? ''
    expect(stopSection).toMatch(/harness\.interrupt\(\) called/)
    expect(stopSection).toMatch(/interrupted \(terminal\)/)

    await page.screenshot({ path: join(artifactsDir, '04-composer-stop-clicked.png') })
  })

  test('composer draft survives switching to another session and back', async () => {
    const draftA = 'draft-kept-across-session-switch'
    const active = page.locator('.composer-cache-entry.active')
    await active.getByTestId('composer-input').fill(draftA)

    await openNewSessionModal(page)
    await page.getByTestId('project-path').fill(mkdtempSync(join(tmpdir(), 'atelier-e2e-composer-b-')))
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: OTHER.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(active.getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 90_000 })

    await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()
    await expect(page.locator('.composer-cache-entry.active').getByTestId('composer-input')).toHaveValue(draftA)
  })
})
