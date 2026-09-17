import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * `#meeting` lines are calendar entries, not todos: they must not show up in
 * the daily "From <prior date>" carry suggestions, nor in the weekly plan
 * wizard's "Suggested carry-overs" (which feeds the Ideas list).
 */

const artifactsDir = join(__dirname, '..', 'e2e-artifacts')

const TEST_DATE = '2026-07-31'
const PRIOR_DATE = '2026-07-30'
const PREV_WEEK_DAY = '2026-07-20'

const CARRY_TODO = 'Carry a real open todo'
const CARRY_MEETING_CHECKBOX = 'Yesterday checkbox meeting sync'
const CARRY_MEETING_BULLET = 'Yesterday bullet standup notes'

const WEEK_TODO = 'Prev week open todo'
const WEEK_IDEA_BULLET = 'Prev week plain idea bullet'
const WEEK_MEETING_BULLET = 'Prev week one-on-one with Ana'

const WEEKLY_TEMPLATE = `---
week: {{date:gggg-[W]WW}}
type: weekly
---

## REJUVENATION

1. 
2. 
3. 

## Ideas

- 
- 
- 

## WEEKLY BIG THREE

1. [ ] 
2. [ ] 
3. [ ] 
`

let electronApp: ElectronApplication
let page: Page
let vaultRoot: string

test.beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-userdata-'))
  seedE2eConfig(userDataDir)

  const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-vault-'))
  vaultRoot = join(vaultParent, 'vault')
  mkdirSync(join(vaultRoot, '02.weeklynotes'), { recursive: true })
  mkdirSync(join(vaultRoot, '92.templates'), { recursive: true })
  writeFileSync(join(vaultRoot, '92.templates', 'Weekly Notes Template.md'), WEEKLY_TEMPLATE, 'utf-8')

  // Today + yesterday both live under ISO week 31.
  const w31Dir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
  mkdirSync(w31Dir, { recursive: true })
  writeFileSync(
    join(w31Dir, `${TEST_DATE}.md`),
    `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## Tasks

- [ ] Today placeholder task [gid:: 10000000-0000-4000-8000-000000000001]

### Backlog
`,
    'utf-8'
  )
  writeFileSync(
    join(w31Dir, `${PRIOR_DATE}.md`),
    `---
date: ${PRIOR_DATE}
day: Thursday
type: daily
---

## Tasks

- [ ] 09:00-09:30 ${CARRY_MEETING_CHECKBOX} #meeting [gid:: 20000000-0000-4000-8000-000000000001]
- 10:00-10:30 ${CARRY_MEETING_BULLET} #meeting [gid:: 20000000-0000-4000-8000-000000000002]
- [ ] ${CARRY_TODO} [gid:: 20000000-0000-4000-8000-000000000003]

### Backlog
`,
    'utf-8'
  )

  // Prev week (W30) note drives the weekly plan wizard carry-over suggestions.
  const w30Dir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '30')
  mkdirSync(w30Dir, { recursive: true })
  writeFileSync(
    join(w30Dir, `${PREV_WEEK_DAY}.md`),
    `---
date: ${PREV_WEEK_DAY}
day: Monday
type: daily
---

## Tasks

- [ ] ${WEEK_TODO} [gid:: 30000000-0000-4000-8000-000000000001]
- ${WEEK_IDEA_BULLET} [gid:: 30000000-0000-4000-8000-000000000002]
- 11:00-11:30 ${WEEK_MEETING_BULLET} #meeting [gid:: 30000000-0000-4000-8000-000000000003]

### Backlog
`,
    'utf-8'
  )

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
  await page.waitForSelector('#root', { timeout: 30_000 })
})

test.afterAll(async () => {
  await electronApp?.close()
})

test('daily carry suggestions from the prior note exclude #meeting lines', async () => {
  await expect(page.getByTestId('daily-notes-panel')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('carry-section')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('carry-section-head')).toContainText('From yesterday')
  await expect(page.getByTestId('carry-section-head')).toContainText('1 suggestion')

  await expect(page.getByTestId('carry-suggestion-item').filter({ hasText: CARRY_TODO })).toBeVisible()
  await page.screenshot({ path: join(artifactsDir, 'bug-meeting-tag-daily-carry.png') })

  await expect(
    page.getByTestId('carry-suggestion-item').filter({ hasText: CARRY_MEETING_CHECKBOX })
  ).toHaveCount(0)
  await expect(
    page.getByTestId('carry-suggestion-item').filter({ hasText: CARRY_MEETING_BULLET })
  ).toHaveCount(0)
  await expect(page.getByTestId('carry-suggestion-item')).toHaveCount(1)
})

test('weekly plan wizard carry-over suggestions exclude #meeting lines', async () => {
  const suggestions = await page.evaluate(async () => {
    const ctx = await window.atelier.loadWeeklyPlanContext()
    return {
      carry: ctx.carrySuggestions.map((c) => c.text),
      open: ctx.lastWeekOpen.map((l) => l.text)
    }
  })

  expect(suggestions.open).toContain(WEEK_TODO)
  expect(suggestions.carry).toContain(WEEK_IDEA_BULLET)
  expect(suggestions.carry.join('\n')).not.toContain(WEEK_MEETING_BULLET)
  expect(suggestions.open.join('\n')).not.toContain(WEEK_MEETING_BULLET)

  await page.evaluate(async () => {
    const status = await window.atelier.getWeeklyPlanStatus()
    await window.atelier.clearWeeklyPlanDraft(status.isoWeek)
  })
  await expect(page.getByTestId('weekly-plan-create-button')).toBeVisible({ timeout: 15_000 })
  await page.getByTestId('weekly-plan-create-button').click()
  await expect(page.getByTestId('weekly-plan-panel')).toBeVisible({ timeout: 10_000 })
  for (let i = 0; i < 5; i++) await page.getByTestId('weekly-plan-next').click()

  const carry = page.locator('.wp-carry')
  await expect(carry.getByText(WEEK_IDEA_BULLET)).toBeVisible()
  await page.screenshot({ path: join(artifactsDir, 'bug-meeting-tag-weekly-carry.png') })
  await expect(carry.getByText(WEEK_MEETING_BULLET)).toHaveCount(0)

  await page.getByTestId('weekly-plan-close').click()
})
