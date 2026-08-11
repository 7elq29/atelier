import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'
const TYPED_MARKER = 'daily-note-after-terminal-switch'

let electronApp: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-userdata-'))
  seedE2eConfig(userDataDir)

  const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-vault-'))
  const vaultRoot = join(vaultParent, 'vault')
  const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
  mkdirSync(noteDir, { recursive: true })
  writeFileSync(
    join(noteDir, `${TEST_DATE}.md`),
    `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

### ⚪ Backlog

## 📝 Notes

Seed body.
`,
    'utf-8'
  )

  mkdirSync(artifactsDir, { recursive: true })

  electronApp = await electron.launch({
    args: [mainEntry, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ATELIER_TEST_VAULT_ROOT: vaultRoot,
      ATELIER_TEST_DATE: TEST_DATE
    }
  })
  page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
})

test.afterAll(async () => {
  await electronApp?.close()
})

test.describe('bug: terminal session blocks Daily note after sidebar switch', () => {
  test('open local Terminal then Daily note: terminal cache must not stay active over the editor', async () => {
    await page.getByTestId('open-local-terminal-button').click()
    await expect(page.getByTestId('terminal-only-session')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.terminal-cache-entry.active')).toHaveCount(1)

    await page.getByTestId('daily-note-row').click()
    await expect(page.getByTestId('main-title')).toHaveText('Daily note')
    await expect(page.getByTestId('daily-note-editor-panel')).toBeVisible({ timeout: 10_000 })

    await page.screenshot({
      path: join(artifactsDir, 'bug-terminal-blocks-daily-note-terminal-still-active.png')
    })

    // Bug: activeSessionId stays on the terminal row, so the keep-alive layer
    // must hide when Daily note (or other non-session main panels) is foreground.
    await expect(page.locator('.terminal-cache-entry.active')).toHaveCount(0)

    const editor = page.getByTestId('daily-note-editor')
    await editor.click()
    await page.keyboard.type(TYPED_MARKER)
    await expect(editor.getByText(TYPED_MARKER)).toBeVisible({ timeout: 10_000 })
  })
})
