/**
 * Agenda NL create / edit: quiet-underline sentence + time/duration popovers.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { resolveNotePath } from '../src/main/daily-note-io'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'
const GID_STANDUP = 'a1111111-1111-4111-8111-111111111111'

const DAILY_NOTE_CONTENT = `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- [ ] 9:00-9:30 Standup [gid:: ${GID_STANDUP}]

### ⚪ Backlog

### 🤝 Delegated
-
`

test.describe('agenda-nl-task-create', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-agenda-nl-'))
    seedE2eConfig(userDataDir)
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-agenda-nl-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    notePath = resolveNotePath(TEST_DATE, vaultRoot)
    mkdirSync(dirname(notePath), { recursive: true })
    writeFileSync(notePath, DAILY_NOTE_CONTENT, 'utf-8')

    electronApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ATELIER_TEST_VAULT_ROOT: vaultRoot, ATELIER_TEST_DATE: TEST_DATE },
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 20_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('NL create: # tag autocomplete Tab applies first suggestion', async () => {
    const agenda = page.locator('[data-testid="timeline-agenda"]')
    await expect(agenda).toBeVisible({ timeout: 8_000 })

    const box = await agenda.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + 80, { button: 'right' })

    const input = page.locator('[data-testid="agenda-create-input"]')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.click()
    await page.keyboard.type('Sync #meet', { delay: 15 })
    await expect(page.getByTestId('inline-tag-suggestions')).toBeVisible({ timeout: 3_000 })
    await expect(page.getByTestId('inline-tag-suggestion').filter({ hasText: '#meeting' })).toBeVisible()
    await page.screenshot({ path: join(artifactsDir, 'agenda-nl-tag-autocomplete.png') })
    await page.keyboard.press('Tab')
    await expect(input.locator('textarea')).toHaveValue('Sync #meeting ')
    await page.keyboard.press('Escape')
    await expect(input).toBeHidden({ timeout: 3_000 })
  })

  test('NL create: sentence with tag, time, duration creates scheduled task', async () => {
    const agenda = page.locator('[data-testid="timeline-agenda"]')
    await expect(agenda).toBeVisible({ timeout: 8_000 })

    const box = await agenda.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + 80, { button: 'right' })

    const input = page.locator('[data-testid="agenda-create-input"]')
    await expect(input).toBeVisible({ timeout: 5_000 })

    await input.click()
    const ta = input.locator('textarea.dn-nl-textarea')
    await expect(ta).toBeFocused()
    // Transparent overlay text + keyword `color: transparent` can hide the caret in
    // Chromium unless caret-color is an opaque color (bug-daily-note-nl-caret).
    const caretColor = await ta.evaluate((el) => getComputedStyle(el).caretColor)
    expect(caretColor, `caret must be visible, got ${caretColor}`).not.toMatch(/transparent|rgba\(0,\s*0,\s*0,\s*0\)/)
    await page.keyboard.type('Logging Team Sync #meeting at 10:00 am for 1 h', { delay: 15 })
    await page.screenshot({ path: join(artifactsDir, 'agenda-nl-create-typed.png') })

    await expect(input.locator('.dn-nl-entity--tag')).toBeVisible()
    await expect(input.locator('.dn-nl-entity--time')).toBeVisible()
    await expect(input.locator('.dn-nl-entity--duration')).toBeVisible()

    await page.keyboard.press('Enter')
    await expect(input).toBeHidden({ timeout: 5_000 })

    await expect(page.locator('[data-testid="agenda-task"]', { hasText: 'Logging Team Sync' })).toBeVisible({
      timeout: 8_000,
    })
    await page.waitForTimeout(1200)
    const fileContent = readFileSync(notePath, 'utf-8')
    expect(fileContent).toMatch(/10:00-11:00/)
    expect(fileContent).toMatch(/Logging Team Sync/)
    expect(fileContent.toLowerCase()).toMatch(/meeting/)
    await page.screenshot({ path: join(artifactsDir, 'agenda-nl-create-done.png') })
  })

  test('duration popover: pick saves new duration', async () => {
    writeFileSync(notePath, DAILY_NOTE_CONTENT, 'utf-8')
    await page.waitForTimeout(800)
    const task = page.locator('[data-testid="agenda-task"]', { hasText: 'Standup' })
    await expect(task).toBeVisible({ timeout: 8_000 })

    await task.locator('.dn-agenda-duration--editable').click()
    const pop = page.locator('[data-testid="nl-duration-popover"]')
    await expect(pop).toBeVisible({ timeout: 3_000 })
    await page.screenshot({ path: join(artifactsDir, 'agenda-nl-duration-pop.png') })

    await pop.getByRole('button', { name: '1 hour' }).click()
    await expect(pop).toBeHidden({ timeout: 3_000 })

    await page.waitForTimeout(1200)
    const fileContent = readFileSync(notePath, 'utf-8')
    const line = fileContent.split('\n').find((l) => l.includes('Standup'))
    expect(line, `Standup line should be 9:00-10:00, got: ${line}`).toMatch(/0?9:00-10:00/)
  })

  test('time popover: nudge start and commit', async () => {
    writeFileSync(notePath, DAILY_NOTE_CONTENT, 'utf-8')
    await page.waitForTimeout(800)
    const task = page.locator('[data-testid="agenda-task"]', { hasText: 'Standup' })
    await expect(task).toBeVisible({ timeout: 8_000 })

    await task.locator('.dn-agenda-time--editable').click()
    const pop = page.locator('[data-testid="nl-time-popover"]')
    await expect(pop).toBeVisible({ timeout: 3_000 })
    await page.screenshot({ path: join(artifactsDir, 'agenda-nl-time-pop.png') })

    await pop.getByRole('button', { name: '+15' }).click()
    await page.keyboard.press('Enter')
    await expect(pop).toBeHidden({ timeout: 3_000 })

    await page.waitForTimeout(1200)
    const fileContent = readFileSync(notePath, 'utf-8')
    const line = fileContent.split('\n').find((l) => l.includes('Standup'))
    // This test reseeds 9:00-9:30; +15 start keeps 30m duration → 9:15-9:45
    expect(line).toMatch(/0?9:15-0?9:45/)
  })
})
