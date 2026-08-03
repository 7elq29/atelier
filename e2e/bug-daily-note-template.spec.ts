import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Repro + fix confirmation for "fix-daily-note-template".
 *
 * Root cause: `generateNewNote` (src/main/daily-note-io.ts) hardcodes its own
 * note skeleton and never reads the vault's actual
 * `92.templates/Daily Note Template.md` — so a freshly-created note's
 * structure silently diverges from the real template (missing "Daily Big
 * Three", "Retro (Yesterday)", "Claude Log", and "Notes" sections; wrong
 * section order/emoji). This spec seeds a real template file into the
 * fixture vault (mirroring `~/Documents/Default/92.templates/Daily Note
 * Template.md`) and asserts a newly created note's structure comes from it.
 */

const mainEntry = join(__dirname, '..', 'out', 'main', 'index.js')
const TEST_DATE = '2026-07-29'

const REAL_TEMPLATE = `---
date: {{date:YYYY-MM-DD}}
week: {{date:gggg}}-W{{date:WW}}
day: {{date:dddd}}
type: daily
---

## \u{1F5D3}\u{FE0F} Daily  Big Three
*

## \u{1F4CB} Tasks


### ⚪ Backlog
-

### \u{1F91D} Delegated
-

## \u{1F501} Retro (Yesterday)
> [!summary]- Retro
> - **Shipped:**
> - **Friction:**
> - **Today's edge:**

## \u{1F916} Claude Log

## \u{1F4DD} Notes


> [!invisible] Trackers
> - [ ] Exercise #tracker  [scheduled:: {{date:YYYY-MM-DD}}]
`

function seedSkipOnboarding(userDataDir: string): void {
  mkdirSync(join(userDataDir, 'data'), { recursive: true })
  writeFileSync(join(userDataDir, 'data', 'config.json'), JSON.stringify({ onboardingCompleted: true }))
}

test.describe('fix-confirmed: daily note creation uses the real vault template', () => {
  let electronApp: ElectronApplication
  let page: Page
  let vaultRoot: string
  let newNotePath: string

  test.beforeAll(async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'gardenia-e2e-dn-template-'))
    seedSkipOnboarding(userDataDir)

    const vaultParent = mkdtempSync(join(tmpdir(), 'gardenia-e2e-dn-template-vault-'))
    vaultRoot = join(vaultParent, 'vault')
    mkdirSync(join(vaultRoot, '92.templates'), { recursive: true })
    writeFileSync(join(vaultRoot, '92.templates', 'Daily Note Template.md'), REAL_TEMPLATE, 'utf-8')

    const noteDir = join(vaultRoot, '01.dailynotes', '2026', 'Jul', '31')
    mkdirSync(noteDir, { recursive: true })
    newNotePath = join(noteDir, `${TEST_DATE}.md`)
    // TEST_DATE's note is deliberately NOT created yet.

    electronApp = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, GARDENIA_TEST_VAULT_ROOT: vaultRoot, GARDENIA_TEST_DATE: TEST_DATE }
    })
    page = await electronApp.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible({ timeout: 10_000 })
  })

  test.afterAll(async () => {
    await electronApp.close().catch(() => undefined)
  })

  test('creating a not-yet-existing note scaffolds it from the vault\'s real template file', async () => {
    const createButton = page.locator('[data-testid="create-daily-note"]')
    await expect(createButton).toBeVisible()
    await createButton.click()

    await expect(page.locator('[data-testid="daily-notes-panel"]')).toBeVisible()

    const content = readFileSync(newNotePath, 'utf-8')

    // Sections unique to the real template that the old hardcoded skeleton
    // never emitted at all.
    expect(content).toContain('Daily  Big Three')
    expect(content).toContain('Retro (Yesterday)')
    expect(content).toContain('Claude Log')
    expect(content).toMatch(/^##\s+.*Notes/m)

    // Frontmatter placeholders substituted with the real date, not left as
    // literal `{{date:...}}` tokens.
    expect(content).toContain(`date: ${TEST_DATE}`)
    expect(content).toContain('day: Wednesday')
    expect(content).toMatch(/week: \d{4}-W\d{2}/)
    expect(content).not.toContain('{{date:')

    // Still parses/renders as a normal Tasks section in the UI (existing
    // Tasks/Backlog/Delegated contract must keep working).
    const tasksHeaderIdx = content.split('\n').findIndex((l) => /^##\s+.*Tasks/i.test(l))
    const backlogHeaderIdx = content.split('\n').findIndex((l) => /^###\s+.*Backlog/i.test(l))
    expect(tasksHeaderIdx).toBeGreaterThanOrEqual(0)
    expect(backlogHeaderIdx).toBeGreaterThan(tasksHeaderIdx)
  })
})
