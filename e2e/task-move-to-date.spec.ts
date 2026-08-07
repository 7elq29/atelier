import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 16-task-move-to-date: right-click a task in the Timeline or Unscheduled
 * section -> "Move to..." context menu -> picking a relative date moves the
 * task to that date's daily note's Backlog section, creating the note from
 * the template if it doesn't exist yet, and stripping its time-block.
 *
 * A new spec file rather than folding into `obsidian-integration.spec.ts`
 * (already 1300+ lines) — see e2e/TEST_CATEGORIES.md category 11.
 *
 * Fixed test date so both "today" (the menu's relative-date base) and the
 * vault path segments are deterministic: 2026-08-03 is a Monday, so the
 * expected menu is:
 *   Move to tomorrow   -> 2026-08-04 (Tue)
 *   Move to Wednesday  -> 2026-08-05
 *   Move to Thursday   -> 2026-08-06
 *   Move to Friday     -> 2026-08-07
 *   Move to Saturday   -> 2026-08-08
 *   Move to Sunday     -> 2026-08-09
 *   ─────────────
 *   Move to next week  -> 2026-08-10 (Mon, +7)
 * All of 08-03..08-09 fall in ISO week 32 (`01.dailynotes/2026/Aug/32/`);
 * 08-10 falls in ISO week 33 (`01.dailynotes/2026/Aug/33/`).
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

const TODAY = '2026-08-03'
const TOMORROW = '2026-08-04'
const TARGET_WEDNESDAY = '2026-08-05'
const NEXT_WEEK = '2026-08-10'

const GID_TIMELINE = 'a1000000-0000-4000-8000-000000000001'
const GID_UNSCHEDULED = 'a1000000-0000-4000-8000-000000000002'
const GID_TRACKER = 'a1000000-0000-4000-8000-000000000003'
const GID_WED_EXISTING_TASK = 'a1000000-0000-4000-8000-000000000004'
const GID_WED_EXISTING_BACKLOG = 'a1000000-0000-4000-8000-000000000005'
const GID_WED_TRACKER = 'a1000000-0000-4000-8000-000000000006'
// fix-move-task-creates-note-with-carryover: an extra open task that is
// deliberately NEVER moved by any test in this file, so it's still open in
// today's note at the moment "Move to tomorrow" triggers tomorrow's note's
// creation. If ensureNoteExists's carry-over scan incorrectly runs for the
// move-task path, this task would leak into tomorrow's newly-created note
// alongside the one task the user actually chose to move.
const GID_UNRELATED_OPEN = 'a1000000-0000-4000-8000-000000000007'

function seedTodayContent(): string {
  return `---
date: ${TODAY}
day: Monday
type: daily
---

## 📋 Tasks

- [x] 09:00–09:30 Standup #p1 [gid:: ${GID_TIMELINE}]

### ⚪ Backlog
- [ ] Write PR description #ktlo [gid:: ${GID_UNSCHEDULED}]
- [ ] Unrelated open task not being moved [gid:: ${GID_UNRELATED_OPEN}]

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Exercise #tracker [gid:: ${GID_TRACKER}]
`
}

function seedWednesdayContent(): string {
  return `---
date: ${TARGET_WEDNESDAY}
day: Wednesday
type: daily
---

## 📋 Tasks

- [ ] 10:00–10:30 Existing Wednesday task [gid:: ${GID_WED_EXISTING_TASK}]

### ⚪ Backlog
- [ ] Pre-existing backlog item [gid:: ${GID_WED_EXISTING_BACKLOG}]

### 🤝 Delegated
-

> [!invisible] Trackers
> - [ ] Water plants #tracker [gid:: ${GID_WED_TRACKER}]
`
}

let electronApp: ElectronApplication
let page: Page
let vaultRoot: string
let todayNotePath: string
let wednesdayNotePath: string
let tomorrowNotePath: string

test.describe('16-task-move-to-date: right-click "Move to..." context menu', () => {
  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-userdata-move-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-vault-move-'))
    vaultRoot = join(vaultParent, 'vault')

    const week32Dir = join(vaultRoot, '01.dailynotes', '2026', 'Aug', '32')
    mkdirSync(week32Dir, { recursive: true })
    todayNotePath = join(week32Dir, `${TODAY}.md`)
    wednesdayNotePath = join(week32Dir, `${TARGET_WEDNESDAY}.md`)
    writeFileSync(todayNotePath, seedTodayContent(), 'utf-8')
    writeFileSync(wednesdayNotePath, seedWednesdayContent(), 'utf-8')
    // TOMORROW (2026-08-04, also week 32) is deliberately NOT created yet.
    tomorrowNotePath = join(week32Dir, `${TOMORROW}.md`)

    mkdirSync(artifactsDir, { recursive: true })

    electronApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ATELIER_TEST_VAULT_ROOT: vaultRoot, ATELIER_TEST_DATE: TODAY }
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('right-clicking a Timeline task opens the "Move to..." menu with the correct 6 day-options + next-week, in order', async () => {
    const timelineTask = page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' })
    await expect(timelineTask).toBeVisible()
    const box = await timelineTask.boundingBox()
    if (!box) throw new Error('timeline task not visible')

    await timelineTask.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })

    const menu = page.locator('[data-testid="task-move-context-menu"]')
    await expect(menu).toBeVisible()

    const dayOptions = menu.locator('[data-testid="task-move-option"]')
    await expect(dayOptions).toHaveCount(6)

    const expected: [string, string][] = [
      ['Move to tomorrow', TOMORROW],
      ['Move to Wednesday', TARGET_WEDNESDAY],
      ['Move to Thursday', '2026-08-06'],
      ['Move to Friday', '2026-08-07'],
      ['Move to Saturday', '2026-08-08'],
      ['Move to Sunday', '2026-08-09']
    ]
    for (let i = 0; i < expected.length; i++) {
      const [label, date] = expected[i]!
      await expect(dayOptions.nth(i)).toHaveText(label)
      await expect(dayOptions.nth(i)).toHaveAttribute('data-date', date)
    }

    const nextWeekOption = menu.locator('[data-testid="task-move-option-next-week"]')
    await expect(nextWeekOption).toHaveText('Move to next week')
    await expect(nextWeekOption).toHaveAttribute('data-date', NEXT_WEEK)

    await page.screenshot({ path: join(artifactsDir, '16-task-move-context-menu.png') })

    // Close without selecting (Escape), per spec's "closes on ... Escape".
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
  })

  test('right-clicking an Unscheduled task also opens the same "Move to..." menu', async () => {
    const chip = page.locator('[data-testid="unscheduled-task"]', { hasText: 'Write PR description' })
    await expect(chip).toBeVisible()
    await chip.click({ button: 'right' })

    const menu = page.locator('[data-testid="task-move-context-menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.locator('[data-testid="task-move-option"]')).toHaveCount(6)
    await expect(menu.locator('[data-testid="task-move-option"]').first()).toHaveText('Move to tomorrow')
    await expect(menu.locator('[data-testid="task-move-option-next-week"]')).toHaveText('Move to next week')

    // Close via outside click this time.
    await page.locator('[data-testid="daily-notes-panel"]').click({ position: { x: 5, y: 5 } })
    await expect(menu).toHaveCount(0)
  })

  test('selecting "Move to Wednesday" on the Timeline task moves it into the EXISTING Wednesday note\'s Backlog, stripping its time-block and preserving tag/done-state', async () => {
    const beforeWednesday = readFileSync(wednesdayNotePath, 'utf-8')
    expect(beforeWednesday).toContain(GID_WED_EXISTING_TASK)
    expect(beforeWednesday).toContain(GID_WED_EXISTING_BACKLOG)
    expect(beforeWednesday).toContain(GID_WED_TRACKER)

    const timelineTask = page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' })
    await expect(timelineTask).toBeVisible()
    const box = await timelineTask.boundingBox()
    if (!box) throw new Error('timeline task not visible')
    await timelineTask.click({ button: 'right', position: { x: box.width / 2, y: box.height / 2 } })

    const menu = page.locator('[data-testid="task-move-context-menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('[data-testid="task-move-option"]', { hasText: 'Move to Wednesday' }).click()

    // Disappears from today's Timeline immediately.
    await expect(page.locator('[data-testid="timeline-task"]', { hasText: 'Standup' })).toHaveCount(0)

    await expect
      .poll(() => readFileSync(wednesdayNotePath, 'utf-8').includes(GID_TIMELINE), { timeout: 5000 })
      .toBe(true)

    // ── Source note (today): task fully removed, everything else intact. ──
    const afterToday = readFileSync(todayNotePath, 'utf-8')
    expect(afterToday).not.toContain(GID_TIMELINE)
    expect(afterToday).not.toContain('Standup')
    expect(afterToday).toContain(GID_UNSCHEDULED) // untouched sibling task
    expect(afterToday).toContain(GID_TRACKER) // untouched tracker

    // ── Target note (Wednesday, pre-existing): existing content undisturbed,
    // new line appended at the END of the Backlog section only. ──
    const afterWednesday = readFileSync(wednesdayNotePath, 'utf-8')
    const afterLines = afterWednesday.split('\n')

    const backlogHeaderIdx = afterLines.findIndex((l) => /^###\s+.*Backlog/i.test(l))
    const delegatedHeaderIdx = afterLines.findIndex((l) => /^###\s+.*Delegated/i.test(l))
    expect(backlogHeaderIdx).toBeGreaterThanOrEqual(0)
    expect(delegatedHeaderIdx).toBeGreaterThan(backlogHeaderIdx)

    // The pre-existing Tasks-section task, Delegated placeholder, and
    // tracker are all still present, undisturbed by the move.
    expect(afterWednesday).toContain(GID_WED_EXISTING_TASK)
    expect(afterWednesday).toContain('Existing Wednesday task')
    expect(afterWednesday).toContain(GID_WED_TRACKER)
    expect(afterWednesday).toContain('Water plants')

    // The Backlog section itself: pre-existing item still first, moved task
    // appended after it (order preserved, nothing dropped).
    const backlogSection = afterLines.slice(backlogHeaderIdx + 1, delegatedHeaderIdx).filter((l) => l.trim())
    expect(backlogSection[0]).toContain(GID_WED_EXISTING_BACKLOG)
    const movedLine = backlogSection.find((l) => l.includes(GID_TIMELINE))
    expect(movedLine, 'moved task should be appended to the target Backlog section').toBeTruthy()

    // Time-block stripped; tag and done-state preserved.
    expect(movedLine).not.toMatch(/\d{1,2}:\d{2}[–-]\d{1,2}:\d{2}/)
    expect(movedLine).toContain('#p1')
    expect(movedLine).toMatch(/^\s*-\s*\[x\]/i)
    expect(movedLine).toContain('Standup')
  })

  test('selecting "Move to tomorrow" on the Unscheduled task creates tomorrow\'s (absent) note from the template and files it under Backlog', async () => {
    expect(existsSync(tomorrowNotePath)).toBe(false)

    // Sanity check on the reproduction setup: the unrelated open task is
    // still present (and open) in today's note right before tomorrow's note
    // gets created via the move.
    const beforeToday = readFileSync(todayNotePath, 'utf-8')
    expect(beforeToday).toContain(GID_UNRELATED_OPEN)

    const chip = page.locator('[data-testid="unscheduled-task"]', { hasText: 'Write PR description' })
    await expect(chip).toBeVisible()
    await chip.click({ button: 'right' })

    const menu = page.locator('[data-testid="task-move-context-menu"]')
    await expect(menu).toBeVisible()
    await menu.locator('[data-testid="task-move-option"]', { hasText: 'Move to tomorrow' }).click()

    await expect(page.locator('[data-testid="unscheduled-task"]', { hasText: 'Write PR description' })).toHaveCount(0)

    await expect.poll(() => existsSync(tomorrowNotePath), { timeout: 5000 }).toBe(true)

    const afterToday = readFileSync(todayNotePath, 'utf-8')
    expect(afterToday).not.toContain(GID_UNSCHEDULED)
    expect(afterToday).not.toContain('Write PR description')
    // The unrelated task stays behind in today's note, untouched by the move.
    expect(afterToday).toContain(GID_UNRELATED_OPEN)

    const tomorrowContent = readFileSync(tomorrowNotePath, 'utf-8')
    const lines = tomorrowContent.split('\n')
    const backlogHeaderIdx = lines.findIndex((l) => /^###\s+.*Backlog/i.test(l))
    const delegatedHeaderIdx = lines.findIndex((l) => /^###\s+.*Delegated/i.test(l))
    expect(backlogHeaderIdx).toBeGreaterThanOrEqual(0)
    expect(delegatedHeaderIdx).toBeGreaterThan(backlogHeaderIdx)

    const movedLine = lines.find((l) => l.includes(GID_UNSCHEDULED))
    expect(movedLine, 'moved task should land in the newly-created note\'s Backlog').toBeTruthy()
    expect(lines.indexOf(movedLine!)).toBeGreaterThan(backlogHeaderIdx)
    expect(lines.indexOf(movedLine!)).toBeLessThan(delegatedHeaderIdx)
    expect(movedLine).toContain('#ktlo')
    expect(movedLine).toMatch(/^\s*-\s*\[ \]/)
    expect(movedLine).not.toMatch(/\d{1,2}:\d{2}[–-]\d{1,2}:\d{2}/)

    // fix-move-task-creates-note-with-carryover: tomorrow's note must be
    // created purely from the template with the ONE moved task appended —
    // no carry-over scan against today's (or any other prior) note. The
    // still-open, never-moved unrelated task must NOT have leaked in.
    expect(tomorrowContent).not.toContain(GID_UNRELATED_OPEN)
    expect(tomorrowContent).not.toContain('Unrelated open task not being moved')
    // Exactly one task line should exist in the Backlog section: the moved one.
    const backlogSection = lines.slice(backlogHeaderIdx + 1, delegatedHeaderIdx).filter((l) => l.trim())
    expect(backlogSection).toHaveLength(1)
  })
})

// ── Visual confirmation on the target date ──────────────────────────────
//
// The main describe block above never navigates the UI to another date (the
// app has no other-date nav; ATELIER_TEST_DATE fixes the displayed date for
// a whole Electron session — same constraint documented throughout
// obsidian-integration.spec.ts). To visually confirm the moved task actually
// renders on its new date, launch a second Electron instance against the
// SAME on-disk vault (now already mutated by the tests above) with
// ATELIER_TEST_DATE pointed at tomorrow's (newly-created) target note.
// Uses the "Write PR description" move rather than the "Standup" one for
// this screenshot: Standup was seeded already-done, and a done task's
// dimmed/strikethrough styling (`.dn-task-chip.done span` — pre-existing,
// unrelated to this feature) makes for a low-contrast screenshot; the
// still-open "Write PR description" task is clearer to visually inspect.
test.describe('16-task-move-to-date: visual confirmation on the target date', () => {
  test('the moved "Write PR description" task renders in tomorrow\'s newly-created note\'s Unscheduled/Backlog list', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-userdata-move-verify-'))
    mkdirSync(join(userDataDir, 'data'), { recursive: true })
    writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))

    const verifyApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ATELIER_TEST_VAULT_ROOT: vaultRoot, ATELIER_TEST_DATE: TOMORROW }
    })
    try {
      const verifyPage = await verifyApp.firstWindow()
      await verifyPage.waitForLoadState('domcontentloaded')
      await expect(verifyPage.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })

      const movedTask = verifyPage.locator('[data-testid="unscheduled-task"]', { hasText: 'Write PR description' })
      await expect(movedTask).toBeVisible()
      await expect(movedTask.locator('[data-testid="task-tag-chip"]', { hasText: '#ktlo' })).toBeVisible()
      await expect(movedTask).not.toHaveClass(/done/)

      // fix-move-task-creates-note-with-carryover: the unrelated task that
      // was never moved (still open in today's note) must NOT have been
      // carried over into this newly-created target note.
      await expect(
        verifyPage.locator('[data-testid="unscheduled-task"]', { hasText: 'Unrelated open task not being moved' })
      ).toHaveCount(0)

      // The daily-notes panel's flex sections don't shrink below their
      // content's intrinsic height (the Timeline grid alone is ~960px of
      // absolute-positioned content — a pre-existing flex-layout quirk, same
      // family as the known scroll-position issue CLAUDE.md documents for
      // audit-scroll-experience.spec.ts, unrelated to this feature), so at
      // the app's default 800px window height the Unscheduled row can be
      // clipped. Resize the real OS window taller for this screenshot only,
      // giving every section enough room to render in full.
      const win = await verifyApp.browserWindow(verifyPage)
      await win.evaluate((w) => w.setSize(1280, 2200))

      await movedTask.scrollIntoViewIfNeeded()
      await verifyPage.locator('[data-testid="daily-notes-panel"]').screenshot({
        path: join(artifactsDir, '16-task-move-target-backlog.png')
      })
    } finally {
      await verifyApp.close().catch(() => undefined)
    }
  })
})
