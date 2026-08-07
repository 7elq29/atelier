import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { seedE2eConfig } from './e2e-config'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const artifactsDir = join(__dirname, '..', 'e2e-artifacts')
const TEST_DATE = '2026-07-31'
const UNIQUE_LINE = 'Gardenia daily notes slice e2e marker'
const EXTERNAL_NOTES_LINE = 'Edited from Obsidian in ## Notes'

function fixtureWithNotesBody(notesBody: string): string {
  return `---
date: ${TEST_DATE}
day: Friday
type: daily
---

## 📋 Tasks

### ⚪ Backlog

### 🤝 Delegated
-

> [!invisible] Trackers

## Notes

${notesBody}
`
}

let electronApp: ElectronApplication
let page: Page
let userDataDir: string
let notePath: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'atelier-e2e-userdata-'))
  seedE2eConfig(userDataDir)

  const vaultParent = mkdtempSync(join(tmpdir(), 'atelier-e2e-vault-'))
  const vaultRoot = join(vaultParent, 'vault')
  const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
  mkdirSync(noteDir, { recursive: true })
  notePath = join(noteDir, `${TEST_DATE}.md`)
  writeFileSync(notePath, fixtureWithNotesBody('Seed body before edit.'), 'utf-8')

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

test.describe('Daily note Notes slice editor (sidebar main panel)', () => {
  test('opens from sidebar, edits ## Notes body, persists to vault file', async () => {
    await page.getByTestId('daily-note-row').click()
    await expect(page.getByTestId('main-title')).toHaveText('Daily note')
    await expect(page.getByTestId('daily-note-editor-panel')).toBeVisible({ timeout: 10_000 })

    const editor = page.getByTestId('daily-note-editor')
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.press('End')
    await page.keyboard.type(`\n\n${UNIQUE_LINE}`)

    await expect
      .poll(() => readFileSync(notePath, 'utf-8'), { timeout: 15_000 })
      .toContain(UNIQUE_LINE)

    await expect(readFileSync(notePath, 'utf-8')).toMatch(/## Notes[\s\S]*Seed body before edit/)
    await expect(page.getByTestId('daily-note-sync-chip')).toContainText(/Synced|Saving/, { timeout: 10_000 })

    await page.screenshot({ path: join(artifactsDir, 'daily-note-notes-editor-slice.png') })
  })

  test('external vault edit to ## Notes propagates into the Atomic editor', async () => {
    writeFileSync(notePath, fixtureWithNotesBody('Seed body before edit.'), 'utf-8')

    await page.getByTestId('daily-note-row').click()
    await expect(page.getByTestId('daily-note-editor')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('daily-note-editor').getByText('Seed body before edit.')).toBeVisible()

    const tmpPath = `${notePath}.obsidian-tmp`
    writeFileSync(tmpPath, fixtureWithNotesBody(EXTERNAL_NOTES_LINE), 'utf-8')
    renameSync(tmpPath, notePath)

    await expect(page.getByTestId('daily-note-editor').getByText(EXTERNAL_NOTES_LINE)).toBeVisible({
      timeout: 15_000
    })
    await expect(page.getByTestId('daily-note-sync-chip')).toHaveText('Updated from vault', { timeout: 10_000 })

    await page.screenshot({ path: join(artifactsDir, 'daily-note-notes-editor-external-sync.png') })
  })
})
