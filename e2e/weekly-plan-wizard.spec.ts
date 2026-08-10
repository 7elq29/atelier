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

> [!letter]
> 1. ${REAL_BIG3} — completion: 50%
> 2. ${JUNK_BIG3}
> 3. 1. [ ]

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
    await expect(context.getByText(TASK_OPEN)).toBeVisible()
    await expect(context.getByText(BACKLOG_OPEN)).toBeVisible()
    await expect(context.getByText(NOTE_BULLET)).toHaveCount(0)

    await page.getByTestId('weekly-plan-next').click()
    const carry = page.locator('.wp-carry')
    await expect(carry.getByText(NOTE_BULLET)).toBeVisible()
    await expect(carry.getByText(TASK_OPEN)).toHaveCount(0)

    await page.getByTestId('weekly-plan-next').click()
    await expect(page.getByTestId('weekly-plan-big3-carry').getByText(REAL_BIG3)).toBeVisible()
    await expect(page.getByTestId('weekly-plan-big3-carry').getByText(WEEKLY_B3_SUGGEST)).toBeVisible()
    await expect(page.getByText(/\bn\/a\b/i)).toHaveCount(0)

    await page.getByTestId('weekly-plan-back').click()
    await page.getByTestId('weekly-plan-back').click()
    await page.getByTestId('weekly-plan-back').click()
    await page.getByTestId('weekly-plan-back').click()
    await page.getByTestId('weekly-plan-close').click()
    await expect(page.getByTestId('weekly-plan-panel')).toHaveCount(0)
  })

  test('schedule: drop preview and placed timeline block', async () => {
    await openWizard()
    await goToStep(3)
    await page.locator('.wp-field input').first().fill('Rest block e2e')
    await page.getByTestId('weekly-plan-next').click()
    await page.getByTestId('weekly-plan-next').click()
    await page.locator('.wp-field input').first().fill('Outcome e2e #q2')
    await page.getByTestId('weekly-plan-next').click()

    const chip = page.locator('.wp-cal-chip').first()
    await expect(chip).toBeVisible()
    const entryId = await chip.getAttribute('data-entry-id')
    expect(entryId).toBeTruthy()

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
    }, entryId)
    await expect(page.getByTestId('weekly-plan-cal-drop-preview')).toBeVisible()

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
    await page.getByTestId('weekly-plan-close').click()
  })

  test('+ opens wizard and creates vault weekly note', async () => {
    await openWizard()
    await page.getByTestId('weekly-plan-next').click()
    await page.locator('.wp-field input').first().fill(MARKER)
    for (let i = 0; i < 5; i++) {
      await page.getByTestId('weekly-plan-next').click()
    }
    await page.getByTestId('weekly-plan-next').click()

    await expect(page.getByTestId('weekly-plan-done')).toBeVisible({ timeout: 15_000 })
    expect(existsSync(weeklyPath)).toBe(true)
    const body = readFileSync(weeklyPath, 'utf-8')
    expect(body).toContain(MARKER)
    await expect(page.getByTestId('weekly-plan-create-button')).toHaveCount(0)
  })
})
