/**
 * Agenda row hover: delete × must not cover the editable duration label.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig, seedSkipOnboarding } from './e2e-config'
import { resolveNotePath } from '../src/main/daily-note-io'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'
const GID = 'a1111111-1111-4111-8111-111111111111'

const DAILY_NOTE_CONTENT = `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- 11:30-12:00 Chen 1:1 #meeting [gid:: ${GID}]

### ⚪ Backlog

### 🤝 Delegated
-
`

function boxesOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
}

test.describe('bug-agenda-delete-duration-overlap', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-agenda-del-overlap-'))
    seedE2eConfig(userDataDir)
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-agenda-del-overlap-vault-'))
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

  test('hovering agenda task: delete × does not overlap duration', async () => {
    const task = page.locator('[data-testid="agenda-task"]', { hasText: 'Chen 1:1' })
    await expect(task).toBeVisible({ timeout: 8_000 })

    await task.hover()
    const del = task.getByTestId('agenda-task-delete')
    const dur = task.locator('.dn-agenda-duration--editable')
    await expect(del).toBeVisible()
    await expect(dur).toBeVisible()

    await page.screenshot({ path: join(artifactsDir, 'bug-agenda-delete-duration-overlap.png') })

    const delBox = await del.boundingBox()
    const durBox = await dur.boundingBox()
    expect(delBox, 'delete button box').toBeTruthy()
    expect(durBox, 'duration box').toBeTruthy()
    expect(
      boxesOverlap(delBox!, durBox!),
      `delete ${JSON.stringify(delBox)} overlaps duration ${JSON.stringify(durBox)}`
    ).toBe(false)

    // Duration remains clickable (not covered)
    await dur.click()
    await expect(page.locator('[data-testid="nl-duration-popover"]')).toBeVisible({ timeout: 3_000 })
  })
})
