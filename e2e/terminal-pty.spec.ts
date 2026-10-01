/**
 * Standalone PTY/terminal e2e — not chained behind secondary-panels serial setup.
 * Maps to src/main/panels/pty.ts (see e2e/TEST_CATEGORIES.md secondary-panels).
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test.describe('terminal-pty', () => {
  test('cortana: terminal works after create and after relaunch', async () => {
    test.setTimeout(120_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cortana-term-'))
    seedSkipOnboarding(userDataDir)
    let app: ElectronApplication | undefined
    let page: Page

    const marker = 'CORTANA-TERM-ALIVE'
    try {
      ;({ app, page } = await launchApp(userDataDir))

      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('mode-cortana').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
      await expect(page.getByTestId('cortana-tag')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

      await page.getByTestId('tab-terminal').click()
      const term = page.getByTestId('terminal-body')
      const rows = term.locator('.xterm-rows')
      await expect(term).toBeVisible({ timeout: 15_000 })
      await term.click()
      await expect.poll(async () => rows.textContent(), { timeout: 20_000 }).toMatch(/[%$#>]/)
      await page.waitForTimeout(400)
      await page.keyboard.type(`echo ${marker}`)
      await page.keyboard.press('Enter')
      // xterm textContent joins rows without "\n"; require the marker twice
      // (typed command + echo output), not merely the command line.
      await expect
        .poll(async () => {
          const text = (await rows.textContent()) ?? ''
          return (text.match(new RegExp(marker, 'g')) ?? []).length
        }, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(2)
      await page.screenshot({ path: join(artifactsDir, 'cortana-terminal-after-create.png') })

      const sessionId = await page
        .locator('[data-testid="session-row"][data-active="true"]')
        .getAttribute('data-session-id')
      expect(sessionId).toBeTruthy()

      await app.close()
      app = undefined

      ;({ app, page } = await launchApp(userDataDir))
      await expect(page.getByTestId('session-row')).toBeVisible({ timeout: 20_000 })
      await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()
      // Closed/idle Cortana shows the reconnect gate; open sessions show the tool rail.
      const gate = page.getByTestId('session-reconnect-button')
      const rail = page.getByTestId('workspace-tool-rail')
      await expect.poll(async () => {
        if (await gate.isVisible().catch(() => false)) return 'gate'
        if (await rail.isVisible().catch(() => false)) return 'rail'
        return 'wait'
      }, { timeout: 30_000 }).not.toBe('wait')
      if (await gate.isVisible().catch(() => false)) {
        await gate.click()
      }
      await expect(rail).toBeVisible({ timeout: 45_000 })
      await page.getByTestId('tab-terminal').click()
      const term2 = page.getByTestId('terminal-body')
      const rows2 = term2.locator('.xterm-rows')
      await expect(term2).toBeVisible({ timeout: 20_000 })
      await term2.click()
      await expect.poll(async () => rows2.textContent(), { timeout: 25_000 }).toMatch(/[%$#>]/)
      await page.waitForTimeout(400)
      const marker2 = 'CORTANA-TERM-RELAUNCH'
      await page.keyboard.type(`echo ${marker2}`)
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const text = (await rows2.textContent()) ?? ''
          return (text.match(new RegExp(marker2, 'g')) ?? []).length
        }, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(2)
      await page.screenshot({ path: join(artifactsDir, 'cortana-terminal-after-relaunch.png') })

      // Closed Cortana: close clears the selection; re-selecting shows the
      // reconnect gate (not a dead Terminal slot).
      await page
        .locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)
        .getByTestId('session-menu-button')
        .click()
      await page.getByTestId('menu-close').click()
      await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()
      await expect(page.getByTestId('session-disconnected-panel')).toBeVisible({ timeout: 10_000 })
      await expect(page.getByTestId('workspace-tool-rail')).toHaveCount(0)
      await page.getByTestId('session-reconnect-button').click()
      await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 45_000 })
      await page.getByTestId('tab-terminal').click()
      const term3 = page.getByTestId('terminal-body')
      const rows3 = term3.locator('.xterm-rows')
      await expect(term3).toBeVisible({ timeout: 20_000 })
      await term3.click()
      await expect.poll(async () => rows3.textContent(), { timeout: 25_000 }).toMatch(/[%$#>]/)
      await page.waitForTimeout(400)
      const marker3 = 'CORTANA-TERM-RECONNECT'
      await page.keyboard.type(`echo ${marker3}`)
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const text = (await rows3.textContent()) ?? ''
          return (text.match(new RegExp(marker3, 'g')) ?? []).length
        }, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(2)
      await page.screenshot({ path: join(artifactsDir, 'cortana-terminal-after-reconnect.png') })
    } finally {
      await app?.close().catch(() => undefined)
    }
  })

  test('cortana: ⌘T toggles the Terminal split', async () => {
    test.setTimeout(60_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-cortana-cmdt-'))
    seedSkipOnboarding(userDataDir)
    const { app, page } = await launchApp(userDataDir)

    try {
      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('mode-cortana').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
      await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

      const workspace = page.getByTestId('session-workspace-tabs')
      await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)

      await page.keyboard.press('Meta+t')
      await expect(workspace).toHaveClass(/session-workspace-tabs--split-row/)
      await expect(page.getByTestId('tab-terminal')).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByTestId('terminal-body')).toBeVisible({ timeout: 15_000 })
      await page.screenshot({ path: join(artifactsDir, 'cortana-cmd-t-open.png') })

      await page.keyboard.press('Meta+t')
      await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)
      await expect(page.getByTestId('tab-terminal')).toHaveAttribute('aria-pressed', 'false')
      await page.screenshot({ path: join(artifactsDir, 'cortana-cmd-t-closed.png') })

      // Diff/Files shortcuts must not open tools Cortana does not expose.
      await page.keyboard.press('Meta+d')
      await page.keyboard.press('Meta+f')
      await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)
    } finally {
      await app.close().catch(() => undefined)
    }
  })

  /**
   * After relaunch, in-memory Cortana polls are gone. Selecting the session
   * must reattach to the gateway turn (or finish cleanly). A mid-turn follow-up
   * must not leave Atelier pending on a message_id that never gets an assistant
   * twin (Features/cortana-poll-reattach).
   */
  test('cortana: relaunch mid-turn reattaches poll; follow-up does not hang', async () => {
    test.setTimeout(240_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = join(artifactsDir, 'cortana-reattach-userdata')
    // Fresh dir each run
    execFileSync('rm', ['-rf', userDataDir])
    mkdirSync(userDataDir, { recursive: true })
    seedSkipOnboarding(userDataDir)
    let app: ElectronApplication | undefined
    let page: Page

    try {
      ;({ app, page } = await launchApp(userDataDir))
      await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 20_000 })

      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('mode-cortana').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
      await expect(page.getByTestId('cortana-tag')).toBeVisible({ timeout: 20_000 })
      await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 20_000 })

      const marker = 'POLL-REATTACH-DONE'
      await page.getByTestId('composer-input').fill(
        `Do a brief non-trivial tool investigation (about 30s), then reply with exactly the token ${marker} on its own line.`
      )
      await page.getByTestId('composer-input').press('Enter')
      await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 60_000 })

      const sessionId = await page
        .locator('[data-testid="session-row"][data-active="true"]')
        .getAttribute('data-session-id')
      expect(sessionId).toBeTruthy()

      // streamInput voids sendAndPoll — stop can show before the gateway POST.
      // Wait until the poll is actually attached so relaunch exercises reattach.
      const logPath = join(userDataDir, 'logs', 'main.log')
      await expect
        .poll(() => {
          try {
            const log = readFileSync(logPath, 'utf8')
            return (
              log.includes('cortanaHarness: message sent, polling snapshot') ||
              log.includes('cortanaHarness: inline response received')
            )
          } catch {
            return false
          }
        }, { timeout: 60_000 })
        .toBe(true)

      await app.close()
      app = undefined

      ;({ app, page } = await launchApp(userDataDir))
      await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`)).toBeVisible({
        timeout: 20_000
      })
      await page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`).click()

      // Prefer explicit reconnect so harness resume/reattach/sync always runs.
      const gate = page.getByTestId('session-reconnect-button')
      await expect
        .poll(async () => {
          if (await gate.isVisible().catch(() => false)) return 'gate'
          if (await page.getByTestId('workspace-tool-rail').isVisible().catch(() => false)) return 'rail'
          return 'wait'
        }, { timeout: 45_000 })
        .not.toBe('wait')
      if (await gate.isVisible().catch(() => false)) {
        await gate.click()
      }
      await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 20_000 })

      const stopVisible = await page.getByTestId('stop-button').isVisible().catch(() => false)
      if (stopVisible) {
        await page.getByTestId('composer-input').fill("what's the progress and blocker")
        await page.getByTestId('composer-input').press('Enter')
      }

      await expect
        .poll(async () => page.getByTestId('stop-button').count(), { timeout: 150_000 })
        .toBe(0)

      await expect
        .poll(async () => {
          const msgs = page.locator('[data-testid="transcript-message"]')
          const n = await msgs.count()
          const chunks: string[] = []
          for (let i = 0; i < n; i++) {
            const role = await msgs.nth(i).getAttribute('data-role')
            const text = (await msgs.nth(i).textContent()) ?? ''
            chunks.push(`${role}:${text}`)
          }
          return chunks.join('\n')
        }, { timeout: 90_000 })
        .toMatch(/assistant:.+/i)

      await page.screenshot({ path: join(artifactsDir, 'cortana-poll-reattach-after.png') })

      const log = readFileSync(logPath, 'utf8')
      const reattached = log.includes('reattaching poll to in-flight turn')
      const synced = log.includes('syncing completed turn after resume')
      const completedViaOtherId = log.includes('completing via final_response under different message_id')
      const followUpWithoutNewPoll = log.includes('already polling; posting follow-up without new poll')
      expect(
        reattached || synced || completedViaOtherId || followUpWithoutNewPoll,
        `expected reattach/sync/follow-up fix log; reattached=${reattached} synced=${synced} otherId=${completedViaOtherId} followUp=${followUpWithoutNewPoll}`
      ).toBe(true)
    } finally {
      await app?.close().catch(() => undefined)
    }
  })

  /**
   * Idle Cortana follow-up reconnects via resume(). Must not call
   * syncCompletedTurn for the previous final_response (that duplicated the
   * prior assistant into the transcript — Features/cortana-followup-no-duplicate-sync).
   */
  test('cortana: idle follow-up must not re-emit previous assistant', async () => {
    test.setTimeout(240_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = join(artifactsDir, 'cortana-followup-nodup-userdata')
    execFileSync('rm', ['-rf', userDataDir])
    mkdirSync(userDataDir, { recursive: true })
    seedSkipOnboarding(userDataDir)
    let app: ElectronApplication | undefined
    let page: Page

    const marker1 = 'FOLLOWUP-NO-DUP-A'
    const marker2 = 'FOLLOWUP-NO-DUP-B'
    try {
      ;({ app, page } = await launchApp(userDataDir))
      await expect(page.getByTestId('sidebar')).toBeVisible({ timeout: 20_000 })

      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('mode-cortana').click()
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
      await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 20_000 })

      await page.getByTestId('composer-input').fill(
        `Reply with exactly the token ${marker1} on its own line and nothing else.`
      )
      await page.getByTestId('composer-input').press('Enter')

      const logPath = join(userDataDir, 'logs', 'main.log')
      await expect
        .poll(async () => page.getByTestId('stop-button').count(), { timeout: 150_000 })
        .toBe(0)

      await expect
        .poll(async () => {
          const text = (await page.locator('[data-testid="transcript-message"]').allTextContents()).join('\n')
          return text.includes(marker1)
        }, { timeout: 90_000 })
        .toBe(true)

      const beforeFollowUp = readFileSync(logPath, 'utf8')
      const syncBefore = (beforeFollowUp.match(/syncing completed turn after resume/g) ?? []).length

      await page.getByTestId('composer-input').fill(
        `Reply with exactly the token ${marker2} on its own line and nothing else.`
      )
      await page.getByTestId('composer-input').press('Enter')

      await expect
        .poll(() => {
          const log = readFileSync(logPath, 'utf8')
          return (
            log.includes('message sent, polling snapshot') ||
            log.includes('inline response received') ||
            log.includes('live injection (streamInput')
          )
        }, { timeout: 60_000 })
        .toBe(true)

      // Give syncCompletedTurn a moment if it were wrongly invoked.
      await page.waitForTimeout(2_000)
      const afterFollowUp = readFileSync(logPath, 'utf8')
      const syncAfter = (afterFollowUp.match(/syncing completed turn after resume/g) ?? []).length
      expect(
        syncAfter,
        'follow-up must not syncCompletedTurn the previous final_response'
      ).toBe(syncBefore)

      await expect
        .poll(async () => {
          const msgs = page.locator('[data-testid="transcript-message"][data-role="assistant"]')
          const n = await msgs.count()
          let marker1Count = 0
          let hasMarker2 = false
          for (let i = 0; i < n; i++) {
            const text = (await msgs.nth(i).textContent()) ?? ''
            if (text.includes(marker1)) marker1Count++
            if (text.includes(marker2)) hasMarker2 = true
          }
          return { marker1Count, hasMarker2 }
        }, { timeout: 150_000 })
        .toEqual({ marker1Count: 1, hasMarker2: true })

      await page.screenshot({ path: join(artifactsDir, 'cortana-followup-no-duplicate.png') })
    } finally {
      await app?.close().catch(() => undefined)
    }
  })
})
