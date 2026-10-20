/**
 * Duration save on agenda row: click duration → popover → click-outside / pick saves.
 * (Replaces the old dial-card scroll regression.)
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

test.describe('bug-agenda-duration-save', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-dur-save-'))
    seedE2eConfig(userDataDir)
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-dur-save-vault-'))
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

  test('clicking outside duration popover saves the new duration', async () => {
    const agenda = page.locator('[data-testid="timeline-agenda"]')
    await expect(agenda).toBeVisible({ timeout: 5_000 })

    const task = page.locator('[data-testid="agenda-task"]', { hasText: 'Standup' })
    await expect(task).toBeVisible({ timeout: 5_000 })

    await task.locator('.dn-agenda-duration--editable').click()
    const pop = page.locator('[data-testid="nl-duration-popover"]')
    await expect(pop).toBeVisible({ timeout: 3_000 })
    await page.screenshot({ path: join(artifactsDir, 'bug-agenda-duration-save-1-card-open.png') })

    await pop.getByRole('button', { name: '45 min' }).click()
    // Selecting a row commits immediately
    await expect(pop).toBeHidden({ timeout: 3_000 })
    await page.waitForTimeout(1200)

    const fileContent = readFileSync(notePath, 'utf-8')
    await page.screenshot({ path: join(artifactsDir, 'bug-agenda-duration-save-3-after-dismiss.png') })
    expect(fileContent, `note at ${notePath}:\n${fileContent}`).toMatch(/Standup/)
    const taskLine = fileContent.split('\n').find((l) => l.includes('Standup'))
    expect(taskLine).toMatch(/0?9:00-0?9:45/)
  })

  test('Enter on time popover saves start nudge', async () => {
    writeFileSync(notePath, DAILY_NOTE_CONTENT, 'utf-8')
    await page.waitForTimeout(800)

    const task = page.locator('[data-testid="agenda-task"]', { hasText: 'Standup' })
    await expect(task).toBeVisible({ timeout: 5_000 })

    await task.locator('.dn-agenda-time--editable').click()
    const pop = page.locator('[data-testid="nl-time-popover"]')
    await expect(pop).toBeVisible({ timeout: 3_000 })
    await pop.getByRole('button', { name: '+15' }).click()
    await page.keyboard.press('Enter')
    await expect(pop).toBeHidden({ timeout: 3_000 })
    await page.waitForTimeout(1200)

    const fileContent = readFileSync(notePath, 'utf-8')
    const taskLine = fileContent.split('\n').find((l) => l.includes('Standup'))
    expect(taskLine).toMatch(/0?9:15-0?9:45/)
  })
})
