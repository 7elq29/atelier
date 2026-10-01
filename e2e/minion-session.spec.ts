/**
 * Minion session e2e — real `aifx mcp call minion-orchestrator` (no mocks).
 * Creates a real do-nothing Minion task, steers it, then cancels it.
 * Also covers attach via Minion web link / task UUID.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

test.describe('minion-session', () => {
  test('create, steer, cancel a Minion task', async () => {
    test.setTimeout(180_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-'))
    seedSkipOnboarding(userDataDir)
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: projectRoot })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    try {
      await page.getByTestId('new-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toBeVisible()
      await page.getByTestId('mode-minion').click()
      await expect(page.getByTestId('minion-repo')).toHaveValue('go-code')
      await expect(page.getByTestId('minion-attach-link')).toBeVisible()
      await page.getByTestId('initial-prompt').fill('Atelier e2e smoke test. Do nothing — just print hello and exit.')
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 60_000 })

      await expect(page.getByTestId('minion-tag').first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(/On it — spinning up a DevPod|Setting up my DevPod/i).first()).toBeVisible({
        timeout: 30_000
      })
      // SETUP card (Cortana-style conversation-status-card) while DevPod comes up.
      await expect(
        page.locator('[data-testid="conversation-status-card"][data-status-kind="minion-setup"]')
      ).toBeVisible({ timeout: 60_000 })
      await expect(page.getByTestId('minion-setup-steps')).toBeVisible()
      await page.screenshot({ path: join(artifactsDir, 'minion-session-created.png') })

      const composer = page.getByTestId('composer-input')
      await composer.click()
      await composer.fill('Please keep it minimal; no code changes needed.')
      await page.getByTestId('send-button').click()
      await expect(page.getByText(/Please keep it minimal/i).first()).toBeVisible({ timeout: 30_000 })
      // Steer is in-flight via Stop chrome — no coordinator transcript ack.
      await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText(/Got it — working/i)).toHaveCount(0)
      await expect(page.getByText(/Stopped\./)).toHaveCount(0)
      await page.screenshot({ path: join(artifactsDir, 'minion-session-steered.png') })

      await page.evaluate(async () => {
        const sessions = await window.atelier.listActiveSessions()
        for (const s of sessions.filter((x) => x.mode === 'minion')) {
          await window.atelier.interruptSession(s.id)
        }
      })
      await expect(page.getByText(/Stopped\./).first()).toBeVisible({ timeout: 30_000 })
      // Cancelled / idle Minion must not keep the sidebar execution glyph.
      await expect(page.getByTestId('session-row').filter({ has: page.getByTestId('minion-tag') }).first().getByTestId('session-dot')).not.toHaveClass(
        /status-working/,
        { timeout: 15_000 }
      )
      await expect(
        page.locator('[data-testid="conversation-status-card"][data-status-kind="minion-setup"]')
      ).toHaveCount(0)
      const texts = await page.getByTestId('transcript-message').allTextContents()
      const joined = texts.join('\n')
      const userSteerIdx = joined.toLowerCase().indexOf('please keep it minimal')
      const stopIdx = joined.indexOf('Stopped.')
      expect(userSteerIdx).toBeGreaterThanOrEqual(0)
      expect(stopIdx).toBeGreaterThan(userSteerIdx)
      expect(joined.indexOf('Stopped.', stopIdx + 1)).toBe(-1)
      await expect(page.getByText(/Got it — working/i)).toHaveCount(0)
      await page.screenshot({ path: join(artifactsDir, 'minion-session-cancelled.png') })
    } finally {
      await page.evaluate(async () => {
        const sessions = await window.atelier.listActiveSessions()
        for (const s of sessions.filter((x) => x.mode === 'minion')) await window.atelier.interruptSession(s.id)
      }).catch(() => undefined)
      await app.close().catch(() => undefined)
    }
  })

  test('attach existing Minion task via link', async () => {
    test.setTimeout(180_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-attach-'))
    seedSkipOnboarding(userDataDir)
    const app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], cwd: projectRoot })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    try {
      await page.getByTestId('new-session-button').click()
      await page.getByTestId('mode-minion').click()
      await page.getByTestId('initial-prompt').fill('Atelier e2e attach seed. Do nothing — print hi and exit.')
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 60_000 })
      await expect(page.getByTestId('minion-tag').first()).toBeVisible({ timeout: 30_000 })

      const taskId = await page.evaluate(async () => {
        const sessions = await window.atelier.listActiveSessions()
        const minion = sessions.find((s) => s.mode === 'minion')
        if (!minion) throw new Error('no minion session')
        return minion.id
      })

      await page.evaluate(async (id) => {
        await window.atelier.closeSession(id)
        await window.atelier.deleteSession(id)
      }, taskId)

      await page.getByTestId('new-session-button').click()
      await page.getByTestId('mode-minion').click()
      const link = `https://minion.uberinternal.com/v2?taskId=${taskId}`
      await page.getByTestId('minion-attach-link').fill(link)
      await expect(page.getByTestId('minion-attach-parsed')).toContainText(taskId)
      await expect(page.getByTestId('start-session-button')).toHaveText(/Attach Session/)
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 60_000 })

      await expect(page.getByTestId('minion-tag').first()).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(/Attached to existing Minion task/i).first()).toBeVisible({ timeout: 30_000 })
      await page.screenshot({ path: join(artifactsDir, 'minion-session-attached.png') })
    } finally {
      await page.evaluate(async () => {
        const sessions = await window.atelier.listActiveSessions()
        for (const s of sessions.filter((x) => x.mode === 'minion')) {
          await window.atelier.interruptSession(s.id).catch(() => undefined)
          await window.atelier.closeSession(s.id).catch(() => undefined)
        }
      }).catch(() => undefined)
      await app.close().catch(() => undefined)
    }
  })
})
