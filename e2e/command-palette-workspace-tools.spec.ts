import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedSkipOnboarding } from './e2e-config'

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: join(__dirname, '..')
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function runPaletteCommand(page: Page, label: string): Promise<void> {
  if (process.platform === 'darwin') {
    await page.keyboard.press('Meta+k')
  } else {
    await page.keyboard.press('Alt+x')
  }
  const input = page.getByTestId('command-palette-input')
  await expect(input).toBeFocused()
  await input.fill(label)
  const item = page.getByTestId('command-palette-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText(label)
  await expect(item).toContainText('Workspace')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
}

test.describe.configure({ mode: 'serial' })

test.describe('command palette workspace tools', () => {
  let electronApp: ElectronApplication
  let page: Page
  let projectPath: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-palette-workspace-'))
    seedSkipOnboarding(userDataDir)
    projectPath = join(userDataDir, 'project')
    mkdirSync(projectPath, { recursive: true })
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('Diff, Files, and Terminal commands open and replace the local right pane', async () => {
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('project-path').fill(projectPath)
    await page.getByTestId('project-path').blur()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill('Reply with exactly the single word: READY')
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('workspace-tool-rail')).toBeVisible({ timeout: 20_000 })

    const workspace = page.getByTestId('session-workspace-tabs')
    for (const [label, tab] of [
      ['Open Diff', 'diff'],
      ['Open Files', 'files'],
      ['Open Terminal', 'terminal']
    ] as const) {
      await runPaletteCommand(page, label)
      await expect(workspace).toHaveClass(/session-workspace-tabs--split-row/)
      await expect(page.locator(`.tab-content[data-tab="${tab}"]`)).toHaveClass(
        /workspace-split-pane--secondary/
      )
    }

    if (process.platform === 'darwin') {
      await page.keyboard.press('Meta+k')
    } else {
      await page.keyboard.press('Alt+x')
    }
    await page.getByTestId('command-palette-input').fill('Open Ports')
    await expect(page.getByTestId('command-palette-empty')).toBeVisible()
    await page.keyboard.press('Escape')
  })

  test('Command shortcuts toggle workspace tools, Timeline, and the left sidebar', async () => {
    const workspace = page.getByTestId('session-workspace-tabs')

    // The previous test leaves Terminal open.
    await page.keyboard.press('Meta+t')
    await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)

    for (const [key, tab] of [
      ['Meta+d', 'diff'],
      ['Meta+f', 'files'],
      ['Meta+t', 'terminal']
    ] as const) {
      await page.keyboard.press(key)
      await expect(workspace).toHaveClass(/session-workspace-tabs--split-row/)
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-pressed', 'true')

      await page.keyboard.press(key)
      await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)
      await expect(page.getByTestId(`tab-${tab}`)).toHaveAttribute('aria-pressed', 'false')
    }

    // Ports is unavailable for this local session.
    await page.keyboard.press('Meta+p')
    await expect(workspace).not.toHaveClass(/session-workspace-tabs--split/)

    const timelineToggle = page.getByTestId('toggle-daily-notes-panel')
    const timelineWasOpen = (await timelineToggle.getAttribute('aria-pressed')) === 'true'
    await page.keyboard.press('Meta+ArrowRight')
    await expect(timelineToggle).toHaveAttribute('aria-pressed', timelineWasOpen ? 'false' : 'true')
    await expect(page.getByTestId('daily-notes-panel')).toHaveCount(timelineWasOpen ? 0 : 1)
    await page.keyboard.press('Meta+ArrowRight')
    await expect(timelineToggle).toHaveAttribute('aria-pressed', timelineWasOpen ? 'true' : 'false')
    await expect(page.getByTestId('daily-notes-panel')).toHaveCount(timelineWasOpen ? 1 : 0)

    const sidebar = page.getByTestId('sidebar')
    await expect(sidebar).not.toHaveClass(/collapsed/)
    await page.keyboard.press('Meta+ArrowLeft')
    await expect(sidebar).toHaveClass(/collapsed/)
    await page.keyboard.press('Meta+ArrowLeft')
    await expect(sidebar).not.toHaveClass(/collapsed/)
  })

  test('Ports command is available for a remote session and opens the right pane', async () => {
    await page.getByTestId('new-session-button').click()
    await page.getByTestId('host-option-devpod-us-or').click()
    await page.getByTestId('project-path').fill('/home/user')
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)
    await expect(page.getByTestId('tab-ports')).toBeVisible({ timeout: 20_000 })

    await runPaletteCommand(page, 'Open Ports')
    await expect(page.getByTestId('session-workspace-tabs')).toHaveClass(
      /session-workspace-tabs--split-row/
    )
    await expect(page.locator('.tab-content[data-tab="ports"]')).toHaveClass(
      /workspace-split-pane--secondary/
    )

    await page.keyboard.press('Meta+p')
    await expect(page.getByTestId('session-workspace-tabs')).not.toHaveClass(
      /session-workspace-tabs--split/
    )
    await page.keyboard.press('Meta+p')
    await expect(page.locator('.tab-content[data-tab="ports"]')).toHaveClass(
      /workspace-split-pane--secondary/
    )
  })
})
