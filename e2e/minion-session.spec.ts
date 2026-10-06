/**
 * Minion session e2e — real `aifx mcp call minion-orchestrator` (no mocks).
 * Creates a real do-nothing Minion task, steers it, then cancels it.
 * Also covers attach via Minion web link / task UUID.
 *
 * Launches Electron with a Dock-like sparse env (not the developer shell PATH).
 * Without forcing `--usso` in MinionHarness, aifx routes to muttley on
 * localhost:5436 and createtask fails — the same failure as packaged Atelier.
 */
import { test, expect, _electron as electron } from '@playwright/test'
import { seedSkipOnboarding } from './e2e-config'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')

/** macOS GUI / Dock launch env — must not inherit the login-shell PATH. */
function guiLikeElectronEnv(): Record<string, string> {
  const env: Record<string, string> = {
    // Match Finder/Dock: system paths only. aifx / homebrew are restored inside
    // the app via augmentProcessPathForGuiLaunch + subprocessEnvWithDevPath.
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? '',
    USER: process.env.USER ?? '',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
    SHELL: process.env.SHELL ?? '/bin/zsh'
  }
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'SSH_AUTH_SOCK', 'ELECTRON_RUN_AS_NODE'] as const) {
    const v = process.env[key]
    if (v) env[key] = v
  }
  return env
}

async function launchMinionApp(userDataDir: string) {
  return electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: guiLikeElectronEnv()
  })
}

test.describe('minion-session', () => {
  test('create, steer, cancel a Minion task', async () => {
    test.setTimeout(180_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-'))
    seedSkipOnboarding(userDataDir)
    const app = await launchMinionApp(userDataDir)
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

      // Composer Stop tracks remote lifetime (empty input), not each progress tick.
      await expect(page.getByTestId('stop-button')).toBeVisible({ timeout: 60_000 })

      const composer = page.getByTestId('composer-input')
      await composer.click()
      await composer.fill('Please keep it minimal; no code changes needed.')
      // Typed while remote-active: Send (steer), not Queue.
      await expect(page.getByTestId('send-button')).toBeVisible()
      await expect(page.getByTestId('send-button')).toHaveAttribute('aria-label', 'Send')
      await page.getByTestId('send-button').click()
      await expect(page.getByText(/Please keep it minimal/i).first()).toBeVisible({ timeout: 30_000 })
      // After steer, composer clears → Stop again while remote still active.
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

  /**
   * Scratch chat.jsonl seed — attach a completed task that still has DevPod
   * scratch (listScratchFiles). Fresh createtask often stays in Connect DNS
   * for minutes before scratch is reachable; this covers the Working/tool UI.
   */
  test('attach seeds scratch tool timeline from chat.jsonl', async () => {
    test.setTimeout(180_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-scratch-'))
    seedSkipOnboarding(userDataDir)
    const app = await launchMinionApp(userDataDir)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Known completed task with ~320KB chat.jsonl (Validate SKILL / Bash tools).
    const taskId = '2f7abb6b-1622-44f1-ae3e-1fb17f219a1b'

    try {
      await page.getByTestId('new-session-button').click()
      await page.getByTestId('mode-minion').click()
      await page.getByTestId('minion-attach-link').fill(`https://minion.uberinternal.com/v2?taskId=${taskId}`)
      await expect(page.getByTestId('minion-attach-parsed')).toContainText(taskId)
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 60_000 })
      await expect(page.getByText(/Attached to existing Minion task/i).first()).toBeVisible({ timeout: 30_000 })

      // Seeded scratch → tool cards (and/or Working chrome while still active).
      const scratchUi = page
        .getByTestId('tool-card')
        .or(page.locator('[data-testid="conversation-status-card"][data-status-kind="minion-working"]'))
      await expect(scratchUi.first()).toBeVisible({ timeout: 90_000 })
      await page.screenshot({ path: join(artifactsDir, 'minion-session-scratch-progress.png') })
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

  /**
   * Finished/cancelled task follow-up must CreateTask(parent) to relaunch a
   * DevPod — not CreateInteraction alone (messages sat PENDING forever).
   */
  test('follow-up on cancelled task relaunches DevPod with SETUP', async () => {
    test.setTimeout(180_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-relaunch-'))
    seedSkipOnboarding(userDataDir)
    const app = await launchMinionApp(userDataDir)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')

    // Known CANCELLED task (DevPod gone); follow-up must mint a child task.
    const taskId = '2f46e72a-aff3-43bc-a355-b5ff64ca763e'

    try {
      await page.getByTestId('new-session-button').click()
      await page.getByTestId('mode-minion').click()
      await page.getByTestId('minion-attach-link').fill(`https://minion.uberinternal.com/v2?taskId=${taskId}`)
      await expect(page.getByTestId('minion-attach-parsed')).toContainText(taskId)
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 60_000 })
      await expect(page.getByText(/Attached to existing Minion task/i).first()).toBeVisible({ timeout: 30_000 })

      const composer = page.getByTestId('composer-input')
      await composer.click()
      await composer.fill('Atelier e2e relaunch probe. Reply hello and stop — no code changes.')
      await page.getByTestId('send-button').click()

      await expect(page.getByText(/Relaunching a DevPod from this job/i).first()).toBeVisible({
        timeout: 90_000
      })
      await expect(
        page.locator('[data-testid="conversation-status-card"][data-status-kind="minion-setup"]')
      ).toBeVisible({ timeout: 60_000 })
      await page.screenshot({ path: join(artifactsDir, 'minion-session-finished-relaunch.png') })
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

  test('attach existing Minion task via link', async () => {
    test.setTimeout(180_000)
    mkdirSync(artifactsDir, { recursive: true })
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-minion-attach-'))
    seedSkipOnboarding(userDataDir)
    const app = await launchMinionApp(userDataDir)
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

      // Already-open attach must focus the same row — never createtask a twin.
      await page.getByTestId('new-session-button').click()
      await page.getByTestId('mode-minion').click()
      await page.getByTestId('minion-attach-link').fill(`https://minion.uberinternal.com/v2/${taskId}`)
      await expect(page.getByTestId('minion-attach-parsed')).toContainText(taskId)
      await page.getByTestId('start-session-button').click()
      await expect(page.getByTestId('new-session-modal')).toHaveCount(0, { timeout: 15_000 })
      await expect(page.locator('[data-testid="session-row"][data-mode="minion"]')).toHaveCount(1)
      // Still the original create ack only — attach-of-open must not mint a second task.
      await expect(page.getByText(/spinning up a DevPod/i)).toHaveCount(1)

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
      // Fresh attach row: attach ack only — no createtask DevPod line.
      await expect(page.getByText(/spinning up a DevPod/i)).toHaveCount(0)
      await expect(page.locator('[data-testid="session-row"][data-mode="minion"]')).toHaveCount(1)
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
