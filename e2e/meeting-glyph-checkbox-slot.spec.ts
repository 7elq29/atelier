/**
 * #meeting rows show the people glyph in the checkbox column (no #meeting chip).
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
const GID = 'a1111111-1111-4111-8111-111111111112'

const DAILY_NOTE_CONTENT = `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

- 15:00-15:30 Qingqin / Chen #meeting [gid:: ${GID}]
- [ ] 16:00-16:30 test [gid:: a1111111-1111-4111-8111-111111111113]

### ⚪ Backlog

### 🤝 Delegated
-
`

test.describe('meeting-glyph-checkbox-slot', () => {
  let electronApp: ElectronApplication
  let page: Page
  let userDataDir: string
  let vaultRoot: string
  let notePath: string

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-meeting-glyph-'))
    seedE2eConfig(userDataDir)
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-meeting-glyph-vault-'))
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

  test('agenda meeting row: glyph in checkbox slot, no #meeting chip', async () => {
    const meeting = page.locator('[data-testid="agenda-task"]', { hasText: 'Qingqin / Chen' })
    await expect(meeting).toBeVisible({ timeout: 8_000 })
    await expect(meeting.getByTestId('agenda-meeting-glyph')).toBeVisible()
    await expect(meeting.getByTestId('agenda-task-toggle')).toHaveCount(0)
    await expect(meeting.getByTestId('task-tag-chip').filter({ hasText: '#meeting' })).toHaveCount(0)

    const todo = page.locator('[data-testid="agenda-task"]', { hasText: 'test' })
    await expect(todo.getByTestId('agenda-task-toggle')).toBeVisible()
    await expect(todo.getByTestId('agenda-meeting-glyph')).toHaveCount(0)

    await page.screenshot({ path: join(artifactsDir, 'meeting-glyph-checkbox-slot.png') })
  })
})
