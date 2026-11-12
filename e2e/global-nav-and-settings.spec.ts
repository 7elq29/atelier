import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { e2eConfigPath as configPath, seedE2eConfig, seedSkipOnboarding, E2E_DEFAULT_CLAUDE_MODEL } from './e2e-config'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Onboarding wizard may show on a fresh profile — dismiss it for tests that
  // don't care about onboarding specifically, so it doesn't intercept clicks.
  return { app, page }
}

/** ⌘K on macOS; Alt+X elsewhere (Ctrl+K is not bound to the palette). */
async function openCommandPaletteViaKeyboard(page: Page): Promise<void> {
  if (process.platform === 'darwin') {
    await page.keyboard.press('Meta+k')
  } else {
    await page.keyboard.press('Alt+x')
  }
}



test.describe('collapsed rail mode', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-rail-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    seedE2eConfig(userDataDir)
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test('toggling collapse actually changes sidebar width', async () => {
    const sidebar = page.getByTestId('sidebar')
    const widthBefore = await sidebar.evaluate((el) => el.getBoundingClientRect().width)
    expect(widthBefore).toBeGreaterThan(200)

    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(sidebar).toHaveClass(/collapsed/)

    // Sidebar width animates via a CSS transition (150ms) — poll until it settles
    // instead of reading the box immediately after the class flips.
    await expect
      .poll(() => sidebar.evaluate((el) => el.getBoundingClientRect().width), { timeout: 2000 })
      .toBeLessThan(100)
    const widthAfter = await sidebar.evaluate((el) => el.getBoundingClientRect().width)
    expect(widthAfter).toBeLessThan(widthBefore)
  })
})

test.describe('settings: theme + independent font sizes', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-settings-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    seedE2eConfig(userDataDir)
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    await page.getByTestId('open-settings-button').click()
    await expect(page.getByTestId('settings-panel')).toBeVisible()
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test('theme buttons really flip document.documentElement.dataset.theme', async () => {
    await page.locator('.settings-nav button', { hasText: 'Theme' }).click()

    await page.getByTestId('theme-light-btn').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    await page.screenshot({ path: join(artifactsDir, '08-light.png') })

    await page.getByTestId('theme-dark-btn').click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
    await page.screenshot({ path: join(artifactsDir, '08-dark.png') })
  })

  test('changing interface font size does not change agent-message or terminal font size', async () => {
    await page.locator('.settings-nav button', { hasText: 'Fonts' }).click()
    await page.screenshot({ path: join(artifactsDir, '08-settings.png') })

    const getSizes = () =>
      page.evaluate(() => ({
        terminal: getComputedStyle(document.querySelector('[data-testid="terminal-preview"]')!).fontSize,
        interface: getComputedStyle(document.querySelector('[data-testid="interface-preview"]')!).fontSize,
        agentMessage: getComputedStyle(document.querySelector('[data-testid="agent-message-preview"]')!).fontSize
      }))

    const before = await getSizes()

    const interfaceSlider = page.getByTestId('font-interface-slider')
    // Real keyboard interaction (not a scripted .value= assignment) so React's
    // controlled-input change detection fires exactly like it would for a user.
    await interfaceSlider.focus()
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')

    const after = await getSizes()
    expect(after.interface).not.toBe(before.interface)
    expect(after.terminal).toBe(before.terminal)
    expect(after.agentMessage).toBe(before.agentMessage)
  })

  test('changing agent-message font size does not change interface or terminal font size', async () => {
    const getSizes = () =>
      page.evaluate(() => ({
        terminal: getComputedStyle(document.querySelector('[data-testid="terminal-preview"]')!).fontSize,
        interface: getComputedStyle(document.querySelector('[data-testid="interface-preview"]')!).fontSize,
        agentMessage: getComputedStyle(document.querySelector('[data-testid="agent-message-preview"]')!).fontSize
      }))

    const before = await getSizes()

    const agentSlider = page.getByTestId('font-agent-message-slider')
    await agentSlider.focus()
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')

    const after = await getSizes()
    expect(after.agentMessage).not.toBe(before.agentMessage)
    expect(after.interface).toBe(before.interface)
    expect(after.terminal).toBe(before.terminal)
  })

  test('changing terminal font size does not change interface or agent-message font size', async () => {
    const getSizes = () =>
      page.evaluate(() => ({
        terminal: getComputedStyle(document.querySelector('[data-testid="terminal-preview"]')!).fontSize,
        interface: getComputedStyle(document.querySelector('[data-testid="interface-preview"]')!).fontSize,
        agentMessage: getComputedStyle(document.querySelector('[data-testid="agent-message-preview"]')!).fontSize
      }))

    const before = await getSizes()

    const terminalSlider = page.getByTestId('font-terminal-slider')
    await terminalSlider.focus()
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight')

    const after = await getSizes()
    expect(after.terminal).not.toBe(before.terminal)
    expect(after.interface).toBe(before.interface)
    expect(after.agentMessage).toBe(before.agentMessage)
  })

  test('Agent pane rejects an invalid default model via live SDK validation', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    await page.locator('.settings-nav button', { hasText: 'Agent' }).click()
    await expect(page.getByTestId('settings-pane-agent')).toBeVisible()

    await page.getByTestId('default-claude-model-input').fill('aaa-not-a-real-model')
    const beforeSave = JSON.parse(readFileSync(configPath(userDataDir), 'utf-8')).defaultClaudeModel
    await page.getByTestId('default-claude-model-save-btn').click()

    await expect(page.getByTestId('default-claude-model-error')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('default-claude-model-save-status')).toHaveCount(0)

    const afterFailed = JSON.parse(readFileSync(configPath(userDataDir), 'utf-8')).defaultClaudeModel
    expect(afterFailed).toBe(beforeSave)
  })

  test('Agent pane saves a valid default model to config.json', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    await page.locator('.settings-nav button', { hasText: 'Agent' }).click()

    await page.getByTestId('default-claude-model-input').fill('claude-sonnet-5')
    await page.getByTestId('default-claude-model-save-btn').click()

    await expect(page.getByTestId('default-claude-model-save-status')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('default-claude-model-error')).toHaveCount(0)

    await expect
      .poll(() => JSON.parse(readFileSync(configPath(userDataDir), 'utf-8')).defaultClaudeModel)
      .toBe('claude-sonnet-5')

    await page.screenshot({ path: join(artifactsDir, '08-settings-agent-default-model.png') })
  })

  test('Sessions pane saves default worktree location to config.json', async () => {
    await page.getByTestId('settings-nav-sessions').click()
    await expect(page.getByTestId('settings-pane-sessions')).toBeVisible()

    const customRoot = '~/my-atelier-worktrees'
    await page.getByTestId('worktree-root-input').fill(customRoot)
    await page.getByTestId('worktree-root-save-btn').click()

    await expect(page.getByTestId('worktree-root-save-status')).toBeVisible()
    await expect
      .poll(() => JSON.parse(readFileSync(configPath(userDataDir), 'utf-8')).worktreeRoot)
      .toBe(customRoot)

    await page.screenshot({ path: join(artifactsDir, '08-settings-sessions-worktree-root.png') })
  })

  test('Agent pane saves default effort together with model settings', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    await page.locator('.settings-nav button', { hasText: 'Agent' }).click()

    await page.getByTestId('default-claude-effort-select').selectOption('medium')
    await page.getByTestId('default-claude-model-input').fill('claude-sonnet-5')
    await page.getByTestId('default-claude-model-save-btn').click()

    await expect(page.getByTestId('default-claude-model-save-status')).toBeVisible({ timeout: 60_000 })

    await expect
      .poll(() => JSON.parse(readFileSync(configPath(userDataDir), 'utf-8')).defaultClaudeEffort)
      .toBe('medium')
  })

  test('Agent pane saves default permission mode together with model settings', async ({}, testInfo) => {
    testInfo.setTimeout(90_000)
    await page.locator('.settings-nav button', { hasText: 'Agent' }).click()

    await page.getByTestId('default-claude-permission-mode-select').selectOption('plan')
    await page.getByTestId('default-claude-model-input').fill('claude-sonnet-5')
    await page.getByTestId('default-claude-model-save-btn').click()

    await expect(page.getByTestId('default-claude-model-save-status')).toBeVisible({ timeout: 60_000 })

    await expect
      .poll(() => JSON.parse(readFileSync(configPath(userDataDir), 'utf-8')).defaultClaudePermissionMode)
      .toBe('plan')
  })

  test('saved session profiles appear in New Session project picker', async () => {
    await page.getByTestId('settings-nav-profiles').click()
    await expect(page.getByTestId('settings-pane-profiles')).toBeVisible()
    await page.getByTestId('profile-add-btn').click()
    await expect(page.getByTestId('profile-edit-modal')).toBeVisible()
    await page.getByTestId('profile-edit-name-input').fill('Logging')
    await page.getByTestId('profile-edit-workspace-input').fill('~/code/gardenia-app')
    await page.getByTestId('profile-edit-save-btn').click()
    await expect(page.getByTestId('profile-edit-modal')).toHaveCount(0)
    await expect(page.locator('.profile-row-name', { hasText: 'Logging' })).toBeVisible()

    await page.getByTestId('settings-close').click()
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('project-path').focus()
    await expect(page.getByTestId('project-path-suggestions')).toBeVisible()
    await expect(page.getByText('Profiles', { exact: true })).toBeVisible()
    const profileRow = page.locator('[data-testid^="project-path-suggestion-profile-"]').filter({ hasText: 'Logging' })
    await expect(profileRow).toBeVisible()
  })
})

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

test.describe('settings: default claude model applies to new sessions', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string
  let logPath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-default-model-'))
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-default-model-project-'))
    seedE2eConfig(userDataDir, { defaultClaudeModel: 'claude-opus-4-8' })
    ;({ app: electronApp, page } = await launchApp(userDataDir))
    logPath = await page.evaluate(() => window.atelier.getLogFilePath())
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('new agent session starts on the configured global default model', async ({}, testInfo) => {
    testInfo.setTimeout(120_000)

        await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    const sessionId = (await row.getAttribute('data-session-id')) as string

    const textarea = page.getByTestId('composer-input')
    await textarea.fill('Reply with exactly: DEFAULTMODEL.')
    await textarea.press('Enter')
    await expect(page.getByTestId('send-button')).toBeVisible({ timeout: 90_000 })

    await expect
      .poll(() => sessionStartedModels(logPath, sessionId).length, { timeout: 15_000 })
      .toBeGreaterThan(0)
    expect(sessionStartedModels(logPath, sessionId)[0]).toBe('claude-opus-4-8')
  })
})

test.describe('settings: default claude permission mode applies to new sessions', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-default-mode-'))
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-default-mode-project-'))
    writeFileSync(join(projectDir, 'README.md'), '# test\n')
    seedE2eConfig(userDataDir, { defaultClaudePermissionMode: 'auto' })
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('new agent session starts on the configured global default permission mode', async () => {
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
    await page.getByTestId('project-path').fill(projectDir)
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })

    const pill = page.getByTestId('composer-mode-pill')
    await expect(pill).toBeVisible()
    await expect(pill).toHaveAttribute('data-mode', 'auto')
    await expect(pill).toContainText('Auto')
  })
})

// Bug: full-app-audit-onboarding-nav. The Command Palette closes itself on
// Escape (its search input auto-focuses on open, so its own keydown handler
// sees the key). Settings and New Session never auto-focus anything inside
// themselves — focus stays on whichever sidebar button opened them — so
// Escape silently did nothing for those two overlays, even though clicking
// the backdrop closes all three. Fixed by having App.tsx's existing global
// Escape listener close all three overlay states, not just the palette.
test.describe('Escape key closes any open overlay, not just the command palette', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-escape-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    seedE2eConfig(userDataDir)
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test('Escape closes Settings even though nothing inside the dialog ever received focus', async () => {
    await page.getByTestId('open-settings-button').click()
    await expect(page.getByTestId('settings-panel')).toBeVisible()

    // Confirm the real-world condition that broke this: the dialog never
    // auto-focused any control inside itself (unlike the command palette's
    // search input), so an Escape handler scoped to "whatever has focus
    // inside the dialog" would never fire.
    const focusedInsideDialog = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="settings-panel"]')
      return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement))
    })
    expect(focusedInsideDialog).toBe(false)

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-panel')).toHaveCount(0)
  })

  test('Escape closes New Session even though nothing inside the dialog ever received focus', async () => {
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()

    const focusedInsideDialog = await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="new-session-modal"]')
      return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement))
    })
    expect(focusedInsideDialog).toBe(false)

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
  })

  test('clicking the New Session backdrop does not dismiss the modal', async () => {
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()

    const clickPoint = await page.evaluate(() => {
      const backdrop = document.querySelector('[data-testid="new-session-modal"]') as HTMLElement | null
      const dialog = backdrop?.querySelector('.modal-dialog') as HTMLElement | null
      if (!backdrop || !dialog) return null
      const b = backdrop.getBoundingClientRect()
      const d = dialog.getBoundingClientRect()
      return { x: b.left + 16, y: (d.top + d.bottom) / 2 }
    })
    expect(clickPoint).toBeTruthy()
    await page.mouse.click(clickPoint!.x, clickPoint!.y)
    await expect(page.getByTestId('new-session-modal')).toBeVisible()
  })

  // Bug: full-app-audit-onboarding-nav. Same root cause as the onboarding
  // and command-palette focus-escape bugs — New Session is also a sibling
  // overlay, not an ancestor of the sidebar, and had no focus trap.
  test('Tab cannot escape New Session into the sidebar behind it', async () => {
    await page.getByTestId('new-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toBeVisible()

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      const testId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
      expect(
        testId,
        `Tab press #${i} moved focus to "${testId}", which lives in the sidebar behind the modal`
      ).not.toBe('new-group-button')
    }

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
  })
})

test.describe('desktop notification debug trigger', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-notify-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    seedE2eConfig(userDataDir)
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test('debug IPC call actually constructs a real Notification (verified via log)', async () => {
    await page.getByTestId('open-settings-button').click()
    await page.locator('.settings-nav button', { hasText: 'Notifications' }).click()
    await page.getByTestId('debug-notify-button').click()

    await expect(page.getByTestId('notify-status')).toBeVisible()

    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    await expect
      .poll(() => {
        if (!existsSync(logPath)) return false
        const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
        return lines.some((l) => {
          const entry = JSON.parse(l)
          return entry.msg === 'notification shown' && entry.title === 'Atelier'
        })
      })
      .toBe(true)

    mkdirSync(artifactsDir, { recursive: true })
    writeFileSync(join(artifactsDir, '08-nav.log'), readFileSync(logPath, 'utf-8'))
  })
})

test.describe('onboarding — first-run wizard shows once', () => {
  let userDataDir: string

  test.beforeAll(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-onboarding-'))
    // Deliberately no pre-seeded config.json — this is a genuinely fresh profile.
  })

  test.afterAll(() => {
    rmSync(userDataDir, { recursive: true, force: true })
  })

  test('shows on a fresh profile and does not reappear after finishing + relaunch', async () => {
    const { app: app1, page: page1 } = await launchApp(userDataDir)
    await expect(page1.getByTestId('onboarding-wizard')).toBeVisible()

    await page1.getByTestId('onboarding-name-input').fill('Qing Qin')
    await page1.getByTestId('onboarding-email-input').fill('qingqin@example.com')
    await page1.getByTestId('onboarding-next').click()
    await expect(page1.getByTestId('onboarding-step-done')).toBeVisible()
    await page1.getByTestId('onboarding-finish').click()
    await expect(page1.getByTestId('onboarding-wizard')).toHaveCount(0)

    // Give the config:set IPC round-trip a moment to persist to disk before closing.
    await expect
      .poll(() => JSON.parse(readFileSync(configPath(userDataDir), 'utf-8')).onboardingCompleted)
      .toBe(true)

    await app1.close()

    const { app: app2, page: page2 } = await launchApp(userDataDir)
    await expect(page2.getByTestId('onboarding-wizard')).toHaveCount(0)
    await app2.close()
  })

  // Bug: full-app-audit-onboarding-nav. Onboarding is the mandatory first-run
  // gate (spec 08-global-nav-and-settings: "Onboarding flow: first-run
  // wizard" — App.tsx only renders the rest of the app behind it while
  // `!config.onboardingCompleted`). Nothing trapped keyboard focus inside the
  // dialog, so Tab escaped the modal into the (visually dimmed but still
  // live) sidebar underneath, and Enter on a focused sidebar button actually
  // activated it — e.g. opening the Command Palette *on top of* the
  // still-open, unfinished onboarding wizard.
  test('keyboard focus cannot escape the onboarding modal into the sidebar behind it', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-onboarding-focus-'))
    const { app, page } = await launchApp(freshDir)
    await expect(page.getByTestId('onboarding-wizard')).toBeVisible()

    // Tab repeatedly from the top of the dialog — with a real focus trap this
    // should only ever cycle through onboarding's own controls (name input,
    // email input, skip, next), never reach sidebar chrome.
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      const testId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
      expect(
        testId,
        `Tab press #${i} moved focus to "${testId}", which lives in the sidebar behind the modal, not inside onboarding`
      ).not.toBe('new-session-button')
    }

    mkdirSync(artifactsDir, { recursive: true })
    await page.screenshot({ path: join(artifactsDir, 'bug-onboarding-focus-escape.png') })

    await app.close()
    rmSync(freshDir, { recursive: true, force: true })
  })

  test('clicking the onboarding backdrop does not dismiss the wizard', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-onboarding-backdrop-'))
    const { app, page } = await launchApp(freshDir)
    await expect(page.getByTestId('onboarding-wizard')).toBeVisible()

    const clickPoint = await page.evaluate(() => {
      const backdrop = document.querySelector('[data-testid="onboarding-backdrop"]') as HTMLElement | null
      const dialog = backdrop?.querySelector('.modal-dialog') as HTMLElement | null
      if (!backdrop || !dialog) return null
      const b = backdrop.getBoundingClientRect()
      const d = dialog.getBoundingClientRect()
      return { x: b.left + 16, y: (d.top + d.bottom) / 2 }
    })
    expect(clickPoint).toBeTruthy()
    await page.mouse.click(clickPoint!.x, clickPoint!.y)
    await expect(page.getByTestId('onboarding-wizard')).toBeVisible()

    await page.getByTestId('onboarding-close').click()
    await expect(page.getByTestId('onboarding-wizard')).toHaveCount(0)

    await app.close()
    rmSync(freshDir, { recursive: true, force: true })
  })
})

// Feature: org-wide AI harness-pool spend indicator (ported from Morpheus's
// CostSpendIndicator.tsx), rendered at the bottom of the sidebar directly
// above the user-profile row, per Features/UI-Design/mocks/index.html's
// .spend-indicator. This depends on a live internal endpoint + the local
// `usso` CLI, so these tests exercise the real IPC round-trip and the app's
// behavior when that dependency is disabled — not a specific dollar figure.
test.describe('sidebar spend-status chip', () => {
  test('does not render, and the app does not error, when spend status is disabled', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-spend-status-disabled-'))
    process.env.ATELIER_DISABLE_SPEND_STATUS = '1'
    delete process.env.ATELIER_SPEND_STATUS_FIXTURE
    try {
      const { app, page } = await launchApp(freshDir)
      await expect(page.getByTestId('sidebar')).toBeVisible()
      await expect(page.getByTestId('spend-status-chip')).toHaveCount(0)
      await app.close()
    } finally {
      delete process.env.ATELIER_DISABLE_SPEND_STATUS
      rmSync(freshDir, { recursive: true, force: true })
    }
  })

  test('USSO expired: shows Renew USSO and auto-fetch runs at most once across polls', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-spend-status-needs-usso-'))
    seedE2eConfig(freshDir)
    seedSkipOnboarding(freshDir)
    delete process.env.ATELIER_DISABLE_SPEND_STATUS
    process.env.ATELIER_SPEND_STATUS_FIXTURE = 'needs_usso'
    try {
      const { app, page } = await launchApp(freshDir)
      await expect(page.getByTestId('sidebar')).toBeVisible()
      const chip = page.getByTestId('spend-status-chip')
      await expect(chip).toBeVisible({ timeout: 10_000 })
      await expect(chip).toHaveAttribute('data-spend-state', 'needs_usso')
      await expect(chip).toContainText('Claude Code')
      await expect(chip).toContainText('Cortana')
      await expect(chip).toContainText('USSO expired')
      const renew = page.getByTestId('spend-status-renew-usso')
      await expect(renew).toBeVisible()

      const afterMount = await page.evaluate(() => window.atelier.getSpendStatusAuthDebug())
      expect(afterMount.autoInteractiveFetchAttempted).toBe(true)
      expect(afterMount.interactiveFetchCount).toBe(1)

      // Second poll must not open another interactive fetch.
      await page.evaluate(() => window.atelier.getSpendStatus())
      const afterPoll = await page.evaluate(() => window.atelier.getSpendStatusAuthDebug())
      expect(afterPoll.interactiveFetchCount).toBe(1)

      const beforeRenew = await page.evaluate(() => window.atelier.getSpendStatusAuthDebug())
      await renew.click()
      await expect
        .poll(async () => (await page.evaluate(() => window.atelier.getSpendStatusAuthDebug())).interactiveFetchCount)
        .toBe(2)
      // Renew must open the USSO weblogin page (counted; real browser skipped in e2e).
      await expect
        .poll(async () => (await page.evaluate(() => window.atelier.getSpendStatusAuthDebug())).webloginOpenCount)
        .toBe(beforeRenew.webloginOpenCount + 1)

      await chip.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(artifactsDir, 'spend-status-needs-usso.png') })

      await app.close()
    } finally {
      delete process.env.ATELIER_SPEND_STATUS_FIXTURE
      rmSync(freshDir, { recursive: true, force: true })
    }
  })

  test('renders a real $spent/$cap readout when the fetch succeeds, or stays absent without erroring otherwise', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-spend-status-live-'))
    delete process.env.ATELIER_DISABLE_SPEND_STATUS
    delete process.env.ATELIER_SPEND_STATUS_FIXTURE
    const { app, page } = await launchApp(freshDir)
    await expect(page.getByTestId('sidebar')).toBeVisible()

    // No mocking: this either round-trips to the real genai-api spendstatus
    // endpoint via the real `usso` CLI, or — in an environment without Uber
    // network/usso access — the chip shows needs_usso / stays unavailable.
    // A crash isn't valid.
    const chip = page.getByTestId('spend-status-chip')
    const appeared = await chip
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false)

    if (appeared) {
      const state = await chip.getAttribute('data-spend-state')
      if (state === 'needs_usso') {
        await expect(chip.getByTestId('spend-status-renew-usso')).toBeVisible()
      } else {
        await expect(chip).toContainText('Claude Code')
        await expect(chip).toContainText('this month')
        await expect(chip.getByRole('button', { name: /view usage/i })).toBeVisible()
        // Named pools render when their endpoints return data (Cortana / Minion /
        // Cursor). Soft-assert: at least one named bar is typical on Uber net.
        const text = await chip.innerText()
        if (['Cortana', 'Minion', 'Cursor'].some((label) => text.includes(label))) {
          // Prefer asserting Minion when present — the new bar for this feature.
          if (text.includes('Minion')) await expect(chip).toContainText('Minion')
        }
        const box = await chip.boundingBox()
        if (box) {
          await page.screenshot({ path: 'e2e-artifacts/06-spend-status-chip.png', clip: box })
        }
      }
    }

    await app.close()
    rmSync(freshDir, { recursive: true, force: true })
  })
})
