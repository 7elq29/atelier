import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-09-15'

let electronApp: ElectronApplication
let page: Page

test.describe.configure({ mode: 'serial' })

test.describe('sidebar refinement', () => {
  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-sidebar-refinement-'))
    const vaultRoot = join(userDataDir, 'vault')
    const dailyDir = join(vaultRoot, '01.dailynotes', '2026', 'Sep', '15')
    mkdirSync(dailyDir, { recursive: true })
    writeFileSync(
      join(dailyDir, `${TEST_DATE}.md`),
      `---\ndate: ${TEST_DATE}\nday: Tuesday\ntype: daily\n---\n\n## 📋 Tasks\n\n## 📝 Notes\n`,
      'utf8'
    )
    seedE2eConfig(userDataDir)
    mkdirSync(artifactsDir, { recursive: true })

    electronApp = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: join(__dirname, '..'),
      env: {
        ...process.env,
        ATELIER_TEST_VAULT_ROOT: vaultRoot,
        ATELIER_TEST_DATE: TEST_DATE
      }
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.getByTestId('sidebar')).toBeVisible()
  })

  test.afterAll(async () => {
    await electronApp?.close().catch(() => undefined)
  })

  test('note rows are single-line, terminal has its own icon, and typography is compact', async () => {
    const daily = page.getByTestId('daily-note-row')
    const weekly = page.getByTestId('weekly-plan-row')

    await expect(page.getByTestId('app-mark')).toHaveCount(0)
    await expect(page.locator('.user-avatar')).toHaveCount(0)
    const sidebar = await page.getByTestId('sidebar').boundingBox()
    const topRowBox = await page.getByTestId('sidebar-top-row').boundingBox()
    const utilityRow = page.getByTestId('sidebar-utility-row')
    const utilityBox = await utilityRow.boundingBox()
    const newGroup = await page.getByTestId('new-group-button').boundingBox()
    expect(sidebar).not.toBeNull()
    expect(topRowBox).not.toBeNull()
    expect(utilityBox).not.toBeNull()
    expect(newGroup).not.toBeNull()
    expect(topRowBox!.y - sidebar!.y).toBe(8)
    expect(newGroup!.x).toBeLessThan(utilityBox!.x)
    expect(Math.abs(
      newGroup!.y + newGroup!.height / 2 - (utilityBox!.y + utilityBox!.height / 2)
    )).toBeLessThanOrEqual(1)

    const utilityButtons = utilityRow.locator('.sidebar-utility-button')
    await expect(utilityButtons).toHaveCount(3)
    const buttonBoxes = await utilityButtons.evaluateAll((buttons) =>
      buttons.map((button) => {
        const buttonRect = button.getBoundingClientRect()
        const iconRect = button.querySelector('svg')?.getBoundingClientRect()
        return {
          x: buttonRect.x,
          width: buttonRect.width,
          height: buttonRect.height,
          iconWidth: iconRect?.width,
          iconHeight: iconRect?.height
        }
      })
    )
    expect(buttonBoxes.map(({ width, height }) => [width, height])).toEqual([
      [24, 24],
      [24, 24],
      [24, 24]
    ])
    expect(buttonBoxes.map(({ iconWidth, iconHeight }) => [iconWidth, iconHeight])).toEqual([
      [14, 14],
      [14, 14],
      [14, 14]
    ])
    expect(buttonBoxes[1].x - (buttonBoxes[0].x + buttonBoxes[0].width)).toBe(2)
    expect(buttonBoxes[2].x - (buttonBoxes[1].x + buttonBoxes[1].width)).toBe(2)

    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(page.getByTestId('sidebar')).toHaveClass(/collapsed/)
    await page.getByTestId('sidebar-collapse-toggle').click()
    await expect(page.getByTestId('sidebar')).not.toHaveClass(/collapsed/)

    const dailyNotesButton = page.getByTestId('toggle-daily-notes-panel')
    const dailyNotesWasOpen = (await dailyNotesButton.getAttribute('aria-pressed')) === 'true'
    await dailyNotesButton.click()
    await expect(dailyNotesButton).toHaveAttribute('aria-pressed', dailyNotesWasOpen ? 'false' : 'true')
    await dailyNotesButton.click()
    await expect(dailyNotesButton).toHaveAttribute('aria-pressed', dailyNotesWasOpen ? 'true' : 'false')

    await page.getByTestId('open-settings-button').click()
    await expect(page.getByTestId('settings-panel')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('settings-panel')).toHaveCount(0)

    await page.getByTestId('sidebar').screenshot({
      path: join(artifactsDir, 'sidebar-top-utility-icons.png')
    })

    await expect(daily).toContainText('Daily note')
    await expect(daily).not.toContainText('Obsidian vault')
    await expect(daily.locator('.session-meta')).toHaveCount(0)

    await expect(weekly).toContainText('Weekly plan')
    await expect(weekly.locator('.session-meta')).toHaveCount(0)
    await expect(weekly.locator('.row-tag')).toHaveCount(0)

    const nameStyle = await daily.locator('.session-name').evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        family: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        letterSpacing: style.letterSpacing
      }
    })
    expect(nameStyle.family).toMatch(/SF Pro Text|BlinkMacSystemFont|-apple-system|Avenir Next/)
    expect(nameStyle.size).toBe('13.5px')
    expect(nameStyle.weight).toBe('450')
    expect(Number.parseFloat(nameStyle.letterSpacing)).toBeLessThan(0)

    const sectionStyle = await page.locator('.sidebar-pane-label').filter({ hasText: 'Notes' }).evaluate((el) => {
      const style = getComputedStyle(el)
      return { size: style.fontSize, weight: style.fontWeight, letterSpacing: style.letterSpacing }
    })
    expect(sectionStyle.size).toBe('10.5px')
    expect(sectionStyle.weight).toBe('600')
    expect(Number.parseFloat(sectionStyle.letterSpacing)).toBeGreaterThan(0)

    const actionColors = await page
      .locator(
        [
          '[data-testid="new-session-button"]',
          '[data-testid="new-app-note-button"]',
          '[data-testid="new-bookmark-button"]'
        ].join(', ')
      )
      .evaluateAll((elements) => {
        const rootStyle = getComputedStyle(document.documentElement)
        return {
          accent: rootStyle.getPropertyValue('--accent').trim(),
          expected: rootStyle.getPropertyValue('--text-tertiary').trim(),
          actual: elements.map((element) => getComputedStyle(element).color)
        }
      })
    const expectedGrey = await page.evaluate((color) => {
      const probe = document.createElement('span')
      probe.style.color = color
      document.body.appendChild(probe)
      const resolved = getComputedStyle(probe).color
      probe.remove()
      return resolved
    }, actionColors.expected)
    const accent = await page.evaluate((color) => {
      const probe = document.createElement('span')
      probe.style.color = color
      document.body.appendChild(probe)
      const resolved = getComputedStyle(probe).color
      probe.remove()
      return resolved
    }, actionColors.accent)
    expect(actionColors.actual).toEqual([expectedGrey, expectedGrey, expectedGrey])
    expect(actionColors.actual).not.toContain(accent)

    // Drive the real one-click local terminal flow. A terminal's glyph is its
    // stable identity; agent-only waiting/working status chrome must not leak in.
    await page.getByTestId('open-local-terminal-button').click()
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    const terminalRow = page
      .locator('[data-testid="terminal-list"] [data-testid="session-row"][data-mode="terminal"]')
      .last()
    await expect(terminalRow.getByTestId('terminal-session-icon')).toBeVisible()
    await expect(terminalRow.locator('.session-status')).toHaveCount(0)
    await expect(terminalRow.getByTestId('session-meta-host')).toHaveText('Local')

    // Log evidence ties the visual regression to the real backend state: this
    // row is a terminal session, even though the old UI painted an agent status.
    const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
    const terminalLifecycle = readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"session.created"') && line.includes('"mode":"terminal"'))
    expect(terminalLifecycle.length).toBeGreaterThan(0)

    await page.screenshot({ path: join(artifactsDir, 'sidebar-refinement.png') })
  })
})
