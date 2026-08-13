import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const TEST_DATE = '2026-07-31'
const ISO_WEEK = '2026-W31'
const PREV_WEEK = '2026-W30'
const PREV_DAY = '2026-07-20'
const MARKER = 'Weekly plan wizard e2e win'
const DAILY_SCHEDULE_TASK = 'Weekly plan e2e daily scheduled task'
const W31_MONDAY = '2026-07-27'

const WEEKLY_TEMPLATE = `---
week: {{date:gggg-[W]WW}}
type: weekly
---

# Retro

---

## Review Projects

First review the projects under *03.projects* and *04.goals*.

%% Altitude check (Get Current): also scan the current Linear cycle. Confirm each Weekly Big Three ladders UP to a goal (03.projects / 04.goals / Linear initiative). No orphan goals, no orphan busywork. %%

## AFTER ACTION REVIEW

*List 3–5 of your biggest wins from the week.*

1. 
2. 
3. 

## Last Week's Big Three

1. [Completion: %] 
2. [Completion: %] 
3. [Completion: %] 

## What worked? What didn't? Why? How would you change

> *(write something)*

# Plan

---

## REJUVENATION

*Three non-work resets for the week.*

1. 
2. 
3. 

## Ideas

- 
- 
- 
- 
- 
- 

## WEEKLY BIG THREE

%% At least ONE must be a #q2 (Important-not-urgent) item. Each should ladder to a goal/initiative. %%

1. [ ] 
2. [ ] 
3. [ ] 
`

const TASK_DONE = 'W30 done checkbox task'
const TASK_OPEN = 'W30 open checkbox task'
const NOTE_BULLET = 'W30 plain note for ideas'
const BACKLOG_OPEN = 'W30 backlog open task'
const REAL_BIG3 = 'Real outcome from last week'
const WEEKLY_B3_SUGGEST = 'W30 planned outcome alpha'
const JUNK_BIG3 = '%% At least ONE must be a #q2 item'

let electronApp: ElectronApplication
let page: Page
let userDataDir: string
let vaultRoot: string
let weeklyPath: string

function seedPrevWeekVault(): void {
  const prevNoteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '30')
  mkdirSync(prevNoteDir, { recursive: true })
  writeFileSync(
    join(prevNoteDir, `${PREV_DAY}.md`),
    `---
date: ${PREV_DAY}
day: Monday
type: daily
---

## 📋 Tasks

- [x] ${TASK_DONE}
- [ ] ${TASK_OPEN}
- ${NOTE_BULLET}

### ⚪ Backlog
- [ ] ${BACKLOG_OPEN}
`,
    'utf-8'
  )

  writeFileSync(
    join(vaultRoot, '02.weeklynotes', `${PREV_WEEK}.md`),
    `---
week: ${PREV_WEEK}
type: weekly
---

## Last Week's Big Three

1. ${REAL_BIG3} — completion: 50%
2. ${JUNK_BIG3}
3. 1. [ ]

## WEEKLY BIG THREE
%% At least ONE must be a #q2 item %%

1. [ ] ${WEEKLY_B3_SUGGEST}
2. [ ] Second planned outcome #q2
3. [ ]
`,
    'utf-8'
  )
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-userdata-'))
  seedE2eConfig(userDataDir)

  const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-vault-'))
  vaultRoot = join(vaultParent, 'vault')
  mkdirSync(join(vaultRoot, '02.weeklynotes'), { recursive: true })
  mkdirSync(join(vaultRoot, '92.templates'), { recursive: true })
  writeFileSync(join(vaultRoot, '92.templates', 'Weekly Notes Template.md'), WEEKLY_TEMPLATE, 'utf-8')
  mkdirSync(join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31'), { recursive: true })
  weeklyPath = join(vaultRoot, '02.weeklynotes', `${ISO_WEEK}.md`)
  seedPrevWeekVault()

  electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ATELIER_TEST_VAULT_ROOT: vaultRoot,
      ATELIER_TEST_DATE: TEST_DATE
    }
  })
  page = await electronApp.firstWindow()
  await page.waitForSelector('#root', { timeout: 30_000 })
})

test.afterAll(async () => {
  await electronApp?.close()
})

async function openWizard(): Promise<void> {
  await expect(page.getByTestId('weekly-plan-row')).toBeVisible({ timeout: 15_000 })
  await page.evaluate(async () => {
    const status = await window.atelier.getWeeklyPlanStatus()
    await window.atelier.clearWeeklyPlanDraft(status.isoWeek)
  })
  await expect(page.getByTestId('weekly-plan-create-button')).toBeVisible()
  await page.getByTestId('weekly-plan-create-button').click()
  await expect(page.getByTestId('weekly-plan-panel')).toBeVisible({ timeout: 10_000 })
  const carryCount = await page.evaluate(async () => {
    const ctx = await window.atelier.loadWeeklyPlanContext()
    return ctx.carrySuggestions.length
  })
  expect(carryCount).toBeGreaterThan(0)
}

async function goToStep(stepIndex: number): Promise<void> {
  for (let i = 0; i < stepIndex; i++) {
    await page.getByTestId('weekly-plan-next').click()
  }
}

test.describe.serial('weekly plan wizard', () => {
  test('context: tasks/backlog only in side panel; notes only in Ideas carry', async () => {
    expect(existsSync(weeklyPath)).toBe(false)
    await openWizard()
    await goToStep(1)

    const context = page.locator('.wp-context-panel')
    await expect(context.getByText(TASK_DONE)).toBeVisible()
    await expect(context.getByText(TASK_OPEN)).toHaveCount(0)
    await expect(context.getByText(BACKLOG_OPEN)).toHaveCount(0)
    await expect(context.getByText(NOTE_BULLET)).toHaveCount(0)
    await expect(context.locator('input')).toHaveCount(0)

    await page.getByTestId('weekly-plan-next').click()
    await expect(page.locator('.wp-plain-field').first()).toHaveValue(REAL_BIG3)
    await expect(page.getByText(JUNK_BIG3)).toHaveCount(0)

    await page.getByTestId('weekly-plan-next').click()
    await expect(page.getByTestId('weekly-plan-big3-carry').getByText(REAL_BIG3)).toBeVisible()
    await expect(page.getByTestId('weekly-plan-big3-carry').getByText(WEEKLY_B3_SUGGEST)).toBeVisible()
    await expect(page.getByText(/\bn\/a\b/i)).toHaveCount(0)

    await page.getByTestId('weekly-plan-next').click()
    await expect(context.getByText(TASK_OPEN)).toBeVisible()
    await expect(context.getByText(BACKLOG_OPEN)).toBeVisible()
    await expect(context.getByText(NOTE_BULLET)).toHaveCount(0)

    await page.getByTestId('weekly-plan-next').click()
    const carry = page.locator('.wp-carry')
    await expect(carry.getByText(NOTE_BULLET)).toBeVisible()
    await expect(carry.getByText(TASK_OPEN)).toHaveCount(0)

    await page.getByTestId('weekly-plan-back').click()
    await page.getByTestId('weekly-plan-back').click()
    await page.getByTestId('weekly-plan-back').click()
    await page.getByTestId('weekly-plan-back').click()
    await page.getByTestId('weekly-plan-close').click()
    await expect(page.getByTestId('weekly-plan-panel')).toHaveCount(0)
  })

  test('schedule: drop preview, edit, remove, placed timeline block', async () => {
    await openWizard()
    await goToStep(3)
    await page.locator('.wp-field input').first().fill('Outcome e2e #q2')
    await page.getByTestId('weekly-plan-next').click()
    await page.locator('.wp-field input').first().fill('Rest block e2e')
    await page.getByTestId('weekly-plan-next').click()
    await page.getByTestId('weekly-plan-next').click()

    await page.getByTestId('weekly-plan-schedule-add').click()
    await expect(page.getByTestId('weekly-plan-cal-edit')).toBeVisible()
    await page.getByTestId('weekly-plan-cal-edit').fill('Ad hoc schedule task')
    await page.getByTestId('weekly-plan-cal-edit').press('Enter')
    await expect(page.locator('.wp-cal-chip').filter({ hasText: 'Ad hoc schedule task' })).toBeVisible()

    const chip = page.locator('.wp-cal-chip').first()
    await expect(chip).toBeVisible()
    const entryId = await chip.getAttribute('data-entry-id')
    expect(entryId).toBeTruthy()

    const outcomeRow = page.locator('.wp-sched-pool-row', { hasText: 'Outcome e2e' }).first()
    await outcomeRow.locator('.wp-split-icon').click()
    const outcomeSplitRows = page.locator('.wp-sched-pool-row', { hasText: /Outcome e2e/ })
    await expect(outcomeSplitRows).toHaveCount(2)
    await outcomeSplitRows.nth(1).locator('.wp-cal-chip').dblclick()
    await page.getByTestId('weekly-plan-cal-edit').fill('Custom split label')
    await page.getByTestId('weekly-plan-cal-edit').press('Enter')
    await expect(page.locator('.wp-cal-chip').filter({ hasText: 'Custom split label' })).toBeVisible()

    const entryIdAfterSplit = await outcomeSplitRows.first().locator('.wp-cal-chip').getAttribute('data-entry-id')
    expect(entryIdAfterSplit).toBeTruthy()

    await page.evaluate((id) => {
      const timeline = document.querySelector('.wp-cal-matrix-timeline')
      if (!timeline) throw new Error('timeline column missing')
      const rect = timeline.getBoundingClientRect()
      const dt = new DataTransfer()
      dt.setData('text/wp-entry', id as string)
      timeline.dispatchEvent(
        new DragEvent('dragover', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientY: rect.top + rect.height * 0.35
        })
      )
    }, entryIdAfterSplit)
    await expect(page.getByTestId('weekly-plan-cal-drop-preview')).toBeVisible()
    await expect(page.getByTestId('weekly-plan-cal-drop-preview-slot')).toHaveText(/\d{2}:\d{2}–\d{2}:\d{2}/)

    await page.evaluate((id) => {
      const timeline = document.querySelector('.wp-cal-matrix-timeline')
      if (!timeline) throw new Error('timeline column missing')
      const rect = timeline.getBoundingClientRect()
      const dt = new DataTransfer()
      dt.setData('text/wp-entry', id as string)
      timeline.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientY: rect.top + rect.height * 0.35
        })
      )
    }, entryIdAfterSplit)
    await expect(page.getByTestId('weekly-plan-cal-block')).toBeVisible()

    await chip.dblclick()
    const edit = page.getByTestId('weekly-plan-cal-edit')
    await expect(edit).toBeVisible()
    await edit.fill('Edited outcome e2e #q2')
    await edit.press('Enter')
    await expect(page.locator('.wp-cal-chip').filter({ hasText: 'Edited outcome e2e' })).toBeVisible()

    await page
      .locator('.wp-sched-pool-row', { hasText: 'Rest block e2e' })
      .getByTestId('weekly-plan-cal-remove')
      .click()
    await expect(page.locator('.wp-cal-chip').filter({ hasText: 'Rest block e2e' })).toHaveCount(0)

    await page.getByTestId('weekly-plan-close').click()
  })

  test('draft persists when wizard closed before completion', async () => {
    const DRAFT = 'Weekly plan draft marker e2e'
    await page.evaluate(async () => {
      const status = await window.atelier.getWeeklyPlanStatus()
      await window.atelier.clearWeeklyPlanDraft(status.isoWeek)
    })
    await expect(page.getByTestId('weekly-plan-create-button')).toBeVisible()
    await page.getByTestId('weekly-plan-create-button').click()
    await goToStep(1)
    await page.locator('.wp-field input').first().fill(DRAFT)
    await page.getByTestId('weekly-plan-close').click()
    await expect(page.getByTestId('weekly-plan-panel')).toHaveCount(0)

    await page.getByTestId('weekly-plan-create-button').click()
    await expect(page.getByTestId('weekly-plan-panel')).toBeVisible()
    await expect(page.getByTestId('weekly-plan-step-label')).toContainText('Step 2 of 7')
    await expect(page.locator('.wp-field input').first()).toHaveValue(DRAFT)
    await page.getByTestId('weekly-plan-close').click()
  })

  test('+ opens wizard and creates vault weekly note', async () => {
    await openWizard()
    await page.getByTestId('weekly-plan-next').click()
    await page.locator('.wp-field input').first().fill(MARKER)
    for (let i = 0; i < 5; i++) {
      await page.getByTestId('weekly-plan-next').click()
    }

    await page.getByTestId('weekly-plan-schedule-add').click()
    await page.getByTestId('weekly-plan-cal-edit').fill(DAILY_SCHEDULE_TASK)
    await page.getByTestId('weekly-plan-cal-edit').press('Enter')
    const chip = page.locator('.wp-cal-chip').filter({ hasText: DAILY_SCHEDULE_TASK })
    const entryId = await chip.getAttribute('data-entry-id')
    expect(entryId).toBeTruthy()
    await page.evaluate((id) => {
      const timeline = document.querySelector('.wp-cal-matrix-timeline')
      if (!timeline) throw new Error('timeline column missing')
      const rect = timeline.getBoundingClientRect()
      const dt = new DataTransfer()
      dt.setData('text/wp-entry', id as string)
      timeline.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientY: rect.top + rect.height * 0.35
        })
      )
    }, entryId)
    await expect(page.getByTestId('weekly-plan-cal-block')).toBeVisible()

    await page.getByTestId('weekly-plan-next').click()

    await expect(page.getByTestId('weekly-plan-done')).toBeVisible({ timeout: 15_000 })
    expect(existsSync(weeklyPath)).toBe(true)
    const body = readFileSync(weeklyPath, 'utf-8')
    expect(body).toContain(`1. ${MARKER}`)
    expect(body).toMatch(/^1\. \[ \]/m)
    expect(body).not.toMatch(/^## Schedule/m)

    const mondayDailyPath = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31', `${W31_MONDAY}.md`)
    expect(existsSync(mondayDailyPath)).toBe(true)
    const dailyBody = readFileSync(mondayDailyPath, 'utf-8')
    expect(dailyBody).toContain(DAILY_SCHEDULE_TASK)
    expect(dailyBody).toContain(`[scheduled:: ${W31_MONDAY}]`)
    expect(dailyBody).toMatch(/\d{2}:\d{2}[–-]\d{2}:\d{2}/)

    await expect(page.getByTestId('weekly-plan-create-button')).toHaveCount(0)

    await page.getByTestId('weekly-plan-next').click()
    await expect(page.getByTestId('weekly-plan-panel')).toHaveCount(0)

    await page.getByTestId('weekly-plan-row').click()
    await expect(page.getByTestId('weekly-plan-view-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('weekly-plan-view-big-three')).toBeVisible()
    await expect(page.getByTestId('weekly-plan-view-rejuvenation')).toBeVisible()
    await expect(page.getByTestId('weekly-plan-view-schedule')).toBeVisible()
    await expect(page.getByTestId('weekly-plan-view-panel')).toContainText('Jul 27 – Aug 2, 2026')
    await expect(page.getByTestId('weekly-plan-cal-block').filter({ hasText: DAILY_SCHEDULE_TASK })).toBeVisible()
    await expect(page.getByTestId('weekly-plan-exists-hint')).toHaveCount(0)
    await expect(page.getByTestId('main-title')).toContainText('Weekly plan')
  })

  test('view loads daily-note backlog and unscheduled day-plan tasks', async () => {
    const BACKLOG_VIEW = 'Weekly view backlog task'
    const BACKLOG_DONE = 'Weekly view done backlog task'
    const DAYPLAN_NO_TIME = 'Weekly view day-plan no time'
    const MEETING_TIMED = 'Weekly view meeting standup'
    const SCHEDULED_MISMATCH = 'Weekly view scheduled metadata mismatch'
    writeFileSync(
      weeklyPath,
      `---
week: ${ISO_WEEK}
type: weekly
---

## WEEKLY BIG THREE

1. [ ] View load big three
2. [ ] 
3. [ ] 

## REJUVENATION

1. Rest
2. 
3. 
`,
      'utf-8'
    )
    const fridayPath = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31', `${TEST_DATE}.md`)
    writeFileSync(
      fridayPath,
      `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- [ ] 10:00–11:00 Timed Friday task
- [ ] 10:30–11:00 ${SCHEDULED_MISMATCH} [scheduled:: ${W31_MONDAY}] [gid:: cccc1111-1111-4111-8111-111111111111]
- 10:30–11:00 ${MEETING_TIMED} #meeting [gid:: dddd2222-2222-4222-8222-222222222222]
- [ ] ${DAYPLAN_NO_TIME}

### ⚪ Backlog
- [ ] ${BACKLOG_VIEW}
- [x] ${BACKLOG_DONE}
`,
      'utf-8'
    )

    await page.reload()
    await page.waitForSelector('#root', { timeout: 30_000 })
    await expect(page.getByTestId('weekly-plan-row')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('weekly-plan-row').click()
    await expect(page.getByTestId('weekly-plan-view-panel')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.wp-cal-chip').filter({ hasText: BACKLOG_VIEW })).toBeVisible()
    await expect(page.locator('.wp-cal-chip.is-done').filter({ hasText: BACKLOG_DONE })).toBeVisible()
    await expect(page.locator('.wp-cal-chip').filter({ hasText: DAYPLAN_NO_TIME })).toBeVisible()
    await expect(page.getByTestId('weekly-plan-cal-block').filter({ hasText: 'Timed Friday task' })).toBeVisible()
    await expect(page.getByTestId('weekly-plan-cal-block').filter({ hasText: SCHEDULED_MISMATCH })).toBeVisible()
    await expect(page.getByTestId('weekly-plan-cal-block').filter({ hasText: MEETING_TIMED })).toHaveClass(/is-meeting/)
    await expect(page.getByTestId('weekly-plan-unsched-toggle-fri')).toBeVisible()
    await page.getByTestId('weekly-plan-unsched-toggle-fri').click()
    await expect(page.getByTestId('weekly-plan-unsched-toggle-fri')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('weekly-plan-unsched-mon')).toHaveClass(/is-expanded/)
  })
})
