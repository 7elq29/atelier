/**
 * Visual walkthrough: agenda NL create / edit steps → e2e-artifacts/nl-walk-*.png
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

async function shot(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="daily-notes-panel"]').screenshot({
    path: join(artifactsDir, `nl-walk-${name}.png`),
  })
}

test.describe('agenda-nl-screenshots', () => {
  let electronApp: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-nl-walk-'))
    seedE2eConfig(userDataDir)
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-nl-walk-vault-'))
    const vaultRoot = join(vaultParent, 'vault')
    const notePath = resolveNotePath(TEST_DATE, vaultRoot)
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

  test('capture create + edit walkthrough', async () => {
    const agenda = page.locator('[data-testid="timeline-agenda"]')
    await expect(agenda).toBeVisible({ timeout: 8_000 })
    const standup = page.locator('[data-testid="agenda-task"]', { hasText: 'Standup' })
    await expect(standup).toBeVisible()

    // 1. Default Today agenda
    await shot(page, '01-agenda-today')

    // 2. Right-click → empty NL create card
    const box = await agenda.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + 80, { button: 'right' })
    const input = page.locator('[data-testid="agenda-create-input"]')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await shot(page, '02-create-card-empty')

    // 3. Typed sentence with quiet underlines
    await input.locator('textarea').click()
    await page.keyboard.type('Logging Team Sync #meeting at 10:00 am for 1 h', { delay: 12 })
    await expect(input.locator('.dn-nl-entity--tag')).toBeVisible()
    await expect(input.locator('.dn-nl-entity--time')).toBeVisible()
    await expect(input.locator('.dn-nl-entity--duration')).toBeVisible()
    await shot(page, '03-create-typed-underlines')

    // 4. Commit create
    await page.keyboard.press('Enter')
    await expect(input).toBeHidden({ timeout: 5_000 })
    await expect(page.locator('[data-testid="agenda-task"]', { hasText: 'Logging Team Sync' })).toBeVisible({
      timeout: 8_000,
    })
    await shot(page, '04-agenda-after-create')

    // 5. Fast-path: click row clock → time popover
    await standup.locator('.dn-agenda-time--editable').click()
    await expect(page.locator('[data-testid="nl-time-popover"]')).toBeVisible({ timeout: 3_000 })
    await shot(page, '05-edit-time-popover')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="nl-time-popover"]')).toBeHidden({ timeout: 3_000 })

    // 6. Fast-path: click row duration → duration popover
    await standup.locator('.dn-agenda-duration--editable').click()
    await expect(page.locator('[data-testid="nl-duration-popover"]')).toBeVisible({ timeout: 3_000 })
    await shot(page, '06-edit-duration-popover')
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="nl-duration-popover"]')).toBeHidden({ timeout: 3_000 })

    // 7. Double-click title → full NL sentence edit
    await standup.locator('.dn-agenda-task-main').dblclick()
    await expect(page.locator('[data-testid="agenda-task-nl-edit"]')).toBeVisible({ timeout: 3_000 })
    await shot(page, '07-edit-nl-sentence')
    await page.keyboard.press('Escape')
  })
})
