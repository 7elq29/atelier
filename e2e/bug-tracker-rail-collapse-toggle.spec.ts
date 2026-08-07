import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Reproduction/fix verification for "fix-tracker-rail-collapsed-toggle"
 * (see Bugs/fix-tracker-rail-collapsed-toggle in the vault, sourced from
 * finding 7 of the audit-window-resize-layout-integrity audit).
 *
 * Finding: `global.css` fully implements a collapsed tracker-rail state
 * (`.tracker-rail.collapsed`, `.tracker-rail-toggle`, `.rail-mini-badges`)
 * and it renders correctly with no overlap/clipping when the `collapsed`
 * class is forced directly via `page.evaluate` (see
 * e2e/audit-window-resize-layout.spec.ts, "(h) tracker rail collapsed
 * state"). But `TrackerRail.tsx` never rendered a `.tracker-rail-toggle`
 * button, so there was no real, reachable UI control a user could click to
 * enter that state — a missing affordance, not a CSS/layout bug.
 *
 * The authoritative mock (Features/UI-Design/mocks/index.html, lines
 * ~830-851 and the `toggleTrackerRail()` function ~line 1387) shows a
 * `.tracker-rail-toggle` button rendered as the rail's first child, with a
 * chevron (`◂`/`▸`) + "Collapse" label, that toggles the `collapsed` class
 * and reveals `.rail-mini-badges` in its place. This spec drives that real
 * button (a real click, not a forced class) to reach the collapsed state.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
}

async function launchApp(userDataDir: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: [mainEntry, `--user-data-dir=${userDataDir}`] })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function stubProjectFolder(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, folderPath) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folderPath] })) as typeof dialog.showOpenDialog
  }, path)
}

async function openNewSessionModal(page: Page): Promise<void> {
  await page.getByTestId('new-session-button').click()
  await expect(page.getByTestId('new-session-modal')).toBeVisible()
}

test.describe('bug-fix: tracker rail collapsed state is reachable via a real toggle button', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let projectDir: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-rail-collapse-'))
    seedSkipOnboarding(userDataDir)
    projectDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-rail-collapse-project-'))
    ;({ app: electronApp, page } = await launchApp(userDataDir))
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('clicking the tracker-rail-toggle button collapses the rail with no overlap, and expands it again', async ({}, testInfo) => {
    testInfo.setTimeout(150_000)
    await stubProjectFolder(electronApp, projectDir)
    await openNewSessionModal(page)
    await page.getByTestId('pick-project-folder').click()
    await page.getByTestId('mode-claude-code').click()
    await page.getByTestId('initial-prompt').fill(
      'Use the TodoWrite tool now to create a todo list with exactly two items: "Step one" (in_progress) and ' +
        '"Step two" (pending). Do not do anything else. After calling TodoWrite once, reply with exactly: DONE.'
    )
    await page.getByTestId('start-session-button').click()
    await expect(page.getByTestId('new-session-modal')).toHaveCount(0)

    const row = page.locator('[data-testid="session-row"]').first()
    await expect(row).toBeVisible({ timeout: 15_000 })

    const rail = page.getByTestId('tracker-rail')
    await expect(rail).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('todo-tracker-card')).toBeVisible({ timeout: 30_000 })

    const toggle = page.getByTestId('tracker-rail-toggle')
    await expect(toggle).toBeVisible()

    // Expanded (default) state sanity check.
    await expect(rail).not.toHaveClass(/collapsed/)
    const expandedWidth = await rail.evaluate((el) => el.getBoundingClientRect().width)
    expect(expandedWidth).toBeGreaterThan(200)

    // Real click on the real affordance — no forced class.
    await toggle.click()
    await expect(rail).toHaveClass(/collapsed/)
    await page.waitForTimeout(150) // let the width transition settle

    const collapsedWidth = await rail.evaluate((el) => el.getBoundingClientRect().width)
    expect(collapsedWidth, `collapsed .tracker-rail width should be ~40px per global.css, got ${collapsedWidth}`).toBeCloseTo(40, 0)

    // Todo card is hidden, mini-badges summary is shown instead.
    await expect(page.getByTestId('todo-tracker-card')).not.toBeVisible()
    await expect(page.getByTestId('tracker-rail-mini-badges')).toBeVisible()

    // No overlap/clipping vs. the main chat column while collapsed (same
    // pairwise-rect-overlap check pattern as
    // audit-window-resize-layout.spec.ts's checkNoSiblingOverlap).
    const overlapCheck = await page.locator('.main-area > div:has(.tracker-rail) > *').evaluateAll((els) => {
      const slack = 1
      const panels = (els as HTMLElement[])
        .filter((el) => el.offsetParent !== null || getComputedStyle(el).position === 'fixed')
        .map((el) => {
          const r = el.getBoundingClientRect()
          return { label: el.getAttribute('data-testid') || el.className || el.tagName, rect: r }
        })
        .filter((p) => p.rect.width > 0 && p.rect.height > 0)
      for (let i = 0; i < panels.length; i++) {
        for (let j = i + 1; j < panels.length; j++) {
          const a = panels[i].rect
          const b = panels[j].rect
          const overlaps = a.x + a.width - slack > b.x && b.x + b.width - slack > a.x && a.y + a.height - slack > b.y && b.y + b.height - slack > a.y
          if (overlaps) return { ok: false, reason: `overlap between "${panels[i].label}" and "${panels[j].label}"` }
        }
      }
      return { ok: true, reason: '' }
    })
    expect(overlapCheck.ok, overlapCheck.reason).toBe(true)

    await page.screenshot({ path: join(artifactsDir, 'bug-tracker-rail-collapse-toggle-collapsed.png') })
    await rail.screenshot({ path: join(artifactsDir, 'bug-tracker-rail-collapse-toggle-collapsed-closeup.png') })

    // Toggle back and confirm it fully expands again.
    await toggle.click()
    await expect(rail).not.toHaveClass(/collapsed/)
    await page.waitForTimeout(150)
    const reExpandedWidth = await rail.evaluate((el) => el.getBoundingClientRect().width)
    expect(reExpandedWidth).toBeCloseTo(expandedWidth, 0)
    await expect(page.getByTestId('todo-tracker-card')).toBeVisible()

    await page.screenshot({ path: join(artifactsDir, 'bug-tracker-rail-collapse-toggle-expanded.png') })
  })
})
