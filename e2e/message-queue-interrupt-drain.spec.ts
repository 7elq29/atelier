import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
mkdirSync(artifactsDir, { recursive: true })

/**
 * fix-message-queue-interrupt-drain: canceling an in-flight turn must auto-run
 * the next queued message (drain after `interrupted`, reconnect — not silent
 * streamInput onto a closed queue).
 */
test('stopping an in-flight turn drains the queued follow-up and auto-runs it', async () => {
  test.setTimeout(180_000)
  const projectRoot = join(__dirname, '..')
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-queue-drain-userdata-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'atelier-queue-drain-project-'))
  seedSkipOnboarding(userDataDir)
  execFileSync('git', ['init'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.email', 'e2e@example.com'], { cwd: projectDir })
  execFileSync('git', ['config', 'user.name', 'Atelier E2E'], { cwd: projectDir })
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: projectDir })

  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: projectRoot
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly: READY.')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const sessionRow = page.locator('[data-testid="session-row"]').first()
    await expect(sessionRow).toBeVisible({ timeout: 15_000 })
    const sessionId = (await sessionRow.getAttribute('data-session-id')) as string
    expect(sessionId).toBeTruthy()

    const composer = page.locator('.composer-cache-entry.active')
    await expect(composer.locator('.composer-box')).toHaveAttribute('data-working', 'false', { timeout: 90_000 })

    const textarea = composer.getByTestId('composer-input')
    await textarea.fill(
      'Use the Bash tool to run exactly: sleep 25 && echo M1DONE. Wait for it to finish, then reply with exactly: M1DONE.'
    )
    await textarea.press('Enter')

    const stopButton = composer.getByTestId('stop-button')
    await expect(stopButton).toBeVisible({ timeout: 30_000 })

    await textarea.fill('Reply with exactly: M2AUTO.')
    await expect(composer.getByTestId('send-button')).toBeVisible({ timeout: 5_000 })
    await textarea.press('Enter')

    const queuedStrip = composer.getByTestId('queued-strip')
    await expect(queuedStrip).toBeVisible({ timeout: 5_000 })
    await expect(queuedStrip).toContainText('M2AUTO')
    await page.screenshot({ path: join(artifactsDir, 'message-queue-interrupt-drain-queued.png') })

    // Queued messages are deferred from the DB until drain/dispatch.
    const queuedInDbBefore = await page.evaluate(
      (id) =>
        window.atelier.debugQueryDb<{ c: number }>(
          "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role='user' AND content LIKE '%M2AUTO%'",
          [id]
        ),
      sessionId
    )
    expect(queuedInDbBefore[0]?.c ?? 0).toBe(0)

    await stopButton.click()

    // Strip clears as m2 is drained into the transcript.
    await expect(queuedStrip).toHaveCount(0, { timeout: 15_000 })

    await expect
      .poll(
        async () => {
          const rows = await page.evaluate(
            (id) =>
              window.atelier.debugQueryDb<{ c: number }>(
                "SELECT COUNT(*) as c FROM messages WHERE session_id = ? AND role='user' AND content LIKE '%M2AUTO%'",
                [id]
              ),
            sessionId
          )
          return rows[0]?.c ?? 0
        },
        { timeout: 15_000 }
      )
      .toBe(1)

    await expect
      .poll(
        async () => {
          const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
          if (!existsSync(logFilePath)) return false
          const raw = readFileSync(logFilePath, 'utf-8')
          return /turnQueue: draining next queued message/.test(raw)
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    // m2 must actually run — assistant text containing M2AUTO (not a silent drop).
    await expect
      .poll(
        async () => {
          const rows = await page.evaluate(
            (id) =>
              window.atelier.debugQueryDb<{ content: string }>(
                "SELECT content FROM messages WHERE session_id = ? AND role='assistant' AND content NOT LIKE '{%' ORDER BY id ASC",
                [id]
              ),
            sessionId
          )
          return rows.map((r) => r.content).join('\n')
        },
        { timeout: 120_000 }
      )
      .toMatch(/M2AUTO/)

    await expect
      .poll(
        async () => {
          const logFilePath = await page.evaluate(() => window.atelier.getLogFilePath())
          if (!existsSync(logFilePath)) return false
          const raw = readFileSync(logFilePath, 'utf-8')
          const afterDrain = raw.split('turnQueue: draining next queued message').pop() ?? ''
          // After interrupt the queue is closed — drain must reconnect, not
          // silently streamInput onto the dead session.
          return /dispatchTurnToHarness: no live harness session, reconnecting via resume\(\)/.test(afterDrain)
        },
        { timeout: 30_000 }
      )
      .toBe(true)

    await page.screenshot({ path: join(artifactsDir, 'message-queue-interrupt-drain-after.png') })
  } finally {
    await app?.close().catch(() => undefined)
  }
})
