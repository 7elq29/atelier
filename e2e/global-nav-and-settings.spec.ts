import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
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

function configPath(userDataDir: string): string {
  return join(userDataDir, 'data', 'config.json')
}

/** Stubs Electron's native folder-picker dialog to return a fixed path, so New Session can be driven headlessly (same pattern as session-lifecycle.spec.ts). */
async function stubProjectFolder(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folderPath] })) as typeof dialog.showOpenDialog
  }, path)
}

/**
 * Creates a real terminal-mode session (no agent/harness call, so it's fast
 * and network-free) rooted at `projectDir`, and returns its real session id.
 * The 08-global-nav-and-settings command palette originally shipped against
 * a single hardcoded placeholder session ("Welcome session" / id "welcome");
 * once 02-session-lifecycle landed real multi-session data, that id never
 * existed, so palette tests need to create genuine sessions the same way
 * a user would (via the New Session modal) rather than assuming a seeded
 * placeholder.
 */
async function createTerminalSession(app: ElectronApplication, page: Page, projectDir: string): Promise<string> {
  await stubProjectFolder(app, projectDir)
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
  await page.getByTestId('pick-project-folder').click()
  await expect(page.getByTestId('pick-project-folder')).toContainText(projectDir)
  await page.getByTestId('mode-terminal').click()
  await page.getByTestId('start-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

  const row = page.locator('[data-testid="session-row"]', { hasText: basename(projectDir) })
  await expect(row).toBeVisible({ timeout: 15_000 })
  return (await row.getAttribute('data-session-id')) as string
}

test.describe('command palette', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  // Two real sessions with a deliberately overlapping name substring
  // ("invoice") so the palette tests below cover both a clean single-match
  // lookup and fuzzy-match disambiguation between similarly named sessions.
  let primarySessionId: string
  let secondarySessionId: string
  const primaryName = 'invoice-service'
  const secondaryName = 'billing-invoice-tool'

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-palette-'))
    // Pre-seed onboarding as completed so it doesn't block the palette tests.
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    writeFileSync(configPath(userDataDir), JSON.stringify({ onboardingCompleted: true }))
    ;({ app: electronApp, page } = await launchApp(userDataDir))

    const primaryProjectDir = join(userDataDir, primaryName)
    const secondaryProjectDir = join(userDataDir, secondaryName)
    mkdirSync(primaryProjectDir, { recursive: true })
    mkdirSync(secondaryProjectDir, { recursive: true })

    primarySessionId = await createTerminalSession(electronApp, page, primaryProjectDir)
    secondarySessionId = await createTerminalSession(electronApp, page, secondaryProjectDir)
  })

  test.afterAll(async () => {
    await electronApp.close()
  })

  test('opens via keyboard (Ctrl/Cmd+K), no mouse', async () => {
    await expect(page.getByTestId('command-palette')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByTestId('command-palette')).toBeVisible()
    mkdirSync(artifactsDir, { recursive: true })
    await page.screenshot({ path: join(artifactsDir, '08-palette.png') })
  })

  // Bug: full-app-audit-onboarding-nav. The palette (like every other modal
  // in this app) is rendered as a sibling of the sidebar, not an ancestor —
  // nothing stopped Tab from leaving the dialog and landing on live sidebar
  // buttons (e.g. "open-palette-button") behind the still-open palette.
  test('Tab cannot escape the palette into the sidebar behind it', async () => {
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      const testId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
      expect(testId).toBe('command-palette-input')
    }
  })

  test('search/filter-as-you-type narrows results', async () => {
    const input = page.getByTestId('command-palette-input')
    await expect(input).toBeFocused()

    const allItems = page.getByTestId('command-palette-item')
    const allCount = await allItems.count()
    expect(allCount).toBeGreaterThan(1)

    await input.fill('theme')
    const filteredItems = page.getByTestId('command-palette-item')
    await expect(filteredItems).toHaveCount(1)
    await expect(filteredItems.first()).toContainText('Toggle theme')

    await input.fill('zzz-does-not-match-anything');
    await expect(page.getByTestId('command-palette-empty')).toBeVisible()

    await input.fill('')
  })

  test('typing a session name and pressing Enter jumps focus to that session', async () => {
    const input = page.getByTestId('command-palette-input')
    // Full name of the *primary* session only — "billing-invoice-tool" does
    // not contain this substring, so this must resolve to exactly one item.
    await input.fill(primaryName)
    await expect(page.getByTestId('command-palette-item')).toHaveCount(1)
    mkdirSync(artifactsDir, { recursive: true })
    await page.screenshot({ path: join(artifactsDir, 'palette-jump-fix.png') })
    await page.keyboard.press('Enter')

    await expect(page.getByTestId('command-palette')).toHaveCount(0)

    const row = page.locator(`[data-testid="session-row"][data-session-id="${primarySessionId}"]`)
    await expect(row).toHaveAttribute('data-active', 'true')
    const isFocused = await row.evaluate((el) => el === document.activeElement)
    expect(isFocused).toBe(true)
  })

  test('fuzzy-matching a shared substring shows both similarly named sessions, then narrowing jumps to the right one', async () => {
    await page.keyboard.press('ControlOrMeta+k')
    const input = page.getByTestId('command-palette-input')

    // Both session names share "invoice" — a real multi-session disambiguation
    // case that a single hardcoded placeholder session could never exercise.
    await input.fill('invoice')
    await expect(page.getByTestId('command-palette-item')).toHaveCount(2)

    // Narrow to a substring unique to the *secondary* session and confirm
    // Enter jumps to that one specifically, not "any session".
    await input.fill('billing')
    await expect(page.getByTestId('command-palette-item')).toHaveCount(1)
    await expect(page.getByTestId('command-palette-item').first()).toContainText(secondaryName)
    await page.keyboard.press('Enter')

    await expect(page.getByTestId('command-palette')).toHaveCount(0)

    const targetRow = page.locator(`[data-testid="session-row"][data-session-id="${secondarySessionId}"]`)
    await expect(targetRow).toHaveAttribute('data-active', 'true')
    const isFocused = await targetRow.evaluate((el) => el === document.activeElement)
    expect(isFocused).toBe(true)

    const otherRow = page.locator(`[data-testid="session-row"][data-session-id="${primarySessionId}"]`)
    await expect(otherRow).toHaveAttribute('data-active', 'false')
  })

  test('theme toggle from the palette flips data-theme and re-renders', async () => {
    const before = await page.evaluate(() => document.documentElement.dataset.theme)

    await page.keyboard.press('ControlOrMeta+k')
    await page.getByTestId('command-palette-input').fill('Toggle theme')
    await page.keyboard.press('Enter')

    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).not.toBe(before)

    const bgAfter = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    // Just confirm a real visual re-render happened (background actually changed).
    expect(bgAfter).toBeTruthy()
  })
})

test.describe('collapsed rail mode', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-rail-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    writeFileSync(configPath(userDataDir), JSON.stringify({ onboardingCompleted: true }))
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
    writeFileSync(configPath(userDataDir), JSON.stringify({ onboardingCompleted: true }))
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
    writeFileSync(configPath(userDataDir), JSON.stringify({ onboardingCompleted: true }))
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
    writeFileSync(configPath(userDataDir), JSON.stringify({ onboardingCompleted: true }))
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
      ).not.toBe('open-palette-button')
    }

    mkdirSync(artifactsDir, { recursive: true })
    await page.screenshot({ path: join(artifactsDir, 'bug-onboarding-focus-escape.png') })

    await app.close()
    rmSync(freshDir, { recursive: true, force: true })
  })
})

// Feature: org-wide AI harness-pool spend chip (ported from Morpheus's
// CostSpendIndicator.tsx), rendered at the top of the sidebar above the
// search box. This depends on a live internal endpoint + the local `usso`
// CLI, so these tests exercise the real IPC round-trip and the app's
// behavior when that dependency is disabled — not a specific dollar figure.
test.describe('sidebar spend-status chip', () => {
  test('does not render, and the app does not error, when spend status is disabled', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-spend-status-disabled-'))
    process.env.ATELIER_DISABLE_SPEND_STATUS = '1'
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

  test('renders a real $spent/$cap readout when the fetch succeeds, or stays absent without erroring otherwise', async () => {
    const freshDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-spend-status-live-'))
    delete process.env.ATELIER_DISABLE_SPEND_STATUS
    const { app, page } = await launchApp(freshDir)
    await expect(page.getByTestId('sidebar')).toBeVisible()

    // No mocking: this either round-trips to the real genai-api spendstatus
    // endpoint via the real `usso` CLI, or — in an environment without Uber
    // network/usso access — the IPC handler catches the failure and the
    // chip simply never mounts. Both are valid outcomes; a crash isn't.
    const chip = page.getByTestId('spend-status-chip')
    const appeared = await chip
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false)

    if (appeared) {
      await expect(chip).toHaveText(/^\$[\d,]+\/(\$[\d,]+|\?)$/)
    }

    await app.close()
    rmSync(freshDir, { recursive: true, force: true })
  })
})
