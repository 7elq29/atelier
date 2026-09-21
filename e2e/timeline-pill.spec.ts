/**
 * E2E tests for the topbar timeline pill — the enriched calendar-toggle button
 * that appears when the daily notes panel is hidden.
 *
 * Verifies:
 *  1. Plain toggle shown when panel is open
 *  2. Pill appears when panel is closed (waits for async hook load)
 *  3. Sparkline bars exist, colored blue (meeting) and green (task)
 *  4. Next-task time + name are rendered
 *  5. Remaining-count badge is rendered
 *  6. Clicking the pill reopens the panel
 */

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'

// Schedule tasks at 23:00+ so they're always "upcoming" regardless of when
// the test runs. Two task types:
//   - "- [ ] ..."  → checkbox task   (isNote=false → GREEN bar)
//   - "- ..."      → plain bullet    (isNote=true  → BLUE bar)
const DAILY_NOTE = `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- [ ] 9:00-9:30 Standup
- 10:00-11:00 Team meeting
- [ ] 23:00-23:30 Late task

### ⚪ Backlog

### 🤝 Delegated
-
`

/** Close the panel if it's open and wait for it to be hidden. */
async function ensurePanelClosed(page: Page): Promise<void> {
  const panel = page.locator('[data-testid="daily-notes-panel"]')
  if (await panel.isVisible()) {
    await page.locator('[data-testid="toggle-daily-notes-panel"]').click()
    await expect(panel).toBeHidden({ timeout: 5_000 })
  }
}

/** Open the panel if it's closed and wait for it to be visible. */
async function ensurePanelOpen(page: Page): Promise<void> {
  const panel = page.locator('[data-testid="daily-notes-panel"]')
  if (!(await panel.isVisible())) {
    await page.locator('[data-testid="toggle-daily-notes-panel"]').click()
    await expect(panel).toBeVisible({ timeout: 5_000 })
  }
}

test.describe('timeline-pill', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-pill-'))
    seedE2eConfig(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-pill-vault-'))
    const vaultRoot = join(vaultParent, 'vault')
    // ISO week 31 for 2026-07-31
    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    writeFileSync(join(noteDir, `${TEST_DATE}.md`), DAILY_NOTE, 'utf-8')

    app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ATELIER_TEST_VAULT_ROOT: vaultRoot, ATELIER_TEST_DATE: TEST_DATE }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // Wait for panel to open (app auto-opens daily notes for ATELIER_TEST_DATE)
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 12_000 })
    // Give the useScheduledTasksForPill hook time to resolve readDailyNote
    await page.waitForTimeout(1_500)
  })

  test.afterAll(async () => {
    await app.close().catch(() => undefined)
  })

  // ── 1. Panel open → plain toggle ─────────────────────────────────────

  test('panel open: plain toggle shown, not pill', async () => {
    await ensurePanelOpen(page)

    const toggle = page.locator('[data-testid="toggle-daily-notes-panel"]')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveClass(/topbar-timeline-toggle/)
    await expect(toggle).not.toHaveClass(/topbar-pill/)

    await page.screenshot({ path: join(artifactsDir, 'pill-01-panel-open.png') })
  })

  // ── 2. Panel closed → pill appears ───────────────────────────────────

  test('panel closed: pill replaces plain toggle', async () => {
    await ensurePanelClosed(page)

    // The hook is async — pill appears once readDailyNote resolves.
    // Use a generous timeout so Playwright retries until the DOM updates.
    const pill = page.locator('[data-testid="toggle-daily-notes-panel"]')
    await expect(pill).toHaveClass(/topbar-pill/, { timeout: 8_000 })
    await expect(pill).not.toHaveClass(/topbar-timeline-toggle/)

    await page.screenshot({ path: join(artifactsDir, 'pill-02-panel-closed.png') })
  })

  // ── 3. Sparkline has blue (meeting) and green (task) bars ─────────────

  test('sparkline: 30 bars with blue and green colors', async () => {
    await ensurePanelClosed(page)
    const pill = page.locator('[data-testid="toggle-daily-notes-panel"]')
    await expect(pill).toHaveClass(/topbar-pill/, { timeout: 8_000 })

    const sparkline = pill.locator('.topbar-pill-sparkline')
    await expect(sparkline).toBeVisible()

    const bars = sparkline.locator('.topbar-pill-spark-bar')
    await expect(bars).toHaveCount(26) // 8am–9pm = 13h × 2 slots

    // Collect computed background colors from all bars
    const colors = await page.evaluate(() => {
      return [...document.querySelectorAll('.topbar-pill-spark-bar')].map((el) => {
        const s = window.getComputedStyle(el as HTMLElement)
        return {
          bg: s.backgroundColor,
          height: parseFloat(s.height),
        }
      })
    })

    // There should be at least 3 task-height bars (standup, team meeting, late task)
    const taskBars = colors.filter((c) => c.height > 3)
    expect(taskBars.length, 'at least 3 non-empty slots').toBeGreaterThanOrEqual(3)

    // --sc-blue  = #7fa3c9 = rgb(127, 163, 201) → blue for meetings (isNote=true)
    // --sc-green = #8fc17f = rgb(143, 193, 127) → green for tasks   (isNote=false)
    const hasBlue  = colors.some((c) => c.bg.includes('127') && c.bg.includes('163'))
    const hasGreen = colors.some((c) => c.bg.includes('143') && c.bg.includes('193'))

    console.log(`[pill] task bars: ${taskBars.length}/30, blue: ${hasBlue}, green: ${hasGreen}`)
    taskBars.forEach((b) => console.log(`  → h=${b.height} bg=${b.bg}`))

    expect(hasBlue,  'blue bars (meetings) present').toBe(true)
    expect(hasGreen, 'green bars (tasks) present').toBe(true)

    await page.screenshot({ path: join(artifactsDir, 'pill-03-sparkline.png') })
  })

  // ── 4. Next-task info ────────────────────────────────────────────────

  test('next task: time and name shown for 23:00 Late task', async () => {
    await ensurePanelClosed(page)
    const pill = page.locator('[data-testid="toggle-daily-notes-panel"]')
    await expect(pill).toHaveClass(/topbar-pill/, { timeout: 8_000 })

    // The 23:00-23:30 "Late task" is always upcoming — test runs before 11 PM
    const nextTime = pill.locator('.topbar-pill-next-time')
    const nextName = pill.locator('.topbar-pill-next-name')

    await expect(nextTime).toBeVisible({ timeout: 3_000 })
    await expect(nextName).toBeVisible()

    const timeText = await nextTime.textContent()
    const nameText = await nextName.textContent()
    console.log(`[pill] next: "${timeText}" · "${nameText}"`)

    expect(timeText).toMatch(/\d{1,2}:\d{2}\s*(AM|PM)/)
    expect(nameText?.trim()).toBeTruthy()

    await page.screenshot({ path: join(artifactsDir, 'pill-04-next-task.png') })
  })

  // ── 5. Count badge removed ───────────────────────────────────────────

  test('count badge: not rendered', async () => {
    await ensurePanelClosed(page)
    const pill = page.locator('[data-testid="toggle-daily-notes-panel"]')
    await expect(pill).toHaveClass(/topbar-pill/, { timeout: 8_000 })

    const badge = pill.locator('.topbar-pill-count')
    await expect(badge).toBeHidden()
  })

  // ── 6. Clicking pill opens the panel ─────────────────────────────────

  test('clicking pill opens the daily notes panel', async () => {
    await ensurePanelClosed(page)
    const pill = page.locator('[data-testid="toggle-daily-notes-panel"]')
    await expect(pill).toHaveClass(/topbar-pill/, { timeout: 8_000 })

    await pill.click()

    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 5_000 })

    // After opening, button reverts to plain active toggle
    const toggle = page.locator('[data-testid="toggle-daily-notes-panel"]')
    await expect(toggle).toHaveClass(/topbar-timeline-toggle/)
    await expect(toggle).toHaveClass(/active/)

    await page.screenshot({ path: join(artifactsDir, 'pill-06-panel-reopened.png') })
  })
})
