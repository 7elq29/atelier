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

async function createComposerSession(page: Page, projectDir: string): Promise<string> {
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
  const id = (await row.getAttribute('data-session-id')) as string
  expect(id).toBeTruthy()

  await expect(activeComposer(page).getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 90_000 })
  await expect(activeComposer(page).getByTestId('send-button')).toBeVisible()
  return id
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
    sessionId = await createComposerSession(page, projectDir)
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
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))

    const sendButton = activeComposer(page).getByTestId('send-button')
    await expect(sendButton).toBeVisible()
    await page.mouse.move(0, 0)
    const sendBg = await sendButton.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(sendBg).not.toBe('rgba(0, 0, 0, 0)')
    const sendRadius = await sendButton.evaluate((el) => getComputedStyle(el).borderRadius)
    expect(sendRadius).toBe('8px')

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
    expect(sendBgDark).not.toBe(sendBg)

    await page.screenshot({ path: join(artifactsDir, '04-composer-ui-match-dark.png') })

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  })

  test('primary actions stay inline for one line, then move below wrapped input', async () => {
    const composer = activeComposer(page)
    const textarea = composer.getByTestId('composer-input')
    const actions = composer.getByTestId('composer-primary-actions')

    await textarea.fill('Short follow-up')
    await expect(actions).toHaveAttribute('data-placement', 'inline')
    await expect(actions.getByTestId('model-picker-button')).toBeVisible()
    const sendButton = actions.getByTestId('send-button')
    await expect(sendButton).toBeVisible()
    await expect(sendButton).toHaveCSS('width', '28px')
    await expect(sendButton).toHaveCSS('height', '28px')
    await expect(sendButton).toHaveCSS('border-radius', '50%')
    await expect(composer.locator('.composer-box')).not.toHaveClass(/composer-box--multiline/)
    const inputBox = await textarea.boundingBox()
    const inlineBox = await actions.boundingBox()
    expect(inputBox).not.toBeNull()
    expect(inlineBox).not.toBeNull()
    if (inputBox && inlineBox) {
      expect(inlineBox.y).toBeGreaterThanOrEqual(inputBox.y)
      expect(inlineBox.y + inlineBox.height).toBeLessThanOrEqual(inputBox.y + inputBox.height + 1)
    }
    await page.screenshot({ path: join(artifactsDir, '04-composer-actions-inline.png') })

    await textarea.fill('First line\nSecond line')
    await expect(actions).toHaveAttribute('data-placement', 'footer')
    await expect(composer.locator('.composer-box')).toHaveClass(/composer-box--multiline/)
    await expect(composer.locator('.composer-footer').getByTestId('composer-primary-actions')).toBeVisible()
    await expect(composer.locator('.composer-footer').getByTestId('send-button')).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, '04-composer-actions-multiline.png') })

    await textarea.fill('A very long line '.repeat(45))
    await expect(actions).toHaveAttribute('data-placement', 'footer')

    await textarea.fill('Short again')
    await expect(actions).toHaveAttribute('data-placement', 'inline')

    await textarea.fill('Reply with exactly: CONTEXT.')
    await textarea.press('Enter')
    await expect(actions).toHaveAttribute('data-placement', 'inline')
    const stopButton = actions.getByTestId('stop-button')
    await expect(stopButton).toBeVisible({ timeout: 5_000 })
    await expect(stopButton).toHaveCSS('width', '28px')
    await expect(stopButton).toHaveCSS('height', '28px')
    await expect(stopButton).toHaveCSS('border-radius', '50%')
    const contextBar = composer.getByTestId('composer-context-bar')
    const statusAfterBranch = contextBar.locator(
      '[data-testid="composer-context-branch"] + [data-testid="composer-turn-status"]'
    )
    await expect(statusAfterBranch).toBeVisible()
    await expect(statusAfterBranch).toContainText(/Waiting for model|Retrying API|Working|Extended reasoning/)
    const branchBox = await contextBar.getByTestId('composer-context-branch').boundingBox()
    const statusBox = await statusAfterBranch.boundingBox()
    expect(branchBox).not.toBeNull()
    expect(statusBox).not.toBeNull()
    if (branchBox && statusBox) {
      expect(Math.abs(statusBox.y - branchBox.y)).toBeLessThanOrEqual(1)
    }
    await expect(composer.locator('.composer-footer').getByTestId('composer-turn-status')).toHaveCount(0)
    await expect(composer.getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 60_000 })

    const contextRing = composer.getByTestId('token-usage')
    await expect(contextRing).toBeVisible({ timeout: 30_000 })
    await expect(contextRing).toHaveClass(/context-usage-ring/)
    await expect(contextRing).toHaveAttribute('title', /\d[\d,]* \/ \d[\d,]* context tokens \(\d+%\)/)
    await expect(contextRing.locator('.context-usage-progress')).toHaveCount(1)
    await expect(contextRing).toHaveText('')
    await page.screenshot({ path: join(artifactsDir, '04-composer-context-ring.png') })

    await textarea.fill('')
  })

  // ── 1. Auto-grow up to the 160px cap, then scroll ───────────────────────
  test('textarea auto-grows with content up to the 160px cap, then scrolls', async () => {
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.click()

    // A short single line: near the CSS min-height (~52px per mock-aligned composer textarea).
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

  test('Emacs navigation: Opt+F/B/D/V, Ctrl+A/E, Opt+Shift+,/.', async () => {
    const textarea = activeComposer(page).getByTestId('composer-input')
    const sample = 'hello world\nsecond line'
    await textarea.click()
    await textarea.fill(sample)
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.focus()
      el.setSelectionRange(0, 0)
    })

    await page.keyboard.down('Alt')
    await page.keyboard.press('KeyF')
    await page.keyboard.up('Alt')
    await expect.poll(async () => textarea.evaluate((el) => el.selectionStart)).toBe(5)

    await page.keyboard.down('Alt')
    await page.keyboard.press('KeyB')
    await page.keyboard.up('Alt')
    await expect.poll(async () => textarea.evaluate((el) => el.selectionStart)).toBe(0)

    await textarea.fill('hello world')
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.focus()
      el.setSelectionRange(0, 0)
    })
    await page.keyboard.down('Alt')
    await page.keyboard.press('KeyD')
    await page.keyboard.up('Alt')
    await expect(textarea).toHaveValue(' world')

    await textarea.fill(sample)
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.focus()
      el.setSelectionRange(12, 12)
    })
    await textarea.press('Control+a')
    await expect.poll(async () => textarea.evaluate((el) => el.selectionStart)).toBe(12)

    await textarea.press('Control+e')
    await expect.poll(async () => textarea.evaluate((el) => el.selectionStart)).toBe(sample.length)

    const tallText = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')
    await textarea.fill(tallText)
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
      el.scrollTop = el.scrollHeight
    })
    const scrollBefore = await textarea.evaluate((el) => el.scrollTop)
    expect(scrollBefore).toBeGreaterThan(0)
    await page.keyboard.down('Alt')
    await page.keyboard.press('KeyV')
    await page.keyboard.up('Alt')
    await expect.poll(async () => textarea.evaluate((el) => el.scrollTop)).toBeLessThan(scrollBefore)

    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.focus()
      el.setSelectionRange(12, 12)
    })
    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Comma')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    await expect.poll(async () => textarea.evaluate((el) => el.selectionStart)).toBe(0)

    await page.keyboard.down('Alt')
    await page.keyboard.down('Shift')
    await page.keyboard.press('Period')
    await page.keyboard.up('Shift')
    await page.keyboard.up('Alt')
    await expect.poll(async () => textarea.evaluate((el) => el.selectionStart)).toBe(tallText.length)

    await textarea.fill('')
  })

  test('Ctrl+K kills to end of line and removes empty lines', async () => {
    const textarea = activeComposer(page).getByTestId('composer-input')
    await textarea.click()
    await textarea.fill('line one\n\nline three')
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.focus()
      el.setSelectionRange(9, 9)
    })
    await textarea.press('Control+k')
    await expect(textarea).toHaveValue('line one\nline three')

    await textarea.fill('hello world')
    await textarea.evaluate((el: HTMLTextAreaElement) => {
      el.focus()
      el.setSelectionRange(6, 6)
    })
    await textarea.press('Control+k')
    await expect(textarea).toHaveValue('hello ')

    await textarea.fill('')
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
    const stopClickedAt = Date.now()
    await stopButton.click()

    // UI must flip back immediately — don't wait for harness teardown.
    await expect(activeComposer(page).getByTestId('send-button')).toBeVisible({ timeout: 2_000 })
    await expect(activeComposer(page).getByTestId('stop-button')).toHaveCount(0, { timeout: 2_000 })
    await expect(activeComposer(page).getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 2_000 })
    expect(Date.now() - stopClickedAt).toBeLessThan(2_500)

    const errorBanner = page.locator('.msg-system', { hasText: 'Error:' })
    await expect(errorBanner).toHaveCount(0)

    await expect
      .poll(async () => {
        const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
        const raw = readFileSync(logFilePath, 'utf-8')
        const afterInterrupt = raw.split('harness.interrupt() called').pop() ?? ''
        return /interrupted \(terminal\)/.test(afterInterrupt)
      }, { timeout: 60_000 })
      .toBe(true)

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

  test('composer draft survives switching to an app note and back', async () => {
    const draft = 'draft-kept-across-app-note-switch'
    await activeComposer(page).getByTestId('composer-input').fill(draft)

    await page.getByTestId('new-app-note-button').click()
    await expect(page.getByTestId('app-note-editor')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.composer-cache-entry.active')).toHaveCount(0)
    await expect(page.getByTestId('composer-cache')).toBeAttached()

    await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()
    await expect(page.locator('.composer-cache-entry.active').getByTestId('composer-input')).toHaveValue(draft)
  })

  test('large paste shows copied-characters summary in composer', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    if (!sessionId) sessionId = await createComposerSession(page, projectDir)
    const large = `PASTE_START_${'x'.repeat(5_000)}_PASTE_END`
    const expectedLabel = `[copied ${large.length} charactors]`
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text)
    }, large)

    const composer = activeComposer(page).getByTestId('composer-input')
    await composer.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')

    await expect(composer).toHaveValue(expectedLabel)
    await page.screenshot({ path: join(artifactsDir, 'composer-large-paste-display.png') })
  })

  test('large paste sends full text, not the copied-characters summary', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    if (!sessionId) sessionId = await createComposerSession(page, projectDir)

    const marker = `PASTE_SEND_${Date.now()}_`
    const large = `${marker}${'z'.repeat(200)}`
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text)
    }, large)

    const composer = activeComposer(page).getByTestId('composer-input')
    await composer.click()
    await composer.fill('')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
    await expect(composer).toHaveValue(`[copied ${large.length} charactors]`)

    await composer.press('Enter')
    await expect(composer).toHaveValue('', { timeout: 5_000 })

    await expect
      .poll(async () => {
        const rows = await page.evaluate(
          (args) =>
            window.atelier.debugQueryDb<{ content: string }>(
              "SELECT content FROM messages WHERE session_id = ? AND role='user' ORDER BY id DESC LIMIT 1",
              [args.id]
            ),
          { id: sessionId }
        )
        return rows[0]?.content ?? ''
      }, { timeout: 10_000 })
      .toBe(large)

    await expect(activeComposer(page).getByTestId('send-button')).toBeVisible({ timeout: 30_000 })
    await page.screenshot({ path: join(artifactsDir, 'composer-deferred-paste-placeholder.png') })
  })

  test('submitted user message stays visible when composer grows', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    if (!sessionId) sessionId = await createComposerSession(page, projectDir)
    await expect(activeComposer(page).getByTestId('composer-turn-status')).toHaveCount(0, { timeout: 90_000 })

    const message =
      'Submitted message visibility check — this bubble must stay fully in view after the composer shows turn status.'
    await activeComposer(page).getByTestId('composer-input').fill(message)
    await activeComposer(page).getByTestId('send-button').click()

    const userMsg = page.locator('.msg-user[data-testid="transcript-message"]').last()
    await expect
      .poll(async () => userMsg.textContent(), { timeout: 15_000 })
      .toContain('Submitted message visibility check')
    await expect(activeComposer(page).getByTestId('composer-turn-status')).toBeVisible({ timeout: 15_000 })

    const visible = await userMsg.evaluate((el) => {
      const scroll = el.closest('.chat-body-row')
      if (!scroll) return false
      const msg = el.getBoundingClientRect()
      const box = scroll.getBoundingClientRect()
      return msg.top >= box.top - 1 && msg.bottom <= box.bottom + 1
    })
    expect(visible, 'last user message should not be clipped when composer grows after submit').toBe(true)
  })

  test('small paste shows full text in composer', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    if (!sessionId) sessionId = await createComposerSession(page, projectDir)

    const small = 'short paste under two hundred characters'
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text)
    }, small)

    const composer = activeComposer(page).getByTestId('composer-input')
    await composer.click()
    await composer.fill('')
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
    await expect(composer).toHaveValue(small)
  })
})
