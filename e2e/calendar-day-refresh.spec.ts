import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedE2eConfig } from './e2e-config'

const projectRoot = join(__dirname, '..')
const artifactsDir = join(projectRoot, 'e2e-artifacts')
const SUNDAY = '2026-09-13'
const MONDAY = '2026-09-14'
const SUNDAY_WEEK = '2026-W37'
const MONDAY_WEEK = '2026-W38'

let electronApp: ElectronApplication
let page: Page
let vaultRoot: string

function seedDailyNote(date: string, week: string, day: string, marker: string, gid: string): void {
  const dir = join(vaultRoot, '01.dailynotes', '2026', 'Sep', week)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${date}.md`),
    `---
date: ${date}
day: ${day}
type: daily
---

## 📋 Tasks

- [ ] 09:00–09:30 ${marker} [gid:: ${gid}]

### ⚪ Backlog

## Notes
`,
    'utf-8'
  )
}

test.beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-calendar-refresh-userdata-'))
  seedE2eConfig(userDataDir)

  vaultRoot = join(mkdtempSync(join(tmpdir(), 'atelier-calendar-refresh-vault-')), 'vault')
  mkdirSync(join(vaultRoot, '02.weeklynotes'), { recursive: true })
  seedDailyNote(SUNDAY, '37', 'Sunday', 'Sunday timeline marker', '11111111-1111-4111-8111-111111111111')
  seedDailyNote(MONDAY, '38', 'Monday', 'Monday timeline marker', '22222222-2222-4222-8222-222222222222')
  writeFileSync(join(vaultRoot, '02.weeklynotes', `${SUNDAY_WEEK}.md`), '# Sunday week\n\nSunday weekly marker\n')
  writeFileSync(join(vaultRoot, '02.weeklynotes', `${MONDAY_WEEK}.md`), '# Monday week\n\nMonday weekly marker\n')

  electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      ATELIER_TEST_VAULT_ROOT: vaultRoot,
      ATELIER_TEST_DATE: SUNDAY
    }
  })
  page = await electronApp.firstWindow()
  await page.waitForSelector('#root', { timeout: 30_000 })
})

test.afterAll(async () => {
  await electronApp?.close()
})

test('open daily surfaces and weekly status follow a calendar-day change', async () => {
  const sidebar = page.getByTestId('daily-notes-panel')
  await expect(sidebar).toContainText(`Daily Notes — ${SUNDAY}`)
  await expect(sidebar.getByTestId('timeline-task')).toContainText('Sunday timeline marker')
  await expect(page.getByTestId('weekly-plan-row')).toContainText('Sep 7 – 13, 2026')

  await page.getByTestId('daily-note-row').click()
  await expect(page.getByTestId('daily-note-date-label')).toContainText('Sun, Sep 13')

  await page.evaluate((date) => window.atelier.debugSetCalendarDate(date), MONDAY)

  await expect(sidebar).toContainText(`Daily Notes — ${MONDAY}`)
  await expect(sidebar.getByTestId('timeline-task')).toContainText('Monday timeline marker')
  await expect(page.getByTestId('daily-note-date-label')).toContainText('Mon, Sep 14')
  await expect(page.getByTestId('weekly-plan-row')).toContainText('Sep 14 – 20, 2026')
  await expect(sidebar.getByTestId('current-time-line')).toBeVisible()

  mkdirSync(artifactsDir, { recursive: true })
  await page.screenshot({
    path: join(artifactsDir, 'calendar-day-refresh-after-rollover.png'),
    fullPage: true
  })

  const logPath = await page.evaluate(() => window.atelier.getLogFilePath())
  const entries = readFileSync(logPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { msg?: string; from?: string; to?: string })
  expect(entries).toContainEqual(expect.objectContaining({
    msg: 'calendar day changed',
    from: SUNDAY,
    to: MONDAY
  }))
})

test('an open weekly view reloads for the new ISO week', async () => {
  await page.evaluate((date) => window.atelier.debugSetCalendarDate(date), SUNDAY)
  await expect(page.getByTestId('weekly-plan-row')).toContainText('Sep 7 – 13, 2026')
  await page.getByTestId('weekly-plan-row').click()
  await expect(page.getByTestId('weekly-plan-view-path')).toContainText(`${SUNDAY_WEEK}.md`)
  await expect(page.getByTestId('weekly-plan-view-panel')).toContainText('Sunday timeline marker')

  await page.evaluate((date) => window.atelier.debugSetCalendarDate(date), MONDAY)

  await expect(page.getByTestId('weekly-plan-view-path')).toContainText(`${MONDAY_WEEK}.md`)
  await expect(page.getByTestId('weekly-plan-view-panel')).toContainText('Monday timeline marker')
})
