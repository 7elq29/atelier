/**
 * Command palette "New Task" with no time phrase must land in Unscheduled,
 * not on the agenda with a default clock.
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

const DAILY_NOTE_CONTENT = `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

### ⚪ Backlog

### 🤝 Delegated
-
`

async function openCommandPalette(page: Page): Promise<void> {
  // Palette shortcut is Opt/Alt+X (Cmd+K was removed).
  await page.keyboard.press('Alt+x')
  await expect(page.getByTestId('command-palette')).toBeVisible({ timeout: 5_000 })
}

test.describe('bug-palette-new-task-unscheduled', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-palette-new-task-'))
    seedE2eConfig(userDataDir)
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-palette-new-task-vault-'))
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

  test('New Task from palette without time goes to Unscheduled', async () => {
    await openCommandPalette(page)
    await page.getByTestId('command-palette-input').fill('New Task')
    await page.getByTestId('command-palette-item').filter({ hasText: 'New Task' }).first().click()
    await expect(page.getByTestId('command-palette')).toHaveCount(0)

    const input = page.locator('[data-testid="agenda-create-input"]')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.click()
    await page.keyboard.type('Buy groceries', { delay: 15 })
    await page.keyboard.press('Enter')
    await expect(input).toBeHidden({ timeout: 5_000 })

    await expect(page.getByTestId('unscheduled-task').filter({ hasText: 'Buy groceries' })).toBeVisible({
      timeout: 8_000,
    })
    await expect(page.locator('[data-testid="agenda-task"]', { hasText: 'Buy groceries' })).toHaveCount(0)

    await page.screenshot({ path: join(artifactsDir, 'bug-palette-new-task-unscheduled.png') })

    await page.waitForTimeout(1200)
    const fileContent = readFileSync(notePath, 'utf-8')
    const line = fileContent.split('\n').find((l) => l.includes('Buy groceries'))
    expect(line, `expected unscheduled backlog line, got: ${line}`).toBeTruthy()
    expect(line).not.toMatch(/\d{1,2}:\d{2}/)
  })
})
